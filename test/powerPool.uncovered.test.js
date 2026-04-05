import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool uncovered branches', () => {
  it('onidle setter swallows thrown handlers and logs error', () => {
    // Use a minimal stub underlying to avoid actual worker behavior
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    pool.onidle = () => {
      throw new Error('boom onidle');
    };
    // setting when pool is already idle should invoke handler immediately
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('onidle setter swallows thrown handlers when pool has workers', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 1, lazy: false });
    pool._logger = { error: vi.fn(), log: () => {} };
    // pool has workers but no active tasks -> considered idle
    pool.onidle = () => {
      throw new Error('boom onidle2');
    };
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('getters for onmessage/onerror/onidle return underlying handlers', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    const m = () => {};
    const e = () => {};
    const i = () => {};
    pool._onmessage = m;
    pool._onerror = e;
    pool._onidle = i;
    expect(pool.onmessage).toBe(m);
    expect(pool.onerror).toBe(e);
    expect(pool.onidle).toBe(i);
  });

  it('getter for onresize returns underlying handler', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    const r = () => {};
    pool._onresize = r;
    expect(pool.onresize).toBe(r);
  });

  it('logs when bus.emit("idle") throws during _emitIdle', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    // make bus.emit throw when emitting 'idle'
    const origEmit = pool._bus.emit.bind(pool._bus);
    pool._bus.emit = (type, ev) => {
      if (type === 'idle') throw new Error('boom idle emit');
      return origEmit(type, ev);
    };
    // call internal emitter directly
    pool._emitIdle();
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('logs when bus.emit("message") throws during _emitIdle', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    // make bus.emit throw when emitting 'message'
    const origEmit = pool._bus.emit.bind(pool._bus);
    pool._bus.emit = (type, ev) => {
      if (type === 'message') throw new Error('boom message emit');
      return origEmit(type, ev);
    };
    pool._emitIdle();
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('setters for onmessage/onerror/onresize assign via property', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    const m = () => {};
    const e = () => {};
    const r = () => {};
    pool.onmessage = m;
    pool.onerror = e;
    pool.onresize = r;
    expect(pool._onmessage).toBe(m);
    expect(pool._onerror).toBe(e);
    expect(pool._onresize).toBe(r);
  });

  it('_emitIdle catches thrown _onmessage and _onidle handlers and logs errors', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    pool._onmessage = () => {
      throw new Error('boom onmessage internal');
    };
    pool._onidle = () => {
      throw new Error('boom onidle internal');
    };
    pool._emitIdle();
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('_reapIdleWorkers removes a single non-last worker via swap-and-pop without throwing', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, idleTimeout: 1 });
    // create multiple workers
    const w = pool.addWorker();
    // ensure underlying wrapper has a working postMessage
    w.worker.postMessage = vi.fn();
    pool.addWorker();
    pool.addWorker();
    const now = Date.now();
    // make only the middle worker idle beyond idleTimeout
    for (let i = 0; i < pool.workers.length; i++) {
      const w = pool.workers[i];
      if (i === 1) {
        w.tasks = 0;
        w.lastActive = now - 10000;
      } else {
        w.tasks = 1; // busy
        w.lastActive = now;
      }
    }
    expect(() => pool._reapIdleWorkers()).not.toThrow();
    expect(pool.workers.length).toBeLessThan(3);
  });

  it('stopThePressBatch clears reaper interval when recreateWorkers is false', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._reaperInterval = setInterval(() => {}, 10000);
    pool.stopThePressBatch([], { recreateWorkers: false });
    expect(pool._reaperInterval).toBeNull();
  });

  it('stopThePressBatch logs when terminating workers throws unexpectedly', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    // make workers.length readable but accessing an index throws inside the try
    const proxy = new Proxy(
      { length: 1, 0: { worker: { terminate: () => {} }, completedTasks: 0 } },
      {
        get(target, prop) {
          if (prop === 'length') return 1;
          if (String(prop) === '0') throw new Error('boom term');
          return Reflect.get(target, prop);
        },
      }
    );
    Object.defineProperty(pool, 'workers', {
      get: () => proxy,
      configurable: true,
    });
    pool.stopThePressBatch([], { recreateWorkers: false });
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('postMessageBatch logs when queue.pushMany throws', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 0 });
    pool._logger = { error: vi.fn(), log: () => {} };
    pool.taskQueueEnabled = true;
    pool.queue = {
      pushMany: () => {
        throw new Error('boom pushMany');
      },
    };
    pool.postMessageBatch([{ message: 'x' }]);
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('stopThePressBatch logs when queue.clear throws', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    pool.queue = {
      clear: () => {
        throw new Error('boom clear');
      },
    };
    pool.stopThePressBatch([], { recreateWorkers: false });
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('stopThePressBatch logs when pendingResponses.entries throws', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._logger = { error: vi.fn(), log: () => {} };
    pool._pendingResponses = {
      entries: () => {
        throw new Error('boom pending');
      },
    };
    pool.stopThePressBatch([], { recreateWorkers: false });
    expect(pool._logger.error).toHaveBeenCalled();
  });

  it('postMessageBatch handles _addWorkerInstance throwing and marks result false', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    // force worker creation path to throw
    pool._addWorkerInstance = () => {
      throw new Error('boom add');
    };
    const res = pool.postMessageBatch([{ message: 'x' }]);
    expect(res[0]).toBe(false);
  });

  it('postMessageBatch fallback to existing worker logs when fallback.postMessage throws', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    // ensure one existing worker to trigger fallback path
    const wobj = pool.addWorker();
    // make fallback worker.postMessage throw and force fallback path
    wobj.worker.postMessage = () => {
      throw new Error('boom fallback');
    };
    pool.taskQueueEnabled = false;
    pool._maxTasksPerWorker = 0;
    const res = pool.postMessageBatch([{ message: 'x' }]);
    expect(pool._logger.error).toHaveBeenCalled();
    expect(res[0]).toBe(false);
  });

  it('postMessageBatch fallback to existing worker success path updates worker state', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    const wobj = pool.addWorker();
    wobj._startTimes = [];
    // successful postMessage with transfer
    const pm = vi.fn();
    wobj.worker.postMessage = pm;
    pool.taskQueueEnabled = false;
    pool._maxTasksPerWorker = 0;
    const transfer = [new ArrayBuffer(1)];
    const res = pool.postMessageBatch([{ message: 'ok', transfer }]);
    expect(res[0]).toBe(true);
    expect(pm).toHaveBeenCalledWith('ok', transfer);
    expect(Array.isArray(wobj._startTimes) && wobj._startTimes.length).toBeTruthy();
  });

  it('postMessageBatch creates a new worker when pool can grow and succeeds', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    // stub _addWorkerInstance to create and register a worker
    pool._addWorkerInstance = () => {
      const o = { worker: { postMessage: vi.fn() }, tasks: 0, _startTimes: [], lastActive: 0 };
      pool.workers.push(o);
      return o;
    };
    const res = pool.postMessageBatch([{ message: 'new' }]);
    expect(res[0]).toBe(true);
  });

  it('postMessageBatch least-worker postMessage throwing marks result false', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    const w = pool.addWorker();
    // ensure least path is taken
    pool._maxTasksPerWorker = 1;
    w.worker.postMessage = () => {
      throw new Error('boom least');
    };
    const res = pool.postMessageBatch([{ message: 'x' }]);
    expect(res[0]).toBe(false);
  });

  it('postMessageBatch create-new-worker uses transfer when provided', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    // stub _addWorkerInstance to create and register a worker
    pool._addWorkerInstance = () => {
      const o = { worker: { postMessage: vi.fn() }, tasks: 0, _startTimes: [], lastActive: 0 };
      pool.workers.push(o);
      return o;
    };
    const transfer = [new ArrayBuffer(1)];
    const res = pool.postMessageBatch([{ message: 'new', transfer }]);
    expect(res[0]).toBe(true);
    // ensure new worker postMessage was called with transfer
    expect(pool.workers[0].worker.postMessage).toHaveBeenCalledWith('new', transfer);
  });

  it('postMessageBatch returns false when no workers and cannot grow', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 0 });
    pool._logger = { error: vi.fn(), log: () => {} };
    pool.taskQueueEnabled = false;
    const res = pool.postMessageBatch([{ message: 'nope' }]);
    expect(res[0]).toBe(false);
  });

  it('stopThePress clears reaper interval when recreateWorkers is false', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    pool._reaperInterval = setInterval(() => {}, 10000);
    pool.stopThePress('x', undefined, { recreateWorkers: false });
    expect(pool._reaperInterval).toBeNull();
  });

  it('postMessageBatch throws when items is not an array', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true });
    expect(() => pool.postMessageBatch('not-an-array')).toThrow();
  });

  it('postMessageBatch with awaitResponse defers to postMessage and returns Promises', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    // ensure a worker exists so postMessage awaitResponse can post
    const w = pool.addWorker();
    w.worker.postMessage = vi.fn();
    // use postMessageBatch with awaitResponse option; it should call postMessage per item
    const res = pool.postMessageBatch([{ message: { hello: 'p' } }], { awaitResponse: true });
    expect(res).toBeInstanceOf(Array);
    expect(typeof res[0].then).toBe('function');
  });

  it('postMessageBatch with workerId uses targeted worker find path', () => {
    function Stub() {}
    const pool = new PowerPool(Stub, { minSize: 0, lazy: true, maxSize: 1 });
    pool._logger = { error: vi.fn(), log: () => {} };
    const w = pool.addWorker();
    w.id = 'worker-1';
    const pm = vi.fn();
    w.worker.postMessage = pm;
    pool.postMessageBatch([{ message: 't' }], { workerId: 'worker-1' });
    expect(pm).toHaveBeenCalled();
  });
});
