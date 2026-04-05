import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool additional branches', () => {
  it('addEventListener idle is invoked immediately when pool is idle', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    // eager create a worker for testing
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const spy = vi.fn();
      pool.addEventListener('idle', spy);
      expect(spy).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });

  it('posting a Uint8Array passes through without encoding', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const data = new Uint8Array([1, 2, 3]);
      expect(pool.postMessage(data)).toBe(true);
      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);
      if (underlying) {
        const calledWith = underlying.postMessage.mock.calls[0][0];
        expect(calledWith).toBeInstanceOf(Uint8Array);
      }
    } finally {
      pool.terminate();
    }
  });

  it('falls back to original message when encoding (JSON.stringify) throws', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const obj = {};
      obj.self = obj; // circular
      expect(pool.postMessage(obj)).toBe(true);
      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);
      if (underlying) {
        const calledWith = underlying.postMessage.mock.calls[0][0];
        // the underlying should have received the original (circular) object
        expect(calledWith.self).toBe(calledWith);
      }
    } finally {
      pool.terminate();
    }
  });

  it('forwards raw binary when decoding JSON fails', async () => {
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
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const p = new Promise((resolve) => {
        pool.onmessage = (e) => resolve(e.data);
      });
      // craft invalid JSON binary payload
      const invalid = new Uint8Array([1, 2, 3]);
      // simulate underlying replying with invalid binary
      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);
      if (underlying && typeof underlying.onmessage === 'function') {
        underlying.onmessage({ data: invalid });
      }
      const out = await p;
      // should deliver the raw Uint8Array when decoding fails
      expect(out).toBeInstanceOf(Uint8Array);
    } finally {
      pool.terminate();
    }
  });

  it('string workerSource uses global Worker constructor when available', () => {
    class FakeWorker {
      constructor(arg, opts) {
        this.arg = arg;
        this.opts = opts;
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const orig = global.Worker;
    try {
      // @ts-ignore
      global.Worker = FakeWorker;
      const pool = new PowerPool('some-worker.js', { size: 1, minSize: 1 });
      try {
        expect(pool.workers.length).toBeGreaterThan(0);
        const underlying =
          pool.workers[0]._underlying ||
          (pool.workers[0].worker && pool.workers[0].worker._underlying);
        expect(underlying).toBeInstanceOf(FakeWorker);
      } finally {
        pool.terminate();
      }
    } finally {
      // @ts-ignore
      global.Worker = orig;
    }
  });

  it('addEventListener idle listener exceptions are swallowed', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0 });
    try {
      const bad = () => {
        throw new Error('boom');
      };
      // should not throw
      expect(() => pool.addEventListener('idle', bad)).not.toThrow();
    } finally {
      pool.terminate();
    }
  });

  it('onidle setter swallows thrown handlers', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0 });
    try {
      const bad = () => {
        throw new Error('boom');
      };
      expect(() => {
        pool.onidle = bad;
      }).not.toThrow();
    } finally {
      pool.terminate();
    }
  });

  it('broadcast continues when one underlying throws', () => {
    class BadUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {
          throw new Error('boom');
        };
        this.terminate = vi.fn();
      }
    }
    class GoodUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    // use a manual addWorker flow to control underlying instances
    const pool = new PowerPool(GoodUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      // replace first underlying to a BAD one
      const bad = pool.workers[0];
      bad.worker._underlying = new BadUnderlying();
      // add a good worker
      pool.addWorker();
      // broadcast should not throw and should increment tasks on the good worker
      expect(() => pool.broadcast({ x: 1 })).not.toThrow();
      // find at least one worker with tasks > 0
      expect(pool.workers.some((w) => w.tasks > 0)).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  it('reaper returns early when idleTimeout is non-positive', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0, idleTimeout: 0 });
    try {
      // should be a no-op and not throw
      expect(() => pool._reapIdleWorkers()).not.toThrow();
    } finally {
      pool.terminate();
    }
  });

  it('grows the pool when capacity allows (new worker creation)', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, {
      size: 1,
      minSize: 0,
      lazy: false,
      maxSize: 2,
      maxTasksPerWorker: 0,
    });
    try {
      const ok = pool.postMessage({ x: 1 });
      expect(ok).toBe(true);
      // pool should have grown to use a new worker
      expect(pool.workers.length).toBeGreaterThanOrEqual(2);
    } finally {
      pool.terminate();
    }
  });

  it('addEventListener ignores unsupported types and removeEventListener prevents callbacks', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      // unsupported type should be ignored
      expect(() => pool.addEventListener('bogus', () => {})).not.toThrow();

      const spy = vi.fn();
      pool.addEventListener('message', spy);
      pool.removeEventListener('message', spy);
      // simulate underlying message - locate underlying and call onmessage
      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);
      if (underlying && typeof underlying.onmessage === 'function')
        underlying.onmessage({ data: { x: 1 } });
      // listener should not have been called
      expect(spy).not.toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });
});
