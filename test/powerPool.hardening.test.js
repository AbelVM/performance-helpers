import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';
import { decodeMessage } from '../src/helpers/powerMessageCodec.js';

/**
 * Regression tests for the pool hardening pass: bounded queue, bounded drain,
 * an honest idle payload, atomic correlation ids, and a transfer path that
 * does not lie about what it did.
 *
 * Every test here is anchored to a failure mode that was *invisible* before:
 * a queue that grew until the process died, a drain that leaked a listener per
 * call, a JSDoc that described an array the code never produced, a duplicate
 * correlation id that silently rejected one caller and resolved another, and a
 * `postMessage` failure that was reported as a `DataCloneError` raised by its
 * own retry.
 */

/**
 * A worker that records what it was sent and never replies. A task posted to it
 * stays in flight forever, which is what keeps a pool non-idle.
 */
class SilentUnderlying {
  constructor() {
    this.onmessage = null;
    this.posts = [];
    this.postMessage = (msg, transfer) => {
      this.posts.push({ msg, transfer });
    };
    this.terminate = () => {};
  }
}

/**
 * A pool that is provably non-idle: one task dispatched to a worker that never
 * answers, so `_activeTasks` stays at 1.
 * @param {object} [options] - extra pool options
 * @returns {{pool: PowerPool, worker: SilentUnderlying}}
 */
function busyPool(options = {}) {
  const pool = new PowerPool(SilentUnderlying, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    maxTasksPerWorker: 1,
    idleTimeout: 0,
    ...options,
  });
  pool.postMessage({ n: 1 });
  expect(pool.getStats().activeTasks).toBe(1);
  return { pool, worker: pool.workers[0].worker._underlying };
}

describe('PowerPool bounded task queue (BUG-016)', () => {
  it('keeps growing without a cap, exactly as before 2.0', () => {
    const { pool } = busyPool({ maxQueueLength: undefined });
    for (let i = 0; i < 50; i++) pool.postMessage({ n: i });
    expect(pool.queue.length).toBe(50);
    pool.terminate();
  });

  it('refuses the incoming task once maxQueueLength is reached', () => {
    const { pool } = busyPool({ maxQueueLength: 3 });
    expect(pool.postMessage({ n: 1 })).toBe(true);
    expect(pool.postMessage({ n: 2 })).toBe(true);
    expect(pool.postMessage({ n: 3 })).toBe(true);
    expect(pool.queue.length).toBe(3);
    // The fourth does not fit. `enqueue` means "queue", so with a cap the
    // newest arrival is the one refused - the work already accepted is kept.
    expect(pool.postMessage({ n: 4 })).toBe(false);
    expect(pool.queue.length).toBe(3);
    pool.terminate();
  });

  it('admits again once the queue drains', () => {
    const { pool } = busyPool({ maxQueueLength: 2 });
    pool.postMessage({ n: 1 });
    pool.postMessage({ n: 2 });
    expect(pool.postMessage({ n: 3 })).toBe(false);
    // Free a slot the way a completion would.
    pool.queue.shift();
    expect(pool.postMessage({ n: 4 })).toBe(true);
    pool.terminate();
  });

  it('rejects with ERR_POOL_QUEUE_FULL when the caller awaits a response', async () => {
    const { pool } = busyPool({ maxQueueLength: 1 });
    pool.postMessage({ n: 1 });
    const pending = pool.postMessage({ n: 2 }, undefined, {
      awaitResponse: true,
      timeout: 50,
    });
    await expect(pending).rejects.toMatchObject({ code: 'ERR_POOL_QUEUE_FULL' });
    pool.terminate();
  });

  it('drop-oldest still evicts to make room for the newest', () => {
    const { pool } = busyPool({ maxQueueLength: 2, queuePolicy: 'drop-oldest' });
    pool.postMessage({ n: 1 });
    pool.postMessage({ n: 2 });
    pool.postMessage({ n: 3 });
    // `drop-oldest` was already self-bounding before `maxQueueLength` existed:
    // it evicts one and admits one, so the queue holds a constant number and
    // never climbs. The cap must not turn that into a refusal.
    expect(pool.queue.length).toBeLessThanOrEqual(2);
    // The oldest arrivals left only the newest standing. Queued messages are
    // stored already framed, so read the id back through the codec.
    const survivors = pool.queue.toArray().map((q) => decodeMessage(q.message).value.n);
    expect(survivors).toEqual([3]);
    pool.terminate();
  });

  it('rejects a non-numeric maxQueueLength instead of silently ignoring it', () => {
    expect(() => new PowerPool(SilentUnderlying, { maxQueueLength: 'lots' })).toThrow(TypeError);
  });

  it('caps a whole batch, refusing the overflow rather than pushing it', () => {
    const { pool } = busyPool({ maxQueueLength: 2 });
    const results = pool.postMessageBatch([
      { message: { n: 1 } },
      { message: { n: 2 } },
      { message: { n: 3 } },
      { message: { n: 4 } },
    ]);
    // One in flight (from busyPool) leaves room for exactly 2 more.
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(pool.queue.length).toBe(2);
    pool.terminate();
  });

  it('stopThePress with recreateWorkers:false forwards the real enqueue result', () => {
    // `stopThePress` clears the queue before it enqueues, so a `maxQueueLength`
    // cap cannot make it fail - the queue it writes into is always empty.
    // `queuePolicy: 'reject'` is the deterministic way to reach the refusal
    // path and prove the return value is not a hard-coded `true`.
    const { pool } = busyPool({ queuePolicy: 'reject' });
    expect(pool.stopThePress({ n: 1 }, undefined, { recreateWorkers: false })).toBe(false);
    pool.terminate();
  });

  it('stopThePress with recreateWorkers:false still enqueues when the policy allows', () => {
    const { pool } = busyPool({ maxQueueLength: 1 });
    expect(pool.stopThePress({ n: 1 }, undefined, { recreateWorkers: false })).toBe(true);
    expect(pool.queue.length).toBe(1);
    pool.terminate();
  });
});

