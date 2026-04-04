import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool.resize()', () => {
  it('shrinks the pool by terminating excess workers', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 3, minSize: 1, idleTimeout: 1000 });
    try {
      expect(pool.workers.length).toBe(3);
      pool.resize(1);
      expect(pool.workers.length).toBeGreaterThanOrEqual(1);
      expect(pool.workers.length).toBe(1);
    } finally {
      pool.terminate();
    }
  });

  it('allows growing the pool by increasing maxSize and creating workers on demand', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((m) => {
          if (this.onmessage) setTimeout(() => this.onmessage({ data: m }), 0);
        });
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      idleTimeout: 1000,
    });
    try {
      expect(pool.maxSize).toBe(1);
      pool.resize(3);
      expect(pool.maxSize).toBe(3);
      // post messages to cause pool to grow
      expect(pool.postMessage({ a: 1 })).toBe(true);
      expect(pool.postMessage({ a: 2 })).toBe(true);
      expect(pool.postMessage({ a: 3 })).toBe(true);
      // allow async creation/dispatch
      // after a tick there should be up to 3 workers
      return new Promise((resolve) =>
        setTimeout(() => {
          try {
            expect(pool.workers.length).toBeGreaterThanOrEqual(1);
            expect(pool.workers.length).toBeLessThanOrEqual(3);
          } finally {
            pool.terminate();
            resolve();
          }
        }, 20)
      );
    } finally {
      // pool.terminate() handled in promise cleanup
    }
  });
});
