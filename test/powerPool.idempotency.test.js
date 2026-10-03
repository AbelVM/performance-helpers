/**
 * POOL-013 — the idempotency ledger on the message path.
 *
 * `ALGO-006` defers request hedging because it "needs an idempotency story", and
 * nothing implemented one. `PowerRetry` retries operations that may already have
 * taken effect, and pool messages are exactly-once only *from the pool's side*:
 * a caller that retries across a timeout will apply its side effect twice, and
 * nothing on the path can tell it not to.
 *
 * **Everything here goes through the real `postMessage`** and asserts on what the
 * public surface returns — `false` for a refused post, and
 * `getStats().idempotency` for the cost. The ledger is a `Map` on the instance,
 * so a test that read `_idempotency` directly would pass on an implementation
 * that never consulted it, which is the shape of assertion that let CACHE-011's
 * two counters sit unreachable for two releases.
 *
 * **The in-flight state is only observable through a re-entrant post**, and that
 * is worth being explicit about. A key is claimed in-flight and settled inside one
 * synchronous `postMessage` call, so no *other* caller on the same thread can see
 * the intermediate state — the window does not exist outside a re-entrant call.
 * The re-entrant worker below is therefore not a contrivance: it is the only way
 * to reach the state the design has, and a test that never reaches it would be
 * asserting that the distinction is untested rather than tested.
 */
import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/index.js';

/**
 * A worker that records what it was handed and never responds.
 *
 * Never responding is deliberate: it keeps `worker.tasks` pinned, which is what
 * lets a test fill the pool deterministically, and it removes the response path
 * from the picture entirely. The ledger's job is decided at dispatch.
 */
class CountingWorker {
  constructor() {
    this._listeners = [];
    /** Every message the pool handed over, in order. */
    this.received = [];
    /** Set to a callback to re-enter the pool from inside `postMessage`. */
    this.onPost = null;
  }
  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }
  removeEventListener() {}
  postMessage(msg) {
    this.received.push(msg);
    if (this.onPost) this.onPost(msg);
  }
  terminate() {}
}

/** A pool of one worker that never completes a task, plus that worker. */
function makePool(options = {}) {
  const worker = new CountingWorker();
  const pool = new PowerPool(() => worker, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    awaitResponseTimeout: 0,
    idempotencyTtlMs: 60_000,
    ...options,
  });
  return { pool, worker };
}

describe('PowerPool idempotency: off by default, and free', () => {
  it('costs nothing on a pool that never opted in', () => {
    // The row's counter to assert: lookups per post, **zero when off**. Not merely
    // "no duplicates were caught" — a pool that consulted an empty ledger would
    // also catch nothing, and would still be charging a lookup per post.
    const { pool, worker } = makePool({ idempotencyTtlMs: undefined });
    pool.postMessage({ task: 'a' });
    pool.postMessage({ task: 'b' });
    const stats = pool.getStats().idempotency;
    expect(stats.enabled).toBe(false);
    expect(stats.lookups).toBe(0);
    expect(stats.size).toBe(0);
    expect(worker.received).toHaveLength(2);
    pool.shutdown();
  });

  it('is inert on a pool that did not opt in, so a stray key is not a feature', () => {
    // `idempotencyKey` without `idempotencyTtlMs` must not start refusing posts.
    // If it did, adding the key to a call site would change behaviour on a pool
    // whose configuration nobody touched.
    const { pool, worker } = makePool({ idempotencyTtlMs: undefined });
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'k' })).toBe(true);
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'k' })).toBe(true);
    expect(worker.received).toHaveLength(2);
    pool.shutdown();
  });

  it('rejects an unknown option rather than ignoring it', () => {
    // The whitelist is the reason `idempotencyTtl` (no `Ms`) cannot silently
    // disable the feature the caller asked for.
    expect(() => new PowerPool(() => new CountingWorker(), { idempotencyTtl: 1000 })).toThrow(
      /idempotencyTtl/
    );
  });
});