describe('PowerPool idle payload (BUG-018)', () => {
  it('exposes per-worker snapshots as data.workers and the summary as data.stats', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 2, minSize: 2, maxSize: 2, lazy: false });
    const ev = pool._buildIdleEvent();
    expect(Array.isArray(ev.data.workers)).toBe(true);
    expect(ev.data.workers).toHaveLength(2);
    for (const w of ev.data.workers) {
      expect(w).toEqual({
        id: expect.any(Number),
        tasks: expect.any(Number),
        lastActive: expect.any(Number),
      });
    }
    // `stats` keeps the summary, so the existing readers of `ev.data.stats`
    // are unaffected by the split.
    expect(ev.data.stats).toHaveProperty('queueLength');
    expect(ev.data.stats).toHaveProperty('activeTasks');
    expect(Array.isArray(ev.data.stats)).toBe(false);
    pool.terminate();
  });

  it('computes both payloads lazily and at most once each', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1, lazy: false });
    const statsSpy = vi.spyOn(pool, 'getStats');
    const ev = pool._buildIdleEvent();
    // Reading `workers` must not pay for `getStats()`, and vice versa.
    expect(Array.isArray(ev.data.workers)).toBe(true);
    expect(statsSpy).not.toHaveBeenCalled();
    expect(ev.data.stats).toBeDefined();
    expect(statsSpy).toHaveBeenCalledTimes(1);
    expect(ev.data.workers).toHaveLength(1);
    expect(ev.data.stats).toBeDefined();
    expect(statsSpy).toHaveBeenCalledTimes(1);
    statsSpy.mockRestore();
    pool.terminate();
  });

  it('delivers the split payload through the idle event', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const seen = [];
    pool.addEventListener('idle', (ev) => seen.push(ev));
    // A pool constructed idle fires the listener synchronously on registration
    // (documented `addEventListener` behaviour), so drop that before measuring
    // the transition.
    expect(seen).toHaveLength(1);
    seen.length = 0;
    pool.postMessage({ n: 1 });
    pool._activeTasks = 0;
    pool.workers[0].tasks = 0;
    pool._updateIdleState();
    expect(seen).toHaveLength(1);
    expect(seen[0].data.type).toBe('pool:idle');
    expect(Array.isArray(seen[0].data.workers)).toBe(true);
    expect(seen[0].data.workers[0].tasks).toBe(0);
    pool.terminate();
  });
});

