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
import { DEFAULT_IDEMPOTENCY_SWEEP_BATCH } from '../src/helpers/constants.js';

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

  it('reaches settled keys parked behind more in-flight keys than one batch (AUD-008)', async () => {
    // **The rotating cursor, and the reason it is not optional.**
    //
    // The sweep examines a bounded slice per call, and it used to always take
    // that slice from the *head* of the ledger. That drains fine while entries
    // are being deleted — a deletion moves the rest up, so the next slice is the
    // next keys. It stops draining the moment the head is occupied by entries
    // that are never deleted, and in-flight entries are exactly that: they are
    // released by their post's own outcome, never by the sweep.
    //
    // So a ledger whose first `DEFAULT_IDEMPOTENCY_SWEEP_BATCH` (32) entries are
    // in-flight never reaches *any* settled key, and every settled key behind
    // them is retained past its TTL forever. That is the leak the TTL exists to
    // prevent, reached through the one state the sweep is documented not to
    // touch.
    //
    // Asserted on the ledger directly for the same reason as the test above: the
    // in-flight state has no window outside the synchronous post that owns it,
    // so the public path cannot be used to build this shape.
    const { pool } = makePool({ idempotencyTtlMs: 1 });
    const ledger = pool._idempotency;
    // 40 in-flight keys — more than one batch — then 10 settled keys past TTL.
    for (let i = 0; i < 40; i++) ledger.set(`busy-${i}`, { settledAt: null });
    for (let i = 0; i < 10; i++) ledger.set(`done-${i}`, { settledAt: 0 });

    // Three sweeps is 96 slots of budget against 50 entries, so a cursor that
    // rotates reaches everything. A head-only scan spends all 96 re-examining
    // the same 32 in-flight keys.
    const now = pool._createdAt + 10_000;
    for (let i = 0; i < 3; i++) pool._idempotencySweep(now);

    expect(pool.getStats().idempotency.expired).toBe(10);
    for (let i = 0; i < 10; i++) expect(ledger.has(`done-${i}`)).toBe(false);
    // And the in-flight keys are untouched — the cursor rotates *past* them, it
    // does not start expiring them.
    for (let i = 0; i < 40; i++) expect(ledger.has(`busy-${i}`)).toBe(true);
    pool.shutdown();
  });

  it('examines a bounded slice without materialising the ledger (AUD-008)', () => {
    // **The allocation, which is what the row is actually about.**
    //
    // The sweep used to open with `const keys = [...ledger.keys()]`. The spread
    // drains the *entire* iterator to build an array before the bounded slice is
    // taken, so the cost of opting into idempotency was an O(n) allocation on
    // every `postMessage`, where `n` is the number of in-flight keys — the exact
    // opposite of what a bounded sweep is for. The comment above the loop
    // claimed "a bounded slice per call", which was true of the examination and
    // false of the cost.
    //
    // Counting iterator yields is the deterministic way to see the difference:
    // a spread drains every key, a lazy `for…of` with a `break` stops at the
    // batch. Timing would be noise at this size, and asserting on the source
    // would be asserting on spelling.
    const { pool } = makePool({ idempotencyTtlMs: 1 });
    const ledger = pool._idempotency;
    // Far more entries than one batch, all in-flight so none are deleted and
    // the cursor cannot rotate past them — the sweep's budget is the only thing
    // bounding the work.
    const total = 5000;
    for (let i = 0; i < total; i++) ledger.set(`busy-${i}`, { settledAt: null });

    const realKeys = ledger.keys.bind(ledger);
    let yielded = 0;
    ledger.keys = () => {
      const it = realKeys();
      return {
        next() {
          const r = it.next();
          if (!r.done) yielded += 1;
          return r;
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    };

    try {
      pool._idempotencySweep(pool._createdAt + 10_000);
    } finally {
      ledger.keys = realKeys;
    }

    // One batch, not the whole ledger. The old code yielded all 5000.
    //
    // `BATCH + 1` rather than `BATCH`: a `for…of` calls `next()` to *get* the key
    // and only then tests the budget, so the yield that pushes `examined` to the
    // limit has already happened by the time the `break` runs. That one extra
    // yield is the loop's own, not a second entry examined.
    expect(yielded).toBeLessThanOrEqual(DEFAULT_IDEMPOTENCY_SWEEP_BATCH + 1);
    expect(yielded).toBeGreaterThan(0);
    // And nothing was expired, because every entry examined was in-flight.
    expect(pool.getStats().idempotency.expired).toBe(0);
    expect(ledger.size).toBe(total);
    pool.shutdown();
  });

  it('does not resume from a cursor whose key was deleted (AUD-008)', () => {
    // The cursor is only safe to resume from if it still names a live entry. A
    // sweep that expires the key it was about to resume from would leave the
    // next sweep skipping the entire ledger looking for a key that is gone,
    // examining nothing — a silent stall that looks exactly like an empty
    // ledger. The implementation guards this two ways: it resumes from the last
    // key that *survived*, and it treats a cursor missing from the ledger as
    // "start from the head".
    const { pool } = makePool({ idempotencyTtlMs: 1 });
    const ledger = pool._idempotency;
    for (let i = 0; i < 5; i++) ledger.set(`k-${i}`, { settledAt: 0 });
    const now = pool._createdAt + 10_000;

    pool._idempotencySweep(now);
    // Every entry was expired, so there is nothing live to resume from.
    expect(ledger.size).toBe(0);
    expect(pool._idempotencyCursor).toBeNull();

    // A fresh batch must still be swept: the stall would show up here as a
    // ledger that never drains again.
    for (let i = 0; i < 5; i++) ledger.set(`fresh-${i}`, { settledAt: 0 });
    pool._idempotencySweep(now);
    expect(ledger.size).toBe(0);
    expect(pool.getStats().idempotency.expired).toBe(10);
    pool.shutdown();
  });
});
