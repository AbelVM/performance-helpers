/**
 * POOL-009 — a message awaiting a response must not touch the encode cache.
 *
 * The cache is keyed on the serialised message, and a `wantResponse` post carries a
 * per-post correlation id, so its key is unique by construction. Measured before the fix,
 * with two **identical** `postMessage` calls:
 *
 * ```
 * fire-and-forget, twice   _encodeCache.size  1 -> 1   (the second hits)
 * awaitResponse,   twice   _encodeCache.size  1 -> 2   (a guaranteed miss, each time)
 * ```
 *
 * So the cost was not one wasted lookup — it was one wasted lookup *plus* an insert of an
 * entry that could never be reused, which grows `_encodeCacheBytes`, evicts an entry that
 * could have been, and makes the next eviction batch run for no benefit. A pool sending
 * correlated replies pays that on every message.
 *
 * **Why bypass rather than fix the key.** The structural fix is a correlation id in the
 * frame header instead of the body, and that is a **3.0** change: it breaks every worker
 * that echoes `data.correlationId`. Until then, not pretending the entry is cacheable is
 * the honest answer, and it costs one `JSON.stringify` that the cache would have paid
 * anyway.
 *
 * The tests count `_encodeCache.size` rather than timing anything: the claim is about
 * whether an entry is inserted, and an entry count is exact where a duration is noise.
 */
import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/index.js';

/** A worker-like that accepts posts and never answers them. */
class SilentWorker {
  constructor() {
    this._listeners = new Map();
    this.posts = 0;
  }
  addEventListener(type, fn) {
    this._listeners.set(type, fn);
  }
  removeEventListener() {}
  postMessage() {
    this.posts += 1;
  }
  terminate() {}
}

/** A pool over `SilentWorker`s, with a short response timeout so promises settle. */
function makePool() {
  return new PowerPool(() => new SilentWorker(), {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    awaitResponseTimeout: 20,
  });
}

/**
 * Post a message and **swallow whatever it ends in**.
 *
 * `awaitResponse` posts return a promise that ends in a rejection — a response timeout,
 * or `ERR_POOL_TERMINATED` when the pool is shut down underneath it. Every test here
 * shuts its pool down, so a discarded promise is an **unhandled rejection**, and vitest
 * counts those: the suite reports every assertion as passing and still exits non-zero on
 * `Errors  N errors`. That is not a flake and it is not cosmetic; it is the difference
 * between a green gate and a red one.
 *
 * So every post in this file goes through here, and the one test that cares about
 * delivery awaits it explicitly.
 *
 * @param {PowerPool} pool
 * @param {*} message
 * @param {object} [options]
 * @returns {Promise<*>} Resolves once the post's own outcome is settled.
 */
async function post(pool, message, options) {
  const result = pool.postMessage(message, undefined, options);
  if (result && typeof result.then === 'function') await result.catch(() => {});
}

describe('POOL-009: the encode cache and correlated posts', () => {
  it('still caches a repeated fire-and-forget message', () => {
    // **The control.** A bypass applied unconditionally would satisfy the row and quietly
    // delete the feature, so the property the cache exists for is asserted first.
    const pool = makePool();
    const msg = { task: 'charge', n: 1 };
    return post(pool, msg)
      .then(() => post(pool, msg))
      .then(() => {
        expect(pool._encodeCache.size).toBe(1);
        pool.shutdown();
      });
  });

  it('does not insert an entry for a post awaiting a response', () => {
    // The defect, measured: two identical correlated posts took the cache from 1 to 2.
    const pool = makePool();
    const msg = { task: 'charge', n: 1 };
    return post(pool, msg)
      .then(() => {
        const before = pool._encodeCache.size;
        return post(pool, msg, { awaitResponse: true, correlationKey: 'a' }).then(() => {
          expect(pool._encodeCache.size).toBe(before);
          return post(pool, msg, { awaitResponse: true, correlationKey: 'b' });
        });
      })
      .then(() => {
        expect(pool._encodeCache.size).toBe(1);
        pool.shutdown();
      });
  });

  it('leaves a cache entry alone when a correlated post is the only traffic', () => {
    // No prior entry, so there is nothing to hit and nothing should be created — the
    // empty-cache case is where an unconditional insert is most visible.
    const pool = makePool();
    return post(pool, { task: 'solo' }, { awaitResponse: true, correlationKey: 'x' }).then(() => {
      expect(pool._encodeCache.size).toBe(0);
      pool.shutdown();
    });
  });

  it('does not grow the cached byte total on correlated traffic', () => {
    // `_encodeCacheBytes` is what the byte ceiling is measured against, so a growing
    // entry count with a flat byte total would mean the accounting and the map disagree.
    const pool = makePool();
    const msg = { task: 'charge', body: 'x'.repeat(512), n: 1 };
    let bytes = 0;
    return post(pool, msg)
      .then(() => {
        bytes = pool._encodeCacheBytes;
        expect(bytes).toBeGreaterThan(0);
        return post(pool, msg, { awaitResponse: true, correlationKey: 'a' });
      })
      .then(() => post(pool, msg, { awaitResponse: true, correlationKey: 'b' }))
      .then(() => {
        expect(pool._encodeCacheBytes).toBe(bytes);
        pool.shutdown();
      });
  });

  it('bypasses on correlationId alone, matching the pending-response path', () => {
    // `wantResponse` is derived as `awaitResponse || correlationId != null`
    // (`powerPool.js:2866`), so a caller who passes only the id gets the same treatment.
    // Two paths disagreeing about what "wants a response" means is the kind of drift this
    // bypass would otherwise introduce.
    const pool = makePool();
    const msg = { task: 'charge', n: 1 };
    return post(pool, msg).then(() => {
      const before = pool._encodeCache.size;
      return post(pool, msg, { correlationId: 'only-an-id' }).then(() => {
        expect(pool._encodeCache.size).toBe(before);
        pool.shutdown();
      });
    });
  });

  it('still delivers the correlated message to the worker', () => {
    // **The bypass must not become a skip.** A "fix" that stopped encoding the body
    // would also stop the post, and this is the assertion that says no.
    const workers = [];
    const pool = new PowerPool(
      () => {
        const w = new SilentWorker();
        workers.push(w);
        return w;
      },
      { size: 1, minSize: 1, maxSize: 1, lazy: false, awaitResponseTimeout: 20 }
    );

    return post(pool, { task: 'charge' }, { awaitResponse: true, correlationKey: 'inv-1' }).then(
      () => {
        expect(workers.reduce((n, w) => n + w.posts, 0)).toBeGreaterThan(0);
        pool.shutdown();
      }
    );
  });
});
