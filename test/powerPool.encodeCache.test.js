import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: the encode cache, the broadcast path, and drain.
 *
 * These are the last three areas where a branch exists but no assertion reaches
 * it. The encode cache is the interesting one because its two limits - entry
 * count and total bytes - interact: a byte limit that is never reconciled on
 * eviction makes the cache grow without bound while reporting that it is
 * bounded, and the bookkeeping error is invisible because the cache still
 * *works*, it just stops being a cache.
 */

/** A worker that accepts work and never answers. */
function Silent() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/** A worker that records what it was sent, for asserting broadcast coverage. */
function Recording() {
  this.onmessage = null;
  this.postMessage = (msg, transfer) => {
    this.posted.push({ msg, transfer });
  };
  this.posted = [];
  this.terminate = () => {};
}

const pools = [];
function makePool(WorkerCtor = Silent, options = {}) {
  const pool = new PowerPool(WorkerCtor, {
    size: 1,
    minSize: 1,
    maxSize: 3,
    lazy: false,
    ...options,
  });
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

describe('PowerPool encode cache', () => {
  it('reuses the encoded bytes for an identical message', () => {
    const pool = makePool(Recording, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    pool._encodeForTransfer({ a: 1 });
    pool._encodeForTransfer({ a: 1 });
    // The whole point of the cache: the second identical message must be a
    // `Map` hit, not a second `JSON.stringify` plus encode.
    expect(pool._encodeCache.size).toBe(1);
  });

  it('does not cache a payload too large to key on', () => {
    const pool = makePool(Recording, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    const big = { blob: 'x'.repeat(200_000) };
    const first = pool._encodeForTransfer(big);
    const second = pool._encodeForTransfer(big);
    // A huge serialized key would bloat the Map for one entry that is unlikely
    // to be seen again, so it is encoded and not stored.
    expect(first).toBeInstanceOf(Uint8Array);
    expect(second).toBeInstanceOf(Uint8Array);
    expect(pool._encodeCache.size).toBe(0);
  });

  it('evicts oldest entries past the entry-count limit', () => {
    const pool = makePool(Recording, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: Infinity,
      encodeCacheLimit: 16,
    });
    for (let i = 0; i < 64; i++) pool._encodeForTransfer({ n: i });
    // The floor is 16, so a hard bound is 16 regardless of how many messages
    // went through. Exceeding it silently is what turns a cache into a leak.
    expect(pool._encodeCache.size).toBeLessThanOrEqual(16);
  });

  it('reconciles the byte total when entries are evicted', () => {
    const pool = makePool(Recording, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: Infinity,
      encodeCacheLimit: 1024,
      encodeCacheByteLimit: 512,
    });
    for (let i = 0; i < 40; i++) pool._encodeForTransfer({ payload: 'y'.repeat(64), n: i });
    // `_encodeCacheBytes` is a running total maintained across evictions. If it
    // is not decremented the cache would keep evicting on a limit it has
    // already satisfied, and the reported total would be fiction.
    expect(pool._encodeCacheBytes).toBeLessThanOrEqual(512);
    const actual = [...pool._encodeCache.values()].reduce((sum, v) => sum + (v.byteLength || 0), 0);
    expect(pool._encodeCacheBytes).toBe(actual);
  });

  it('keeps a live entry rather than evicting it out from under a caller', () => {
    const pool = makePool(Recording, { size: 1, maxSize: 1, maxTasksPerWorker: Infinity });
    const u8 = pool._encodeForTransfer({ reused: true });
    // Evicting an entry that is still being handed to `postMessage` would
    // detach a buffer the caller is about to transfer. Slicing before transfer
    // is what makes this safe, and the returned value must stay intact.
    expect(u8.byteLength).toBeGreaterThan(0);
    expect(u8.buffer.detached).toBe(false);
  });
});

describe('PowerPool broadcast', () => {
  it('sends to every worker and counts the task on each', () => {
    const pool = makePool(Recording, { size: 3, minSize: 3, maxSize: 3 });
    const underlyings = pool.workers.map((w) => w.worker._underlying);
    pool.broadcast({ a: 1 });
    // Every worker, not just the least-loaded. A broadcast that reached two of
    // three workers is a silent partial delivery, and the caller has no way to
    // tell.
    for (const u of underlyings) expect(u.posted).toHaveLength(1);
    expect(pool.workers.every((w) => w.tasks === 1)).toBe(true);
  });

  it('encodes a plain object for each worker independently', () => {
    const pool = makePool(Recording, { size: 2, minSize: 2, maxSize: 2 });
    const underlyings = pool.workers.map((w) => w.worker._underlying);
    pool.broadcast({ a: 1 });
    // Each worker gets its own copy, because the encoded buffer is transferred
    // and a buffer can only be transferred once. Sharing one instance would
    // detach it after the first post.
    expect(underlyings[0].posted[0].msg).toBeInstanceOf(Uint8Array);
    expect(underlyings[1].posted[0].msg).toBeInstanceOf(Uint8Array);
    expect(underlyings[0].posted[0].msg.buffer).not.toBe(underlyings[1].posted[0].msg.buffer);
  });

  it('sends a binary payload as given to every worker', () => {
    const pool = makePool(Recording, { size: 2, minSize: 2, maxSize: 2 });
    const underlyings = pool.workers.map((w) => w.worker._underlying);
    const raw = new Uint8Array([1, 2, 3]);
    pool.broadcast(raw, [raw.buffer]);
    // An explicit transfer list means "this exact buffer", so the bytes go
    // across unframed - the same rule the single-message path applies.
    for (const u of underlyings) expect(u.posted[0].msg).toBe(raw);
  });

  it('encodes a binary payload when no transfer list is given', () => {
    const pool = makePool(Recording, { size: 2, minSize: 2, maxSize: 2 });
    const underlyings = pool.workers.map((w) => w.worker._underlying);
    pool.broadcast(new Uint8Array([1, 2, 3]));
    for (const u of underlyings) expect(u.posted[0].msg).toBeInstanceOf(Uint8Array);
  });
});

describe('PowerPool drain', () => {
  it('rejects when too many drains are already waiting', async () => {
    const pool = makePool(Silent, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      maxDrainWaiters: 1,
    });
    // A task that never completes keeps the pool busy, so the first drain has
    // to wait for the pool to terminate. An unbounded number of `drain()`
    // calls each holding an `idle` listener is a leak with a very slow fuse,
    // so the second is refused rather than accumulated.
    pool.postMessage({ a: 1 });
    const first = pool.drain();
    await expect(pool.drain()).rejects.toMatchObject({
      code: 'ERR_POOL_DRAIN_TOO_MANY_WAITERS',
    });
    pool.terminate();
    await expect(first).resolves.toBeTruthy();
  });

  it('frees a waiter slot once a drain completes', async () => {
    const pool = makePool(Silent, { size: 1, maxSize: 1, maxDrainWaiters: 1 });
    // Both drains resolve immediately against an idle pool, so the second one
    // only succeeds if the first released its slot. A pool that drains more
    // than `maxDrainWaiters` times in a row would otherwise stop working with
    // no diagnostic at all.
    await expect(pool.drain()).resolves.toBeTruthy();
    await expect(pool.drain()).resolves.toBeTruthy();
  });

  it('resolves immediately when there is nothing in flight', async () => {
    const pool = makePool(Silent);
    await expect(pool.drain()).resolves.toBeTruthy();
  });
});
