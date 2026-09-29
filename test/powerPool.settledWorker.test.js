import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * BUG-011: a late `message` from a terminated worker must not decrement the
 * global active-task counter a second time.
 *
 * The hazard: `_terminateWorker` settles a worker's in-flight tasks in bulk,
 * and a `message` already in flight from that worker still reaches the pool
 * handler afterwards. The old `Math.max(0, …)` clamp on `workerObj.tasks`
 * could not prevent it — that clamp guarded the *per-worker* count, while the
 * thing being double-decremented was the *global* `_activeTasks`. The count
 * then fell below the number of tasks actually running, so `activeTasks`
 * under-reported, `_isIdle` could go true with work outstanding, and `drain()`
 * resolved early against a pool that was not idle.
 *
 * **The counter is only wrong when it is above zero.** The clamp means a double
 * decrement against a counter that already reads `0` is invisible — it stays
 * `0`. So a single-worker test passes against the broken code, and these use
 * two: the late message has to be made to steal a count that belongs to a
 * *different, still-working* worker. That is the user-visible failure, and it
 * is why an earlier draft of this file asserted nothing.
 */

/** A Worker stand-in whose `onmessage` can be driven by hand. */
function makeUnderlying() {
  return { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
}

/** A pool over fakes. The pool creates its workers eagerly in the constructor. */
function makePool(options = {}) {
  return new PowerPool(makeUnderlying, { size: 2, idleTimeout: 0, ...options });
}

/** Worker `i` and its bookkeeping record. */
function workerAt(pool, i = 0) {
  const workerObj = pool.workers[i];
  return { worker: workerObj.worker, workerObj };
}

describe('BUG-011 late message after termination', () => {
  it('gives two workers, because a single one cannot see the bug', () => {
    const pool = makePool();
    expect(pool.workers.length).toBeGreaterThanOrEqual(2);
    pool.dispose();
  });

  it('does not steal another live worker count when a settled worker reports back', () => {
    // The core case, and the one a one-worker test provably cannot see.
    const pool = makePool();
    const doomed = workerAt(pool, 0);
    const healthy = workerAt(pool, 1);

    doomed.workerObj.tasks = 2;
    healthy.workerObj.tasks = 3;
    pool._activeTasks = 5;

    // The doomed worker goes away with two tasks still in flight. The drain is
    // correct: both of its tasks really are gone.
    pool._terminateWorker(doomed.workerObj, 'test');
    expect(pool._activeTasks).toBe(3);
    expect(doomed.workerObj.tasksSettled).toBe(true);

    // A message from it was already in flight. It must not decrement again -
    // the three it would steal belong to `healthy`, which is still working.
    doomed.worker.onmessage({ data: { type: 'done' } });
    expect(pool._activeTasks).toBe(3);

    // Nor may a second late message.
    doomed.worker.onmessage({ data: { type: 'done' } });
    expect(pool._activeTasks).toBe(3);

    // And the healthy worker's own accounting is unaffected.
    expect(healthy.workerObj.tasks).toBe(3);
    healthy.worker.onmessage({ data: { type: 'done' } });
    expect(pool._activeTasks).toBe(2);
    expect(healthy.workerObj.tasks).toBe(2);

    pool.dispose();
  });

  it('leaves a live worker accounting normally', () => {
    // The guard must not fire for a worker that was never settled, or every
    // completion in the pool would be ignored.
    const pool = makePool();
    const { worker, workerObj } = workerAt(pool, 0);

    workerObj.tasks = 3;
    pool._activeTasks = 3;
    expect(workerObj.tasksSettled).toBe(false);

    worker.onmessage({ data: { type: 'done' } });
    worker.onmessage({ data: { type: 'done' } });
    expect(pool._activeTasks).toBe(1);
    expect(workerObj.tasks).toBe(1);

    pool.dispose();
  });

  it('keeps a partial count correct when one message lands before termination', () => {
    const pool = makePool();
    const { worker, workerObj } = workerAt(pool, 0);

    workerObj.tasks = 3;
    pool._activeTasks = 3;

    // One completes normally first.
    worker.onmessage({ data: { type: 'done' } });
    expect(workerObj.tasks).toBe(2);
    expect(pool._activeTasks).toBe(2);

    // Then the worker is terminated with two still in flight, and both arrive
    // late. With a second worker also busy, those two would otherwise steal its
    // count.
    const other = workerAt(pool, 1);
    other.workerObj.tasks = 4;
    pool._activeTasks = 6;

    pool._terminateWorker(workerObj, 'test');
    expect(pool._activeTasks).toBe(4);
    worker.onmessage({ data: { type: 'done' } });
    worker.onmessage({ data: { type: 'done' } });
    expect(pool._activeTasks).toBe(4);
    expect(workerObj.tasks).toBe(0);
    expect(other.workerObj.tasks).toBe(4);

    pool.dispose();
  });

  it('reports activeTasks from getStats, not a number a late message skewed', () => {
    const pool = makePool();
    const { worker, workerObj } = workerAt(pool, 0);
    const other = workerAt(pool, 1);

    workerObj.tasks = 1;
    other.workerObj.tasks = 2;
    pool._activeTasks = 3;
    pool._terminateWorker(workerObj, 'test');
    worker.onmessage({ data: { type: 'done' } });

    // The user-visible symptom: `activeTasks` under-reports, and with it
    // `_isIdle` and `drain()` - the pool would claim to be finished with work
    // still running.
    expect(pool.getStats().activeTasks).toBe(2);
    pool.dispose();
  });

  it('does not throw on a late message carrying a correlationId', () => {
    // The guard returns before the correlation handling, so a caller awaiting a
    // response from a worker that was terminated late would wait forever. That
    // is a **known gap rather than a fixed one** - `_terminateWorker` does not
    // reject the promises of the tasks it settles - and this test records the
    // behaviour so it is pinned rather than assumed. BUG-011 asked for
    // idempotent *accounting*; promise settlement on termination is separate.
    const pool = makePool();
    const { worker, workerObj } = workerAt(pool, 0);

    workerObj.tasks = 1;
    pool._activeTasks = 1;
    pool._terminateWorker(workerObj, 'test');

    expect(() => worker.onmessage({ data: { correlationId: 'nope' } })).not.toThrow();
    expect(pool._activeTasks).toBe(0);
    pool.dispose();
  });
});
