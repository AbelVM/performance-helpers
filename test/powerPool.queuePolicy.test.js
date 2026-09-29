import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: the queue policies at capacity, and the resize
 * overloads.
 *
 * `_reserveQueueSlots` and `_enqueueOrReject` carry the whole drop/reject
 * contract, and their branches split three ways that are easy to confuse:
 * `drop-oldest` evicts to make room, `drop-newest` refuses the *incoming*
 * task only once something is already queued, and `reject` refuses
 * unconditionally. A simplification that collapses any two of them still looks
 * right in a test that only ever queues one task at a time, which is how a
 * policy that silently refuses everything can pass.
 */

/** A worker that accepts a message and never answers, so tasks stay in flight. */
function Busy() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/**
 * A pool with one busy worker and a bounded queue, so every enqueue goes
 * through the policy rather than straight to a free slot.
 *
 * The worker is occupied by a *real* dispatch rather than by assigning
 * `workers[0].tasks = 1`. That looks equivalent and is not: the fast path in
 * `postMessage` re-reads the count through `_findLeastLoadedWorker()` and
 * dispatches to the least-loaded worker regardless of how the count got there,
 * so a hand-set value never makes the pool look full and the queue never fills
 * — the test then exercises the happy path and asserts nothing about policy.
 */
function saturatedPool(queuePolicy, maxQueueLength = 2) {
  const pool = new PowerPool(Busy, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    taskQueue: true,
    maxTasksPerWorker: 1,
    queuePolicy,
    maxQueueLength,
  });
  // `Busy` never answers, so this task stays in flight and the single worker
  // stays at capacity for everything that follows.
  pool.postMessage({ n: 'occupying' });
  expect(pool.queue.length).toBe(0);
  return pool;
}