describe('PowerPool batch correlation ids (BUG-019)', () => {
  it('throws ERR_POOL_DUPLICATE_CORRELATION_ID and dispatches nothing', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    expect(() =>
      pool.postMessageBatch([{ message: { n: 1 } }, { message: { n: 2 } }], {
        awaitResponse: true,
        correlationIdFactory: () => 'same',
        timeout: 20,
      })
    ).toThrow(expect.objectContaining({ code: 'ERR_POOL_DUPLICATE_CORRELATION_ID' }));
    // The whole point of checking up front: a partial dispatch would leave the
    // first caller holding a promise that is already dead.
    expect(worker.posts).toHaveLength(0);
    pool.terminate();
  });

  it('names the offending item and the duplicated id', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    let caught;
    try {
      pool.postMessageBatch([{ message: { n: 1 } }, { message: { n: 2 } }], {
        awaitResponse: true,
        correlationIdFactory: () => 'id-0',
        timeout: 20,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('ERR_POOL_DUPLICATE_CORRELATION_ID');
    expect(caught.message).toContain('id-0');
    // Item 1 is where the collision was detected - the first item is the one
    // that already owned the id.
    expect(caught.message).toContain('item 1');
    pool.terminate();
  });

  it('refuses an id that is already in flight from an earlier call', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    const first = pool.postMessage({ n: 0 }, undefined, {
      awaitResponse: true,
      correlationId: 'in-flight',
      timeout: 50,
    });
    expect(pool._pendingResponses.has('in-flight')).toBe(true);
    expect(() =>
      pool.postMessageBatch([{ message: { n: 1 } }], {
        awaitResponse: true,
        correlationIdFactory: () => 'in-flight',
        timeout: 50,
      })
    ).toThrow(expect.objectContaining({ code: 'ERR_POOL_DUPLICATE_CORRELATION_ID' }));
    // The first waiter is untouched - the collision did not take the key over.
    expect(worker.posts).toHaveLength(1);
    void first.catch(() => {});
    pool.terminate();
  });

  it('accepts a well-behaved factory and calls it exactly once per item', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const factory = vi.fn((i) => `id-${i}`);
    const results = pool.postMessageBatch([{ message: { n: 1 } }, { message: { n: 2 } }], {
      awaitResponse: true,
      correlationIdFactory: factory,
      timeout: 20,
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(pool._pendingResponses.has('id-0')).toBe(true);
    expect(pool._pendingResponses.has('id-1')).toBe(true);
    for (const r of results) void r.catch(() => {});
    pool.terminate();
  });

  it('still rejects a fixed correlationId for multi-item batches', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    expect(() =>
      pool.postMessageBatch([{ message: { n: 1 } }, { message: { n: 2 } }], {
        awaitResponse: true,
        correlationId: 'fixed',
      })
    ).toThrow(/cannot use a fixed correlationId/);
    pool.terminate();
  });
});

