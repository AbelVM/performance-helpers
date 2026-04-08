import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

// Worker that throws when postMessage is called
function BadWorker() {
  this.addEventListener = function (type, cb) {
    if (type === 'message') this.onmessage = cb;
    if (type === 'error') this.onerror = cb;
  };
  this.removeEventListener = function () {};
  this.terminate = function () {};
  this.postMessage = function () {
    throw new Error('boom');
  };
}

describe('PowerPool additional shallow branches', () => {
  it('constructor throws for invalid workerSource type', () => {
    expect(() => new PowerPool({}, { lazy: false, minSize: 0 })).toThrow();
  });

  it('wrapper.postMessage logs and rethrows when underlying.postMessage throws', () => {
    const pool = new PowerPool(function WorkerFactory() {}, { minSize: 0, lazy: true });
    // add a bad underlying instance via _addWorkerInstance
    const origLogger = pool._logger;
    pool._logger = { error: vi.fn(), log: origLogger.log };
    const workerObj = pool._addWorkerInstance();
    // replace underlying with bad worker to force underlying.postMessage throw
    workerObj.worker._underlying = new BadWorker();
    expect(() => workerObj.worker.postMessage({ a: 1 })).toThrow();
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('onmessage handler errors are caught and logged', () => {
    const pool = new PowerPool(function Stub() {}, { minSize: 1, lazy: false });
    pool._logger.error = vi.fn();
    pool.onmessage = () => {
      throw new Error('boom onmessage');
    };
    // simulate a worker message arriving
    const w = pool.workers[0].worker;
    expect(() => w.onmessage({ data: { foo: 'bar' } })).not.toThrow();
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('onresize handler errors are caught and logged', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 2, lazy: false });
    pool._logger.error = vi.fn();
    pool.onresize = () => {
      throw new Error('boom resize');
    };
    // shrink pool to trigger resize path (reduce minSize first)
    pool.resize({ minSize: 1, maxSize: 1 });
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('logs queued dispatch failures when resumed work cannot be posted', async () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 20);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(SlowUnderlying, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      idleTimeout: 1000,
      taskQueue: true,
    });

    try {
      pool._logger.error = vi.fn();
      pool.pause();

      expect(pool.postMessage({ n: 1 })).toBe(true);
      expect(pool.postMessage({ n: 2 })).toBe(true);
      expect(pool.queue.length).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 30));
      pool.workers[0].worker.postMessage = vi.fn(() => {
        throw new Error('queued dispatch failed');
      });

      expect(() => pool.resume()).not.toThrow();
      expect(pool._logger.error).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });
});
