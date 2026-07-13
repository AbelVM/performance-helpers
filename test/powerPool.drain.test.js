import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool.drain()', () => {
  it('resolves immediately when pool is idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const stats = await pool.drain();
      expect(stats).toBeDefined();
      expect(Array.isArray(stats.status)).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  it('resolves when the pool is terminated before becoming idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      // post a task that never completes so the pool stays busy
      pool.postMessage({ n: 1 });
      const drained = pool.drain();
      // terminate before the pool ever becomes idle
      pool.terminate();
      const stats = await drained;
      expect(stats).toBeDefined();
      expect(Array.isArray(stats.status)).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  it('resolves when shutdown() is called before the pool becomes idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      // post a task that never completes so the pool stays busy
      pool.postMessage({ n: 1 });
      const drained = pool.drain();
      // shutdown() must emit idle so the in-flight drain() resolves instead
      // of hanging forever (regression: shutdown did not emit idle).
      pool.shutdown();
      const stats = await drained;
      expect(stats).toBeDefined();
      expect(Array.isArray(stats.status)).toBe(true);
    } finally {
      pool.terminate();
    }
  });
});
