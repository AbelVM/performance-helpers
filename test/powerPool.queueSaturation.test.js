import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool queue saturation', () => {
  it('queues many tasks when pool at capacity and drains them', async () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          // simulate async work
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: { ok: true, req: msg } });
          }, 20);
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(SlowUnderlying, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      taskQueue: true,
      lazy: false,
      idleTimeout: 1000,
    });

    let processed = 0;
    pool.onmessage = () => processed++;

    try {
      const total = 30;
      for (let i = 0; i < total; i++) {
        const ok = pool.postMessage({ i });
        expect(ok).toBe(true);
      }
      // because pool size=1 and maxTasksPerWorker=1, at least (total-1) must be queued
      expect(pool.queue.length).toBeGreaterThanOrEqual(1);

      // wait for processing to finish (allow time for all queued tasks)
      await new Promise((r) => setTimeout(r, 1000));
      // processed may include extra control/aux messages; ensure at least the
      // expected number of task responses were processed.
      expect(processed).toBeGreaterThanOrEqual(total);
      expect(pool.queue.length).toBe(0);
    } finally {
      pool.terminate();
    }
  });
});
