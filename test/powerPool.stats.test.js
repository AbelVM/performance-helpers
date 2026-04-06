import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool.getStats()', () => {
  it('returns explicit telemetry fields and current queue/active counts', () => {
    class StubUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(StubUnderlying, {
      size: 1,
      minSize: 1,
      lazy: false,
      maxSize: 1,
      idleTimeout: 1000,
    });
    try {
      const ok = pool.postMessage({ foo: 'bar' });
      expect(ok).toBe(true);

      const stats = pool.getStats();
      expect(stats).toHaveProperty('status');
      expect(stats).toHaveProperty('performance');
      expect(stats).toHaveProperty('queueLength', 0);
      expect(stats).toHaveProperty('activeTasks', 1);
      expect(stats).toHaveProperty('workerCount', 1);
      expect(stats).toHaveProperty('minSize', 1);
      expect(stats).toHaveProperty('maxSize', 1);
      expect(stats).toHaveProperty('isIdle', false);
      expect(Array.isArray(stats.status)).toBe(true);
      expect(stats.status[0]).toMatchObject({ tasks: 1 });
    } finally {
      pool.terminate();
    }
  });
});
