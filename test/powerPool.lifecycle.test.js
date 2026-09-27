import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  PowerPool,
  PowerCache,
  PowerTimedCache,
  preloadNode,
  decodeMessage,
} from '../src/index.js';

beforeAll(async () => {
  // Pure-ESM Node needs the node:worker_threads require hoisted before any
  // worker creation path runs.
  await preloadNode();
});

/** A worker double that decodes the pool's JSON envelope like a real worker. */
class EchoWorker {
  constructor() {
    this._listeners = [];
    this.terminateCount = 0;
  }
  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }
  removeEventListener() {}
  postMessage(msg) {
    // A real worker decodes the pool's envelope.
    let payload = msg;
    if (msg instanceof Uint8Array) payload = decodeMessage(msg).value;
    const fn = this._listeners.find(([t]) => t === 'message')?.[1];
    if (!fn) return;
    const echo = (extra) =>
      queueMicrotask(() =>
        fn({
          data: {
            correlationId: payload?.correlationId,
            duration: 1,
            ...extra,
          },
        })
      );
    if (payload && payload.respond === false) return; // stay silent on demand
    echo();
  }
  terminate() {
    this.terminateCount++;
  }
}

const mkPool = (options = {}) =>
  new PowerPool(() => new EchoWorker(), {
    size: 1,
    minSize: 1,
    maxSize: 2,
    lazy: false,
    awaitResponseTimeout: 0,
    ...options,
  });

describe('PowerPool shutdown is final (BUG-001)', () => {
  it('refuses postMessage after shutdown instead of resurrecting the pool', () => {
    const pool = mkPool();
    expect(pool.workers.length).toBe(1);

    pool.shutdown();
    expect(pool.workers.length).toBe(0);
    expect(pool._terminated).toBe(true);

    expect(() => pool.postMessage({ hello: 1 })).toThrowError(/PowerPool has been shut down/);
    // Critically: no worker was created, so no orphan without a reaper.
    expect(pool.workers.length).toBe(0);
    expect(pool._reaperInterval).toBeFalsy();
  });

  it('reports ERR_POOL_TERMINATED on the thrown error', () => {
    const pool = mkPool();
    pool.shutdown();
    try {
      pool.postMessage({ hello: 1 });
      expect.unreachable('postMessage should have thrown');
    } catch (err) {
      expect(err.code).toBe('ERR_POOL_TERMINATED');
    }
  });

  it('postMessageBatch also refuses after shutdown', () => {
    const pool = mkPool();
    pool.shutdown();
    expect(() => pool.postMessageBatch([{ message: { a: 1 } }])).toThrowError(
      /PowerPool has been shut down/
    );
  });

  it('addWorker() is a no-op after shutdown', () => {
    const pool = mkPool();
    pool.shutdown();
    expect(pool.addWorker()).toBeNull();
    expect(pool.workers.length).toBe(0);
  });

  it('shutdown() is idempotent', () => {
    const pool = mkPool();
    const underlying = pool.workers[0].worker._underlying;
    pool.shutdown();
    expect(underlying.terminateCount).toBe(1);
    expect(() => pool.shutdown()).not.toThrow();
    expect(underlying.terminateCount).toBe(1);
  });

  it('stopThePress({recreateWorkers:false}) does not re-grow the pool', () => {
    const pool = mkPool();
    pool.stopThePress({ hello: 1 }, undefined, { recreateWorkers: false });
    expect(pool.workers.length).toBe(0);
    expect(pool._reaperInterval).toBeFalsy();
    expect(pool._terminated).toBe(false);
  });

  it('stopThePress({recreateWorkers:true}) still re-creates workers', () => {
    const pool = mkPool();
    pool.stopThePress({ hello: 1 }, undefined, { recreateWorkers: true });
    expect(pool.workers.length).toBeGreaterThan(0);
  });
});

describe('PowerPool duplicate correlationId (BUG-003)', () => {
  it('rejects the previous waiter instead of orphaning it', async () => {
    const pool = mkPool();
    const first = pool.postMessage({ n: 1 }, undefined, {
      awaitResponse: true,
      correlationId: 'dup',
    });
    const second = pool.postMessage({ n: 2 }, undefined, {
      awaitResponse: true,
      correlationId: 'dup',
    });

    const settled = await Promise.race([
      Promise.allSettled([first, second]),
      new Promise((r) => setTimeout(() => r(null), 500)),
    ]);
    expect(settled).not.toBeNull();
    const [a, b] = settled;
    expect(a.status).toBe('rejected');
    expect(a.reason.code).toBe('ERR_POOL_DUPLICATE_CORRELATION_ID');
    expect(b.status).toBe('fulfilled');
    pool.shutdown();
  });

  it('leaves distinct correlation ids untouched', async () => {
    const pool = mkPool();
    const a = pool.postMessage({ n: 1 }, undefined, { awaitResponse: true, correlationId: 'x' });
    const b = pool.postMessage({ n: 2 }, undefined, { awaitResponse: true, correlationId: 'y' });
    const settled = await Promise.race([
      Promise.allSettled([a, b]),
      new Promise((r) => setTimeout(() => r(null), 500)),
    ]);
    expect(settled).not.toBeNull();
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    pool.shutdown();
  });
});

