import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool.batch APIs', () => {
  it('postMessageBatch seeds the queue with multiple tasks', () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn(() => {
          // do not reply quickly
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(SlowUnderlying, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      taskQueue: true,
      // create worker eagerly for this test
      minSize: 1,
      lazy: false,
    });
    try {
      const batch = [{ message: { a: 1 } }, { message: { a: 2 } }, { message: { a: 3 } }];
      const results = pool.postMessageBatch(batch, {});
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(batch.length);
      // one dispatched, others queued
      expect(pool.queue.length).toBeGreaterThanOrEqual(2 - (pool.workers.length > 0 ? 0 : 1));
    } finally {
      pool.terminate();
    }
  });

  it('stopThePressBatch rejects pending response Promises and forwards batch', async () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          // simulate long-running task that would reply later
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 200);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(SlowUnderlying, { size: 1, taskQueue: false });
    try {
      const p = pool.postMessage({ req: 1 }, undefined, { awaitResponse: true, timeout: 1000 });
      // ensure pending entry is established
      await new Promise((r) => setTimeout(r, 10));
      const batch = [{ message: { control: 'x' } }, { message: { control: 'y' } }];
      const forwarded = pool.stopThePressBatch(batch, { recreateWorkers: true });
      expect(Array.isArray(forwarded)).toBe(true);
      await expect(p).rejects.toThrow(/stopThePressBatch|stopThePress/);
    } finally {
      pool.terminate();
    }
  });
});