describe('PowerPool queue policy at capacity', () => {
  it('drop-oldest is self-bounding at one entry, and that is deliberate', () => {
    const pool = saturatedPool('drop-oldest', 100);
    for (let i = 0; i < 10; i++) pool.postMessage(String(i));
    // The queue never climbs. BUG-016 found this while wiring `maxQueueLength`
    // and accepted it deliberately: `drop-oldest` is already self-bounding, it
    // evicts one and admits one, "so the cap must not - and does not - turn it
    // into a refusal". `test/powerPool.hardening.test.js:96` pins it too.
    //
    // Read that together with `maxQueueLength: 100` and it is easy to conclude
    // the cap is broken. It is not - the policy keeps its meaning, which is to
    // drop rather than refuse - but the *number* was never written down
    // anywhere a caller would look, and a reader who sets 100 and observes one
    // is being misled. `guides/powerPool.md` now says so.
    expect(pool.queue.length).toBe(1);
    expect(pool.queue.toArray().map((q) => q.message)).toEqual(['9']);
  });

  it('drop-oldest evicts the head so the newest work is what runs', () => {
    const pool = saturatedPool('drop-oldest');
    expect(pool.postMessage('a')).toBe(true);
    expect(pool.postMessage('b')).toBe(true);
    // Accepted work is discarded in favour of the newest arrival, which is the
    // whole trade the policy names.
    expect(pool.queue.toArray().map((q) => q.message)).toEqual(['b']);
  });

  it('drop-oldest never refuses, however far past the cap it is pushed', () => {
    const pool = saturatedPool('drop-oldest', 1);
    for (let i = 0; i < 20; i++) expect(pool.postMessage(String(i))).toBe(true);
    // The defining property: evict rather than refuse, so a caller using this
    // policy never sees `false` and never has to handle a rejection.
    expect(pool.queue.length).toBe(1);
    expect(pool.queue.toArray().map((q) => q.message)).toEqual(['19']);
  });

  it('drop-oldest rejects the evicted task when it was awaiting a response', () => {
    const pool = saturatedPool('drop-oldest');
    const first = pool.postMessage({ n: 1 }, undefined, { awaitResponse: true });
    pool.postMessage('b');
    // The evicted entry had a pending response, so its promise must settle -
    // a dropped task whose promise never settles is a caller waiting forever.
    return expect(first).rejects.toThrow(/dropped by policy/);
  });

  it('drop-newest refuses the newcomer and keeps everything already queued', () => {
    const pool = saturatedPool('drop-newest');
    expect(pool.postMessage('n1')).toBe(true);
    const refused = pool.postMessage('n2');
    // The opposite trade from drop-oldest: accepted work is never discarded
    // to make room, so the *incoming* task is the one that gets refused.
    expect(refused).toBe(false);
    expect(pool.queue.toArray().map((q) => q.message)).toEqual(['n1']);
  });

  it('drop-newest accepts into an empty queue', () => {
    const pool = saturatedPool('drop-newest');
    // The `queue.length > 0` arm matters: with nothing queued there is
    // nothing to drop, and the task must be accepted rather than refused.
    expect(pool.postMessage('n1')).toBe(true);
    expect(pool.queue.length).toBe(1);
  });

  it('reject refuses the newcomer even when the queue is empty and has room', () => {
    const pool = saturatedPool('reject');
    const first = pool.postMessage('n1');
    // `reject` is unconditional - the `queue.length > 0` guard the other
    // policies carry is absent - so a pool configured this way never queues
    // anything at all, whatever `maxQueueLength` says. Documented as
    // "rejects new overflow tasks immediately instead of queueing", which is
    // accurate, but the word "overflow" is doing the work.
    expect(first).toBe(false);
    expect(pool.queue.length).toBe(0);
    expect(pool.postMessage('n2')).toBe(false);
  });

  it('reject settles both pending responses rather than leaking either promise', async () => {
    const pool = saturatedPool('reject');
    const first = pool.postMessage({ n: 1 }, undefined, { awaitResponse: true });
    const second = pool.postMessage({ n: 2 }, undefined, { awaitResponse: true });
    // Both are refused - the policy is unconditional - so *both* promises
    // reject. Asserting on only the second leaves the first's rejection
    // unhandled, which fails the whole run as an unhandled error even though
    // every assertion passed. That is the failure mode, not the pool's.
    await expect(first).rejects.toThrow(/rejected by queue policy/);
    await expect(second).rejects.toThrow(/rejected by queue policy/);
  });

  it('enqueue admits everything up to the cap, then refuses the newcomer', () => {
    const pool = saturatedPool('enqueue', 2);
    expect(pool.postMessage('n1')).toBe(true);
    expect(pool.postMessage('n2')).toBe(true);
    expect(pool.postMessage('n3')).toBe(false);
    // The accepted work is kept in full - the refusal falls on the newcomer,
    // which is the whole point of the cap.
    expect(pool.queue.toArray().map((q) => q.message)).toEqual(['n1', 'n2']);
  });

  it('an unbounded queue admits everything, whatever the policy', () => {
    // `_reserveQueueSlots` returns early for a non-finite cap. If that early
    // return were lost, a pool configured for unlimited queueing would start
    // refusing at some arbitrary size.
    const pool = saturatedPool('enqueue', Number.POSITIVE_INFINITY);
    for (let i = 0; i < 50; i++) expect(pool.postMessage(String(i))).toBe(true);
    expect(pool.queue.length).toBe(50);
  });
});

