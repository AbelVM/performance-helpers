import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: `prepareBuffers` option modes and the shutdown sweep.
 *
 * `prepareBuffers` is public, has two documented options with a long contract
 * between them (`clone: false` hands back the *cached* buffer and the runtime
 * copies it; `clone: true` hands back a private transferable copy), and every
 * statement in that contract is about who owns the bytes. The failure mode is
 * not a wrong value, it is a detached buffer handed to a caller who still owns
 * it — which throws later, somewhere else, and reads as a worker bug.
 */

function Silent() {
  this.onmessage = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}) {
  const pool = new PowerPool(Silent, {
    size: 1,
    minSize: 1,
    maxSize: 1,
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

describe('PowerPool prepareBuffers modes', () => {
  it('wraps a bare value in a message property', () => {
    const pool = makePool();
    const out = pool.prepareBuffers(['plain', { a: 1 }]);
    // `prepareBuffers` takes either `{message, transfer}` items or bare values.
    // A bare value must come back wrapped, or a caller reading `.message` gets
    // undefined for the whole input array.
    expect(out).toHaveLength(2);
    for (const item of out) {
      expect(item).toHaveProperty('message');
      expect(item).toHaveProperty('transfer');
    }
  });

  it('keeps an explicit { message, transfer } item as it is', () => {
    const pool = makePool();
    const buf = new ArrayBuffer(8);
    const out = pool.prepareBuffers([{ message: 'hello', transfer: [buf] }]);
    expect(out[0].transfer).toEqual([buf]);
  });

  it('passes a plain object straight through under zeroCopy', () => {
    const pool = makePool();
    const payload = { a: 1 };
    const out = pool.prepareBuffers([{ message: payload }], { zeroCopy: true });
    // `zeroCopy` means the object goes to the worker structurally, with no
    // encode step. Wrapping it in bytes would be a copy - the thing the option
    // exists to avoid - and would also change the wire shape a worker sees.
    expect(out[0].message).toBe(payload);
    expect(out[0].transfer).toBeUndefined();
  });

  it('encodes a plain object without transferring under the default mode', () => {
    const pool = makePool();
    const out = pool.prepareBuffers([{ message: { a: 1 } }]);
    // Default is `clone: false`: the runtime copies, so the transfer list is
    // `undefined`. Listing a buffer there would detach the *cached* encode
    // entry, which is the bug the `clone` option exists to let callers avoid.
    expect(out[0].message).toBeInstanceOf(Uint8Array);
    expect(out[0].transfer).toBeUndefined();
  });

  it('gives a private transferable copy under clone', () => {
    const pool = makePool();
    const out = pool.prepareBuffers([{ message: { a: 1 } }], { clone: true });
    // `clone: true` is "I want to keep the payload alive here and hand a
    // detachable buffer to the worker", so the buffer is sliced and listed.
    expect(out[0].message).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(out[0].transfer)).toBe(true);
    expect(out[0].transfer).toContain(out[0].message.buffer);
  });

  it('leaves the encode cache intact when cloning', () => {
    const pool = makePool();
    pool.prepareBuffers([{ message: { a: 1 } }], { clone: true });
    // The cache entry must survive, with its buffer still attached. If the
    // clone were taken from the cache and transferred directly, the next
    // identical message would encode into a detached buffer and post nothing.
    const cached = pool._encodeCache.get(JSON.stringify({ a: 1 }));
    expect(cached).toBeTruthy();
    expect(cached.buffer.detached).toBe(false);
  });

  it('transfers a binary payload as its own buffer', () => {
    const pool = makePool();
    const raw = new Uint8Array([1, 2, 3]);
    const out = pool.prepareBuffers([{ message: raw }]);
    expect(out[0].message).toBe(raw);
    expect(out[0].transfer).toEqual([raw.buffer]);
  });

  it('keeps a non-object value as-is with no transfer list', () => {
    const pool = makePool();
    const out = pool.prepareBuffers(['a string', 42, null]);
    // Nothing here is transferable and nothing needs encoding, so each entry
    // must pass through untouched.
    expect(out[0].message).toBe('a string');
    expect(out[1].message).toBe(42);
    expect(out[2].message).toBeNull();
    for (const item of out) expect(item.transfer).toBeUndefined();
  });

  it('preserves order and length for an empty batch', () => {
    const pool = makePool();
    expect(pool.prepareBuffers([])).toEqual([]);
  });
});

describe('PowerPool shutdown sweep', () => {
  it('rejects pending responses and clears the underlying map', async () => {
    const pool = makePool({ size: 1, maxSize: 1 });
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    expect(pool._pendingResponses.size).toBe(1);
    pool.terminate();
    // The shutdown sweep is the last chance to settle a caller. Leaving a
    // promise pending here keeps its timer armed, so the process cannot exit.
    await expect(pending).rejects.toThrow();
    expect(pool._pendingResponses.size).toBe(0);
  });

  it('survives a second terminate', () => {
    const pool = makePool();
    pool.terminate();
    // Idempotence: a caller that terminates in a `finally` after an explicit
    // terminate should not get a throw from cleanup code.
    expect(() => pool.terminate()).not.toThrow();
  });

  it('refuses to dispatch after termination', () => {
    const pool = makePool();
    pool.terminate();
    // A shut-down pool is final. Silently re-growing here is what previously
    // pinned a Node process forever, because the new worker had no reaper.
    expect(() => pool.postMessage({ a: 1 })).toThrow();
  });

  it('emits pool:scale for the workers it retired', () => {
    const pool = makePool({ size: 2, minSize: 2, maxSize: 2 });
    const seen = [];
    pool._bus.on('pool:scale', (e) => seen.push(e));
    pool.terminate();
    // A shutdown that retired two workers should say so, rather than making
    // the change observable only through `getStats()` afterwards.
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reports every worker as gone after shutdown', () => {
    const pool = makePool({ size: 2, minSize: 2, maxSize: 2 });
    pool.terminate();
    expect(pool.workers.length).toBe(0);
  });
});

describe('PowerPool queue high-watermark re-arm', () => {
  it('re-arms the event after the queue drains below the threshold', async () => {
    class Replier {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 1);
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Replier, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      queueHighThreshold: 0,
      lazy: false,
      idleTimeout: 1000,
    });
    pools.push(pool);
    const seen = [];
    pool._bus.on('pool:queue:high', () => seen.push(1));
    for (let round = 0; round < 2; round += 1) {
      pool.postMessage({ round });
      pool.postMessage({ round, queued: true });
      // Threshold 0, so a queue of length 1 crosses it. Let the worker answer
      // so the queue drains back under,
      // which is what re-arms the latch. A latch that never re-arms makes the
      // event fire once for the life of the pool.
      await vi.waitFor(() => {
        expect(pool.queue.length).toBe(0);
      });
    }
    expect(seen.length).toBe(2);
  });
});
