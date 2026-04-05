import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool.resize() overload', () => {
  it('updates minSize and maxSize and spawns workers up to minSize', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, {
      size: 1,
      minSize: 1,
      maxSize: 3,
      idleTimeout: 1000,
    });
    try {
      let event = null;
      pool.addEventListener('resize', (e) => {
        event = e;
      });
      pool.resize({ minSize: 3, maxSize: 5 });
      expect(pool.minSize).toBe(3);
      expect(pool.maxSize).toBe(5);
      expect(pool.workers.length).toBeGreaterThanOrEqual(3);
      expect(event).not.toBeNull();
      expect(event.data.added).toBeGreaterThanOrEqual(1);
    } finally {
      pool.terminate();
    }
  });

  it('terminates excess workers and emits terminated ids on shrink', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, {
      size: 4,
      minSize: 4,
      maxSize: 4,
      idleTimeout: 1000,
    });
    try {
      let event = null;
      pool.onresize = (e) => {
        event = e;
      };
      pool.resize({ minSize: 1, maxSize: 2 });
      expect(pool.minSize).toBe(1);
      expect(pool.maxSize).toBe(2);
      expect(pool.workers.length).toBeLessThanOrEqual(2);
      expect(event).not.toBeNull();
      expect(Array.isArray(event.data.terminated)).toBe(true);
      expect(event.data.terminated.length).toBeGreaterThanOrEqual(1);
    } finally {
      pool.terminate();
    }
  });
});
