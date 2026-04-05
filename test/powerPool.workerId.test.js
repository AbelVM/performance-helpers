import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool per-worker targeting', () => {
  it('routes a message to the specified workerId when available', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 2, minSize: 2, idleTimeout: 1000 });
    try {
      expect(pool.workers.length).toBeGreaterThanOrEqual(2);
      const target = pool.workers[0];
      const other = pool.workers[1];
      // ensure spies are on the underlying implementations
      const underlyingTarget = target.worker._underlying || target.worker._underlying;
      const underlyingOther = other.worker._underlying || other.worker._underlying;
      pool.postMessage({ hello: 'targeted' }, null, { workerId: target.id });
      expect(underlyingTarget.postMessage).toHaveBeenCalled();
      // other worker should not have been called for this targeted message
      expect(underlyingOther.postMessage).not.toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });

  it('returns false when targeted worker does not exist', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 1 });
    try {
      const res = pool.postMessage({ x: 1 }, null, { workerId: 9999 });
      expect(res).toBe(false);
    } finally {
      pool.terminate();
    }
  });
});
