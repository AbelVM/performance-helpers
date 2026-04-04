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

  it('resolves after queued tasks are processed and workers become idle', async () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          // reply after small delay
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 20);
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(SlowUnderlying, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      taskQueue: true,
      idleTimeout: 1000,
    });
    try {
      // post two tasks; second will be queued
      expect(pool.postMessage({ n: 1 })).toBe(true);
      expect(pool.postMessage({ n: 2 })).toBe(true);

      // drain should wait until both are processed and pool is idle
      await pool.drain();
      expect(pool.queue.length).toBe(0);
      expect(pool.workers.every((w) => w.tasks === 0)).toBe(true);
    } finally {
      pool.terminate();
    }
  });
});