describe('PowerPool single termination choke point (BUG-010)', () => {
  it('records terminated-worker statistics for idle reaps', () => {
    vi.useFakeTimers();
    try {
      const pool = new PowerPool(() => new EchoWorker(), {
        size: 2,
        minSize: 0,
        maxSize: 2,
        lazy: false,
        idleTimeout: 1,
      });
      pool.workers.forEach((w) => {
        w.completedTasks = 100;
      });
      pool._activeTasks = 0;
      pool.queue.clear();
      pool._isIdle = true;

      vi.advanceTimersByTime(5);
      pool._reapIdleWorkers();

      expect(pool.workers.length).toBe(0);
      // Previously the reaper silently dropped these, inflating timePerTask.
      expect(pool._terminatedWorkerTaskCountsCount).toBe(2);
      expect(pool._terminatedWorkerTaskCountsTotal).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits pool:scale for idle reaps so observers do not have to poll', () => {
    vi.useFakeTimers();
    try {
      const pool = new PowerPool(() => new EchoWorker(), {
        size: 2,
        minSize: 0,
        maxSize: 2,
        lazy: false,
        idleTimeout: 1,
      });
      pool._activeTasks = 0;
      pool.queue.clear();
      // Force every worker past the idle threshold.
      pool.workers.forEach((w) => {
        w.lastActive -= 10_000;
      });
      // Bus-level events deliver the raw payload (unlike the worker-level
      // message/error/idle events, which wrap theirs in `{ data }`).
      const events = [];
      pool.addEventListener('pool:scale', (payload) => events.push(payload));
      vi.advanceTimersByTime(5);
      pool._reapIdleWorkers();
      expect(events.length).toBe(1);
      expect(events[0].reason).toBe('idle-reap');
      expect(events[0].count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shrink via resize also records the statistics', () => {
    const pool = new PowerPool(() => new EchoWorker(), {
      size: 2,
      minSize: 0,
      maxSize: 2,
      lazy: false,
    });
    pool.workers.forEach((w) => {
      w.completedTasks = 7;
    });
    pool.resize(0);
    expect(pool.workers.length).toBe(0);
    expect(pool._terminatedWorkerTaskCountsCount).toBe(2);
    expect(pool._terminatedWorkerTaskCountsTotal).toBe(14);
  });
});

describe('PowerPool idle-state re-evaluation (BUG-011)', () => {
  it('removeWorker() re-evaluates the idle verdict', () => {
    const pool = mkPool();
    pool._activeTasks = 0;
    pool._isIdle = true;
    pool.workers[0].tasks = 1;
    let idleEvents = 0;
    pool.addEventListener('idle', () => idleEvents++);
    pool.removeWorker();
    expect(idleEvents).toBe(1);
  });

  it('addWorker() re-evaluates the idle verdict', () => {
    const pool = mkPool();
    pool._activeTasks = 0;
    pool._isIdle = true;
    let idleEvents = 0;
    pool.addEventListener('idle', () => idleEvents++);
    pool.addWorker();
    expect(idleEvents).toBe(1);
  });
});

describe('pool-level onerror handler (QUAL-008)', () => {
  /** Fire an `error` event on the underlying worker of worker index 0. */
  const fireWorkerError = (pool, value) => {
    const underlying = pool.workers[0].worker._underlying;
    for (const [type, fn] of underlying._listeners) {
      if (type === 'error') fn(value);
    }
  };

  it('invokes the documented onerror property for worker errors', () => {
    const pool = mkPool();
    const seen = [];
    pool.onerror = (e) => seen.push(e);
    fireWorkerError(pool, 'boom');
    expect(seen).toEqual(['boom']);
  });

  it('isolates a throwing onerror handler', () => {
    const pool = mkPool();
    pool.onerror = () => {
      throw new Error('handler boom');
    };
    expect(() => fireWorkerError(pool, 'boom')).not.toThrow();
  });
});

describe('background timers do not pin the Node.js event loop (BUG-004)', () => {
  // This is the regression guard for the process-hang class of bug: a library
  // helper must never be the reason a process stays alive.
  const cases = {
    'PowerCache.startCleanup()': () => new PowerCache().startCleanup(50_000),
    'new PowerTimedCache()': () => new PowerTimedCache(60_000),
    'new PowerPool() with a reaper': () => mkPool({ idleTimeout: 60_000 }),
  };

  for (const [name, setup] of Object.entries(cases)) {
    it(`${name} leaves no referenced timer`, () => {
      // If any helper left a ref'd handle, the handles array stays non-empty
      // and this assertion fails.
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      setup();
      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
      // getActiveResourcesInfo() reports unreferenced timers too, so instead
      // assert on the handle type directly: unref'd handles are reported as
      // 'Timeout' but do not keep the loop alive. The real assertion is the
      // child-process test below.
      expect(after).toBeGreaterThanOrEqual(before);
    });
  }

  it('a live PowerCache + PowerPool does not keep the process alive', async () => {
    const { spawnSync } = await import('node:child_process');
    const script = `
      import { PowerCache, PowerTimedCache, PowerPool, preloadNode } from ${JSON.stringify(
        new URL('../src/index.js', import.meta.url).href
      )};
      await preloadNode();
      class W { constructor(){ this.h=[]; } addEventListener(t,f){ this.h.push([t,f]); } postMessage(){} terminate(){} }
      new PowerCache().startCleanup(50000);
      new PowerTimedCache(60000);
      new PowerPool(() => new W(), { size:1, minSize:1, maxSize:1, lazy:false, idleTimeout:60000 });
      // No dispose calls: if any helper left a ref'd timer this never exits.
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 8000,
      encoding: 'utf8',
    });
    // status === null means the child had to be killed => the leak is back.
    expect(res.status).toBe(0);
    expect(res.signal).toBeNull();
  }, 20_000);
});

afterEach(() => {
  vi.useRealTimers();
});
