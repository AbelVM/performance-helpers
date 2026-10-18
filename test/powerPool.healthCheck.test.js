import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool.healthCheck / ping', () => {
  it('returns one entry per worker with index, pending, alive', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
      addEventListener() {}
      removeEventListener() {}
    }

    const pool = new PowerPool(MockUnderlying, { size: 2, minSize: 2, idleTimeout: 1000 });
    try {
      const hc = pool.healthCheck();
      expect(Array.isArray(hc)).toBe(true);
      expect(hc).toHaveLength(2);
      for (let i = 0; i < hc.length; i++) {
        expect(hc[i].index).toBe(i);
        expect(typeof hc[i].pending).toBe('number');
        expect(typeof hc[i].alive).toBe('boolean');
        expect(hc[i].alive).toBe(true);
      }
      // ping is an alias
      expect(pool.ping()).toEqual(hc);
    } finally {
      pool.terminate();
    }
  });

  it('returns an empty list after termination', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
      addEventListener() {}
      removeEventListener() {}
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    pool.terminate();
    expect(pool.healthCheck()).toEqual([]);
  });
});
