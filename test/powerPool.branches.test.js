import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool branch coverage', () => {
  it('postMessage returns false when underlying.postMessage throws', () => {
    class ThrowingUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {
          throw new Error('boom');
        };
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(ThrowingUnderlying, { size: 1, minSize: 0, idleTimeout: 1000 });
    try {
      const ok = pool.postMessage({ x: 1 });
      expect(ok).toBe(false);
    } finally {
      pool.terminate();
    }
  });

  it('forwards underlying onerror and messageerror to pool listeners', () => {
    class Underlying {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    // force eager creation for this test so underlying event handlers exist
    const pool = new PowerPool(Underlying, { size: 1, minSize: 0, lazy: false });
    try {
      const errSpy = vi.fn();
      const msgErrSpy = vi.fn();
      pool.addEventListener('error', errSpy);
      pool.addEventListener('messageerror', msgErrSpy);

      // locate underlying instance and simulate events
      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);
      if (underlying && typeof underlying.onerror === 'function') underlying.onerror({ code: 'E' });
      if (underlying && typeof underlying.onmessageerror === 'function')
        underlying.onmessageerror({ data: 'x' });

      expect(errSpy).toHaveBeenCalled();
      expect(msgErrSpy).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });

  it('reaps idle workers when lastActive older than idleTimeout', () => {
    class Underlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    // create workers eagerly then allow reaper to remove them (minSize:0)
    const pool = new PowerPool(Underlying, { size: 2, minSize: 0, lazy: false, idleTimeout: 10 });
    try {
      // make workers appear stale
      for (const w of pool.workers) {
        w.lastActive = Date.now() - 1000;
      }
      pool._reapIdleWorkers();
      expect(pool.workers.length).toBeLessThanOrEqual(0);
    } finally {
      pool.terminate();
    }
  });

  it('fallback round-robin dispatch when pool is full and queue disabled', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, {
      size: 1,
      maxSize: 1,
      taskQueue: false,
      maxTasksPerWorker: 0,
    });
    try {
      const ok = pool.postMessage({ z: 1 });
      expect(ok).toBe(true);
      const underlying = pool.workers[0]._underlying || pool.workers[0].worker._underlying;
      expect(underlying.postMessage).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });
});
