import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import WorkerAgnostic, { detectEnv } from '../src/helpers/WorkerAgnostic.js';

const ECHO_WORKER = fileURLToPath(new URL('./fixtures/echo.worker.js', import.meta.url));

describe('WorkerAgnostic', () => {
  describe('detectEnv', () => {
    it('resolves to "node" under vitest', () => {
      expect(detectEnv()).toBe('node');
    });
  });

  describe('node string source', () => {
    it('creates a real worker_threads worker and echoes messages', async () => {
      const w = new WorkerAgnostic(ECHO_WORKER, { type: 'module' });
      try {
        const received = await new Promise((resolve, reject) => {
          w.addEventListener('message', (e) => resolve(e.data));
          w.addEventListener('error', (e) => reject(e));
          w.postMessage({ hello: 'world' });
        });
        expect(received).toEqual({ echo: true, received: { hello: 'world' } });
      } finally {
        await w.terminate();
      }
    });

    it('normalizes the message payload into { data }', async () => {
      const w = new WorkerAgnostic(ECHO_WORKER, { type: 'module' });
      try {
        const payload = await new Promise((resolve, reject) => {
          w.on('message', (e) => resolve(e));
          w.on('error', (e) => reject(e));
          w.postMessage(42);
        });
        expect(payload).toHaveProperty('data');
        expect(payload.data).toEqual({ echo: true, received: 42 });
      } finally {
        await w.terminate();
      }
    });

    it('terminate() returns a Promise', async () => {
      const w = new WorkerAgnostic(ECHO_WORKER, { type: 'module' });
      const result = w.terminate();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeDefined();
    });
  });

  describe('node factory source', () => {
    it('invokes a factory function returning a worker-like object', async () => {
      const fake = {
        postMessage: vi.fn(),
        terminate: vi.fn(() => Promise.resolve(0)),
        addEventListener: vi.fn(),
      };
      const w = new WorkerAgnostic(() => fake);
      expect(w.worker).toBe(fake);
      w.postMessage({ a: 1 });
      expect(fake.postMessage).toHaveBeenCalledWith({ a: 1 });
      await w.terminate();
      expect(fake.terminate).toHaveBeenCalled();
    });

    it('constructs a class source with `new`', async () => {
      class FakeWorker {
        constructor() {
          this.postMessage = vi.fn();
          this.terminate = vi.fn(() => Promise.resolve(0));
        }
      }
      const w = new WorkerAgnostic(FakeWorker);
      expect(w.worker).toBeInstanceOf(FakeWorker);
      await w.terminate();
    });
  });

  describe('static create (transparent, unwrapped)', () => {
    it('returns the raw underlying worker, not a WorkerAgnostic', () => {
      const fake = { postMessage() {}, terminate() {} };
      const raw = WorkerAgnostic.create(() => fake);
      expect(raw).toBe(fake);
      expect(raw).not.toBeInstanceOf(WorkerAgnostic);
    });
  });

  describe('browser path (globalThis.Worker)', () => {
    let orig;
    beforeEach(() => {
      orig = globalThis.Worker;
    });
    afterEach(() => {
      globalThis.Worker = orig;
    });

    it('uses globalThis.Worker for string sources', () => {
      const instances = [];
      class FakeWorker {
        constructor(arg, opts) {
          this.arg = arg;
          this.opts = opts;
          this.postMessage = vi.fn();
          this.terminate = vi.fn();
          instances.push(this);
        }
      }
      globalThis.Worker = FakeWorker;
      const w = new WorkerAgnostic('some-worker.js', { type: 'module' });
      expect(instances).toHaveLength(1);
      expect(w.worker).toBe(instances[0]);
      expect(w.worker.arg).toBe('some-worker.js');
      w.terminate();
    });
  });

  describe('postMessage transfer list', () => {
    it('forwards a transfer array to the underlying worker', () => {
      const buffer = new ArrayBuffer(8);
      const fake = {
        postMessage: vi.fn(),
        terminate: vi.fn(() => Promise.resolve(0)),
      };
      const w = new WorkerAgnostic(() => fake);
      w.postMessage({ buf: buffer }, [buffer]);
      expect(fake.postMessage).toHaveBeenCalledWith({ buf: buffer }, [buffer]);
      return w.terminate();
    });

    it('forwards a { transfer } options object', () => {
      const buffer = new ArrayBuffer(8);
      const fake = {
        postMessage: vi.fn(),
        terminate: vi.fn(() => Promise.resolve(0)),
      };
      const w = new WorkerAgnostic(() => fake);
      w.postMessage({ buf: buffer }, { transfer: [buffer] });
      expect(fake.postMessage).toHaveBeenCalledWith({ buf: buffer }, [buffer]);
      return w.terminate();
    });
  });
});