describe('PowerPool idempotency: the cost, measured', () => {
  it('charges one lookup per posted message, keyed or not', () => {
    // Counting only keyed posts would make the feature look free for the traffic
    // that passes a pool but no keys — which is most of it. The cost is a Map
    // lookup per post, so that is what has to be visible.
    const { pool } = makePool();
    pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'k1' });
    pool.postMessage({ task: 'b' }, undefined, { idempotencyKey: 'k2' });
    pool.postMessage({ task: 'c' });
    expect(pool.getStats().idempotency.lookups).toBe(3);
    pool.shutdown();
  });

  it('reports what it caught, separating the two ways a key can be taken', () => {
    const { pool } = makePool();
    pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'same' });
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'same' })).toBe(false);
    const stats = pool.getStats().idempotency;
    expect(stats.duplicatesSettled).toBe(1);
    expect(stats.duplicatesInFlight).toBe(0);
    pool.shutdown();
  });
});

describe('PowerPool idempotency: a task is dispatched once', () => {
  it('refuses a repeated key and the worker sees one message', () => {
    // The actual claim. `false` is the pool's existing "refused" answer, so this
    // needs no new return shape — and a caller retrying across a timeout gets a
    // boolean it already knows how to read.
    const { pool, worker } = makePool();
    expect(pool.postMessage({ task: 'charge', n: 1 }, undefined, { idempotencyKey: 'inv-1' })).toBe(
      true
    );
    expect(pool.postMessage({ task: 'charge', n: 1 }, undefined, { idempotencyKey: 'inv-1' })).toBe(
      false
    );
    expect(worker.received).toHaveLength(1);
    pool.shutdown();
  });

  it('treats distinct keys as distinct tasks', () => {
    // A ledger that refused everything would satisfy the test above.
    const { pool, worker } = makePool();
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'k1' })).toBe(true);
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'k2' })).toBe(true);
    expect(worker.received).toHaveLength(2);
    pool.shutdown();
  });

  it('coerces the key, so a number and its string form are one task', () => {
    // Invoice ids arrive as numbers from a database and as strings from JSON, and
    // treating those as two tasks would apply the charge twice — the exact failure,
    // reached by a different road.
    const { pool, worker } = makePool();
    pool.postMessage({ task: 'charge' }, undefined, { idempotencyKey: 42 });
    expect(pool.postMessage({ task: 'charge' }, undefined, { idempotencyKey: '42' })).toBe(false);
    expect(worker.received).toHaveLength(1);
    pool.shutdown();
  });
});

describe('PowerPool idempotency: in-flight is distinguishable from settled', () => {
  it('refuses a re-entrant duplicate as in-flight, not as a retry', () => {
    // The distinction the row asks to be written down. A duplicate that arrives
    // *before* the first post returns has run nothing yet; one that arrives after
    // is a retry of something that probably has. Both are refused, and conflating
    // them would mean reporting a concurrent duplicate as an applied side effect.
    const { pool, worker } = makePool();
    let reentered = null;
    worker.onPost = () => {
      reentered = pool.postMessage({ task: 'charge' }, undefined, { idempotencyKey: 'inv-2' });
    };
    expect(pool.postMessage({ task: 'charge' }, undefined, { idempotencyKey: 'inv-2' })).toBe(true);

    expect(reentered).toBe(false);
    const stats = pool.getStats().idempotency;
    expect(stats.duplicatesInFlight).toBe(1);
    expect(stats.duplicatesSettled).toBe(0);
    // And the outer post still counts as dispatched: the re-entrant refusal must
    // not release the outer claim, which would let the retry through. Re-read the
    // stats rather than reusing the snapshot above — a stale object would report
    // the pre-retry numbers and the assertion below would be decoration.
    expect(pool.postMessage({ task: 'charge' }, undefined, { idempotencyKey: 'inv-2' })).toBe(
      false
    );
    expect(pool.getStats().idempotency.duplicatesSettled).toBe(1);
    pool.shutdown();
  });
});