describe('PowerPool drain is bounded and does not leak (BUG-012)', () => {
  it('rejects with ERR_POOL_DRAIN_TIMEOUT when the pool never goes idle', async () => {
    const { pool } = busyPool();
    await expect(pool.drain({ timeout: 25 })).rejects.toMatchObject({
      code: 'ERR_POOL_DRAIN_TIMEOUT',
    });
    // The waiter slot is released, so a later drain is not penalised.
    expect(pool._drainWaiters).toBe(0);
    pool.terminate();
  });

  it('detaches its idle listener on the timeout path', async () => {
    const { pool } = busyPool();
    const offSpy = vi.spyOn(pool, 'removeEventListener');
    await expect(pool.drain({ timeout: 25 })).rejects.toThrow();
    expect(offSpy).toHaveBeenCalledWith('idle', expect.any(Function));
    offSpy.mockRestore();
    pool.terminate();
  });

  it('detaches its idle listener on the abort path (the leak that was there before)', async () => {
    const { pool } = busyPool();
    const controller = new AbortController();
    const offSpy = vi.spyOn(pool, 'removeEventListener');
    const pending = pool.drain({ signal: controller.signal });
    expect(pool._drainWaiters).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // Previously the listener stayed attached and this count kept climbing.
    expect(offSpy).toHaveBeenCalledWith('idle', expect.any(Function));
    expect(pool._drainWaiters).toBe(0);
    offSpy.mockRestore();
    pool.terminate();
  });

  it('does not release the waiter slot twice when idle races the timeout', async () => {
    const { pool } = busyPool();
    const pending = pool.drain({ timeout: 5000 });
    pool._activeTasks = 0;
    pool.workers[0].tasks = 0;
    pool._updateIdleState();
    await expect(pending).resolves.toHaveProperty('activeTasks');
    expect(pool._drainWaiters).toBe(0);
    pool.terminate();
  });

  it('resolves with getStats() when the pool does go idle', async () => {
    const { pool } = busyPool();
    const pending = pool.drain({ timeout: 2000 });
    setTimeout(() => {
      pool._activeTasks = 0;
      pool.workers[0].tasks = 0;
      pool._updateIdleState();
    }, 10);
    const stats = await pending;
    expect(stats.activeTasks).toBe(0);
    expect(pool._drainWaiters).toBe(0);
    pool.terminate();
  });

  it('rejects beyond maxDrainWaiters instead of accumulating listeners', async () => {
    const { pool } = busyPool({ maxDrainWaiters: 2 });
    const a = pool.drain({ signal: null });
    const b = pool.drain({ signal: null });
    expect(pool._drainWaiters).toBe(2);
    await expect(pool.drain({ signal: null })).rejects.toMatchObject({
      code: 'ERR_POOL_DRAIN_TOO_MANY_WAITERS',
    });
    // Freeing one slot lets the next caller in.
    pool._activeTasks = 0;
    pool.workers[0].tasks = 0;
    pool._updateIdleState();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(pool._drainWaiters).toBe(0);
    pool.terminate();
  });

  it('rejects an already-aborted signal without waiting', async () => {
    const { pool } = busyPool();
    const controller = new AbortController();
    controller.abort();
    await expect(pool.drain({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(pool._drainWaiters).toBe(0);
    pool.terminate();
  });

  it('resolves immediately for an already-idle pool', async () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const stats = await pool.drain({ timeout: 10 });
    expect(stats.activeTasks).toBe(0);
    expect(pool._drainWaiters).toBe(0);
    pool.terminate();
  });
});

describe('PowerPool transfer path reports what actually happened (BUG-020)', () => {
  // The `_postToWorkerObj` bypass is reached **only** under `zeroCopy: true`.
  // `_prepareForTransfer` otherwise encodes a plain object to a framed
  // `Uint8Array` before `_postToWorkerObj` ever sees it, so by then the message
  // is a view rather than a plain object and the branch does not apply. That
  // makes the bypass a `zeroCopy` escape hatch, and it is why the tests below
  // all pass `zeroCopy: true`.
  it('delivers a plain object with a transfer list as-is, not re-encoded', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    const buf = new ArrayBuffer(8);
    const payload = { kind: 'object-not-encoded' };
    pool.postMessage(payload, [buf], { zeroCopy: true });
    expect(worker.posts).toHaveLength(1);
    // The object arrives as an object. Routing through `WorkerWrapper` would
    // have substituted an encoded `Uint8Array` here.
    expect(worker.posts[0].msg).toBe(payload);
    pool.terminate();
  });

  it('encodes a plain object without zeroCopy (the default path is unaffected)', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    const buf = new ArrayBuffer(8);
    pool.postMessage({ a: 1 }, [buf]);
    expect(worker.posts).toHaveLength(1);
    expect(worker.posts[0].msg).toBeInstanceOf(Uint8Array);
    // The caller's buffer is transferred alongside the encoded frame.
    expect(worker.posts[0].transfer).toContain(buf);
    pool.terminate();
  });

  it('does not retry a failed direct post with the same transfer list', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    const boom = new Error('post failed');
    let calls = 0;
    worker.postMessage = () => {
      calls++;
      throw boom;
    };
    pool._logger.error = vi.fn();
    const buf = new ArrayBuffer(8);
    // A retry here is what produced `DataCloneError: ... has already been
    // detached` in place of the real error.
    expect(pool.postMessage({ a: 1 }, [buf], { zeroCopy: true })).toBe(false);
    expect(calls).toBe(1);
    expect(pool._logger.error).toHaveBeenCalledWith(boom, expect.stringContaining('postMessage'));
    pool.terminate();
  });

  it('surfaces the original error to an awaiting caller, not a retry artifact', async () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    const boom = new Error('the real cause');
    let calls = 0;
    worker.postMessage = () => {
      calls++;
      throw boom;
    };
    pool._logger.error = vi.fn();
    const pending = pool.postMessage({ a: 1 }, [new ArrayBuffer(8)], {
      zeroCopy: true,
      awaitResponse: true,
      timeout: 100,
    });
    await expect(pending).rejects.toBe(boom);
    expect(calls).toBe(1);
    pool.terminate();
  });

  it('does not increment task accounting for a post that never landed', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    worker.postMessage = () => {
      throw new Error('nope');
    };
    pool._logger.error = vi.fn();
    expect(pool.postMessage({ a: 1 }, [new ArrayBuffer(8)], { zeroCopy: true })).toBe(false);
    expect(pool.workers[0].tasks).toBe(0);
    expect(pool.getStats().activeTasks).toBe(0);
    pool.terminate();
  });

  it('skips the bypass when the transfer list is already detached', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    const buf = new ArrayBuffer(8);
    // Detach it out from under the pool, the way a re-used buffer does.
    structuredClone(buf, { transfer: [buf] });
    expect(buf.detached).toBe(true);
    const payload = { a: 1 };
    pool.postMessage(payload, [buf], { zeroCopy: true });
    // The plain object did **not** reach the underlying worker as-is, which is
    // the whole point of the pre-check: never reach through carrying a buffer
    // the post cannot use.
    expect(worker.posts[0].msg).not.toBe(payload);
    expect(worker.posts[0].msg).toBeInstanceOf(Uint8Array);
    pool.terminate();
  });

  it('does not treat a zero-length live buffer as detached', () => {
    const pool = new PowerPool(SilentUnderlying, { size: 1, minSize: 1, maxSize: 1 });
    const worker = pool.workers[0].worker._underlying;
    // A legitimately empty buffer is not a dead one; refusing it would be a
    // false positive on a real transfer.
    const payload = { a: 1 };
    expect(pool.postMessage(payload, [new ArrayBuffer(0)], { zeroCopy: true })).toBe(true);
    expect(worker.posts[0].msg).toBe(payload);
    pool.terminate();
  });
});
