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

  it('postMessageBatch with awaitResponse and correlationIdFactory returns promises for all items', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, {
      minSize: 1,
      lazy: false,
      size: 1,
      idleTimeout: 1000,
    });
    try {
      const batch = [{ message: { a: 1 } }, { message: { a: 2 } }];
      const results = pool.postMessageBatch(batch, {
        awaitResponse: true,
        correlationIdFactory: (index) => `id-${index}`,
      });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      expect(results[0]).toBeInstanceOf(Promise);
      expect(results[1]).toBeInstanceOf(Promise);
      const resolved = await Promise.all(results);
      expect(resolved[0]).toHaveProperty('correlationId', 'id-0');
      expect(resolved[1]).toHaveProperty('correlationId', 'id-1');
    } finally {
      pool.terminate();
    }
  });

  it('postMessageBatch rejects multi-item fixed correlationId usage', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, {
      minSize: 1,
      lazy: false,
      size: 1,
      idleTimeout: 1000,
    });
    try {
      const batch = [{ message: { a: 1 } }, { message: { a: 2 } }];
      expect(() =>
        pool.postMessageBatch(batch, {
          awaitResponse: true,
          correlationId: 'fixed-id',
        })
      ).toThrow(/fixed correlationId/);
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

  it('postMessageBatch drop-oldest rejects dropped awaitResponse task and clears pending response entry', async () => {
    class SilentUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn(() => {
          // never replies
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(SilentUnderlying, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 0,
      taskQueue: true,
      queuePolicy: 'drop-oldest',
      lazy: false,
    });

    try {
      const pending = pool.postMessage({ req: 'old' }, undefined, {
        awaitResponse: true,
        timeout: 500,
      });

      expect(pool.queue.length).toBe(1);
      expect(pool._pendingResponses.size).toBe(1);

      const batchResults = pool.postMessageBatch([{ message: { req: 'new' } }]);
      expect(batchResults).toEqual([true]);

      await expect(pending).rejects.toThrow(/queued task dropped by policy/);
      expect(pool._pendingResponses.size).toBe(0);
      expect(pool.queue.length).toBe(1);
    } finally {
      pool.terminate();
    }
  });
});