describe('PowerPool idempotency: a refused post does not burn the key', () => {
  it('releases the claim when the pool refused the task, so a retry can proceed', () => {
    // The failure mode this is for, and it is invisible without the release: a
    // post the pool *refused* never ran, so leaving the key claimed would block
    // every retry of a task that never happened — the ledger turning a transient
    // queue-full into a permanent one.
    //
    // `maxQueueLength: 1` with a worker that never completes its task makes the
    // third post deterministically refused: one dispatched, one queued, one does
    // not fit.
    const { pool } = makePool({
      maxTasksPerWorker: 1,
      taskQueue: true,
      maxQueueLength: 1,
    });
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'first' })).toBe(true);
    expect(pool.postMessage({ task: 'b' }, undefined, { idempotencyKey: 'second' })).toBe(true);

    // 'third' is refused by the full queue, so its claim must be released…
    expect(pool.postMessage({ task: 'c' }, undefined, { idempotencyKey: 'third' })).toBe(false);
    // …which the ledger's own size shows: two settled keys, not three.
    //
    // Asserted through `size` rather than by retrying the post, because a retry
    // here would be refused *again* by the queue that is still full — and an
    // assertion that cannot tell those two refusals apart would pass whether or
    // not the release worked.
    expect(pool.getStats().idempotency.size).toBe(2);
    pool.shutdown();
  });
});

describe('PowerPool idempotency: the ledger does not outlive its usefulness', () => {
  it('expires settled keys once the TTL has passed', async () => {
    // A ledger that only ever grows is a leak, which is why the terminal state is a
    // TTL rather than a permanent mark. `idempotencyTtlMs: 1` and a short wait is
    // the only way to test this without a fake clock — the pool reads `nowMs()`
    // directly and takes no injected clock, which is worth knowing before writing
    // a test that wants one.
    const { pool } = makePool({ idempotencyTtlMs: 1 });
    pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'old' });
    expect(pool.getStats().idempotency.size).toBe(1);

    await new Promise((r) => setTimeout(r, 15));

    // The sweep runs off the back of a post, so the next keyed post is what drains
    // the ledger. Before the sweep existed, expiry only happened for keys looked up
    // a second time, and a workload of unique keys grew without bound.
    pool.postMessage({ task: 'b' }, undefined, { idempotencyKey: 'new' });
    const stats = pool.getStats().idempotency;
    expect(stats.expired).toBeGreaterThan(0);
    expect(stats.size).toBeLessThanOrEqual(1);

    // And the expired key is genuinely forgotten — the ledger protects a retry
    // across a timeout, not forever.
    expect(pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'old' })).toBe(true);
    pool.shutdown();
  });

  it('never expires a key whose post has not been dispatched yet', () => {
    // **This one is asserted on the ledger rather than through `postMessage`, and
    // the reason is the design's own.** A key is in-flight only *inside* one
    // synchronous `postMessage` call, so there is no window in which the public
    // path can be caught holding one across a TTL boundary — a re-entrant post
    // happens in the same tick, before any time has passed. Asserting it through
    // `postMessage` would therefore be asserting something the surface cannot
    // express, which is how a test ends up passing for reasons nobody can state.
    //
    // So the sweep is called directly, and the pair of claims is asserted
    // together: at the same instant, past the same TTL, a settled key goes and an
    // in-flight one stays. Time-based expiry applied to in-flight keys would let a
    // still-running task be posted a second time, which is the exact double-apply
    // the feature exists to prevent — so the guard is the `settledAt !== null`
    // check in `_idempotencySweep`, and this is what holds it in place.
    const { pool } = makePool({ idempotencyTtlMs: 1 });
    pool.postMessage({ task: 'a' }, undefined, { idempotencyKey: 'settled-key' });
    // Claimed and never settled, which is what an in-flight key looks like from
    // outside the post that owns it.
    pool._idempotency.set('in-flight-key', { settledAt: null });

    pool._idempotencySweep(pool._createdAt + 10_000);

    const stats = pool.getStats().idempotency;
    expect(stats.expired).toBe(1);
    expect(pool._idempotency.has('settled-key')).toBe(false);
    expect(pool._idempotency.has('in-flight-key')).toBe(true);
    pool.shutdown();
  });
});