describe('PowerPool resize overloads', () => {
  it('resizes by number, keeping minSize', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 0, maxSize: 4, lazy: true });
    pool.resize(6);
    expect(pool.maxSize).toBe(6);
    expect(pool.minSize).toBe(0);
  });

  it('resizes by object, setting both bounds', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 0, maxSize: 4, lazy: true });
    pool.resize({ minSize: 2, maxSize: 3 });
    expect(pool.minSize).toBe(2);
    expect(pool.maxSize).toBe(3);
  });

  it('never lets maxSize fall below minSize', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 2, maxSize: 4, lazy: true });
    // Asking for maxSize 1 with minSize 2 is contradictory. The invariant that
    // matters is the one that keeps the grow-loop `workers.length < minSize &&
    // workers.length < maxSize` from being satisfied by an empty range.
    pool.resize({ minSize: 2, maxSize: 1 });
    expect(pool.maxSize).toBeGreaterThanOrEqual(pool.minSize);
  });

  it('ignores non-finite bounds rather than adopting NaN', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 1, maxSize: 4, lazy: true });
    pool.resize({ minSize: Number.NaN, maxSize: Number.POSITIVE_INFINITY });
    // A `NaN` bound would make every later comparison false - the same shape
    // of bug BUG-024 found in the cache, one layer up.
    expect(Number.isNaN(pool.minSize)).toBe(false);
    expect(Number.isNaN(pool.maxSize)).toBe(false);
    expect(pool.minSize).toBe(1);
  });

  it('ignores a non-numeric numeric shorthand', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 1, maxSize: 4, lazy: true });
    pool.resize('nonsense');
    expect(pool.maxSize).toBe(4);
  });

  it('rounds a fractional size down to a whole worker count', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 0, maxSize: 4, lazy: true });
    pool.resize(3.9);
    expect(pool.maxSize).toBe(3);
  });
});

describe('PowerPool _decrementActiveTasks normalisation', () => {
  it('floors a fractional count and clamps at zero', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 1, maxSize: 1, lazy: false });
    pool._activeTasks = 5;
    pool._decrementActiveTasks(2.7);
    expect(pool._activeTasks).toBe(3);
    pool._decrementActiveTasks(99);
    expect(pool._activeTasks).toBe(0);
  });

  it('defaults a non-numeric count to one', () => {
    const pool = new PowerPool(Busy, { size: 1, minSize: 1, maxSize: 1, lazy: false });
    pool._activeTasks = 3;
    // `Number.isFinite(Number(n))` is false for 'nonsense', and the fallback is
    // 1 - not 0, and not NaN, either of which would freeze the pool's
    // accounting permanently.
    pool._decrementActiveTasks('nonsense');
    expect(pool._activeTasks).toBe(2);
  });
});

describe('PowerPool option parsing fallbacks', () => {
  it('accepts autoScale as an empty object without losing the defaults', () => {
    const pool = new PowerPool(Busy, {
      size: 1,
      minSize: 1,
      maxSize: 4,
      lazy: false,
      autoScale: {},
    });
    expect(pool._autoScale).toBeTruthy();
    expect(pool._autoScale.intervalMs).toBeGreaterThan(0);
  });

  it('ignores a non-numeric debugLevel rather than enabling verbose logging', () => {
    const pool = new PowerPool(Busy, {
      size: 0,
      minSize: 0,
      maxSize: 1,
      lazy: true,
      debugLevel: 'loud',
    });
    // The ternary is `typeof === 'number' ? debugLevel : 1`. Adopting the
    // string would put `'loud'` in a numeric field, where every later
    // comparison is false - the NaN-shaped bug again.
    expect(typeof pool._debugLevel === 'number' || pool._debugLevel === undefined).toBe(true);
  });

  it('ignores non-finite slowTaskThreshold, disabling slow-task counting', () => {
    const pool = new PowerPool(Busy, {
      size: 0,
      minSize: 0,
      maxSize: 1,
      lazy: true,
      slowTaskThreshold: 'soon',
    });
    // `Infinity` is the documented "no slow-task signal" value and is a legal
    // result - what must not happen is `Number('soon')` becoming `NaN`, which
    // would make every task comparison false forever.
    expect(pool._slowTaskThreshold).toBe(Infinity);
  });

  it('adopts a finite slowTaskThreshold', () => {
    const pool = new PowerPool(Busy, {
      size: 0,
      minSize: 0,
      maxSize: 1,
      lazy: true,
      slowTaskThreshold: 250,
    });
    expect(pool._slowTaskThreshold).toBe(250);
  });
});
