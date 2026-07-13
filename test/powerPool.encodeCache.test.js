import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * Regression tests for the encode-cache and lazy idle-stats optimizations.
 *
 * - `_encodeForTransfer` must return the *same* cached `Uint8Array` for
 *   identical plain objects (cache hit), and must not `JSON.stringify` the
 *   message twice on a miss (it reuses the pre-stringified key via `o2u8`).
 * - Idle events must compute `stats` lazily so `getStats()` (which maps over
 *   all workers) is skipped when no listener reads `ev.data.stats`.
 */
describe('PowerPool encode cache & lazy idle stats', () => {
  class MockUnderlying {
    constructor() {
      this.onmessage = null;
      this.calls = [];
      this.postMessage = (msg, transfer) => {
        this.calls.push({ msg, transfer });
      };
      this.terminate = () => {};
    }
  }

  it('returns the same cached Uint8Array instance for identical messages', () => {
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    const a = pool._encodeForTransfer({ x: 1 });
    const b = pool._encodeForTransfer({ x: 1 });
    expect(b).toBe(a); // cache hit returns the identical instance
    pool.terminate();
  });

  it('does not JSON.stringify twice on a cache miss (reuses pre-stringified key)', () => {
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    const obj = { payload: 'hello', n: 7 };
    const spy = vi.spyOn(JSON, 'stringify');
    pool._encodeForTransfer(obj); // miss -> encodes
    // The miss must stringify `obj` exactly once: once for the cache key, and
    // the encode reuses that pre-stringified string instead of re-stringifying.
    const stringifiesOfObj = spy.mock.calls.filter((args) => args[0] === obj).length;
    expect(stringifiesOfObj).toBe(1);
    spy.mockRestore();
    pool.terminate();
  });

  it('computes idle stats lazily (only when read)', () => {
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    const spy = vi.spyOn(pool, 'getStats');
    const ev = pool._buildIdleEvent();
    expect(spy).not.toHaveBeenCalled();
    // Accessing stats triggers computation exactly once (then cached).
    expect(ev.data.stats).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ev.data.stats).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    pool.terminate();
  });
});
