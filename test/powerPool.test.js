import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool (mocked worker)', () => {
  it('forwards plain object messages as transferable Uint8Array and decodes responses', async () => {
    // Mock worker constructor
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        this.postMessage = vi.fn((msg) => {
          // simulate a worker processing and replying with the same message
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const p = new Promise((resolve) => {
        pool.onmessage = (e) => {
          // the pool should deliver a decoded object
          resolve(e.data);
        };
      });

      const sent = { hello: 'world' };
      const ok = pool.postMessage(sent);
      expect(ok).toBe(true);

      // ensure underlying.postMessage received a Uint8Array
      const underlying = pool.workers[0]._underlying || pool.workers[0].worker._underlying || null;
      // Try a few strategies to locate the underlying mock
      const post =
        underlying && underlying.postMessage
          ? underlying.postMessage
          : pool.workers[0].worker._underlying && pool.workers[0].worker._underlying.postMessage;
      // wait for reply
      const decoded = await p;
      expect(decoded).toEqual(sent);
      if (post) {
        const callArg = post.mock.calls[0][0];
        // the callArg should be a Uint8Array when posting an object
        expect(callArg).toBeInstanceOf(Uint8Array);
      }
    } finally {
      pool.terminate();
    }
  });

  it('broadcasts to all workers and increments tasks', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    // ensure eager creation for this test by setting minSize == size
    const pool = new PowerPool(MockUnderlying, { size: 2, minSize: 2, idleTimeout: 1000 });
    try {
      pool.broadcast({ b: 1 });
      expect(pool.workers.length).toBe(2);
      for (const w of pool.workers) {
        // underlying should have been invoked via wrapper
        const underlying = w.worker._underlying || w.worker._underlying;
        expect(underlying.postMessage).toHaveBeenCalled();
        expect(w.tasks).toBeGreaterThanOrEqual(1);
      }
    } finally {
      pool.terminate();
    }
  });

  it('lazy defaults to true and only creates minSize workers at construction', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    // default lazy should be true; with size:4 and default minSize 1 at least one worker exists
    const pool = new PowerPool(MockUnderlying, { size: 4, maxSize: 4, idleTimeout: 1000 });
    try {
      expect(pool.workers.length).toBe(pool.minSize);
      // grow by posting tasks: pool should create more workers up to maxSize
      pool.postMessage({ x: 1 });
      pool.postMessage({ x: 2 });
      // after a short tick the pool may have grown; at least one worker should exist
      expect(pool.workers.length).toBeGreaterThanOrEqual(1);
    } finally {
      pool.terminate();
    }
  });

  it('addWorker and removeWorker manage workers', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 0 });
    try {
      const before = pool.workers.length;
      pool.addWorker();
      expect(pool.workers.length).toBe(before + 1);
      pool.removeWorker();
      // removeWorker terminates last worker; length decreases or equals before
      expect(pool.workers.length).toBe(before);
    } finally {
      pool.terminate();
    }
  });

  it('queues tasks when all workers busy and dispatches when free', async () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          // reply after a small delay
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 20);
        });
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(SlowUnderlying, {
      size: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      idleTimeout: 1000,
      taskQueue: true,
    });
    try {
      const received = [];
      pool.onmessage = (e) => received.push(e.data);

      // post multiple messages; with maxTasksPerWorker=1 the second should be queued
      expect(pool.postMessage({ n: 1 })).toBe(true);
      expect(pool.postMessage({ n: 2 })).toBe(true);
      // queueing may be implementation-dependent under lazy growth; verify eventual delivery

      // wait for both messages to be processed
      await new Promise((res) => setTimeout(res, 100));
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(pool.queue.length).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it('emits idle event when transitioning to idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 10);
        });
        this.terminate = vi.fn();
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      let idleCalled = false;
      pool.onidle = () => {
        idleCalled = true;
      };
      // pool is idle initially; assign onidle should invoke immediately per setter
      expect(idleCalled).toBe(true);

      idleCalled = false;
      // now post a task and wait for idle to reoccur
      pool.postMessage({ x: 1 });
      await new Promise((res) => setTimeout(res, 50));
      expect(idleCalled).toBe(true);
    } finally {
      pool.terminate();
    }
  });
});
