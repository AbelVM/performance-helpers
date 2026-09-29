import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: worker retirement and pending-response cleanup.
 *
 * Both of these are places where a mistake is invisible from inside the test
 * that made it. A retired worker leaves a pending response unsettled, and the
 * caller waiting on it hangs with no error and no timeout. Cleanup that runs
 * twice resolves a promise twice, which most code swallows and the rest turns
 * into an unhandled rejection. So every case here asserts on the *settlement*
 * of the promise, not on an internal flag.
 */

/** A worker that accepts work and never answers. */
function Silent() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}, WorkerCtor = Silent) {
  const pool = new PowerPool(WorkerCtor, {
    size: 1,
    minSize: 1,
    maxSize: 3,
    lazy: false,
    ...options,
  });
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

describe('PowerPool worker retirement', () => {
  it('returns null when asked to retire nothing', () => {
    const pool = makePool();
    // `_terminateWorker(null)` is reachable from the resize and reaper loops,
    // where a stale index can name a worker that is already gone. Returning
    // `null` rather than throwing is what lets those loops stay simple.
    expect(pool._terminateWorker(null)).toBeNull();
  });

  it('reports the retired id so the caller can attribute it', () => {
    const pool = makePool();
    const id = pool._terminateWorker(pool.workers[0], 'test');
    expect(id).toBe(pool.workers[0].id);
  });

  it('does not settle a pending response when its worker is retired', async () => {
    const pool = makePool({ size: 1, maxSize: 1, awaitResponseTimeout: 30 });
    // `_terminateWorker` acknowledges that the response "will never arrive"
    // and drops the task from the global counter — but it does not reject the
    // caller's promise. So the caller waits out the whole `awaitResponseTimeout`
    // instead of being told at once, and with `awaitResponseTimeout: Infinity`
    // (a legal value, since timing options allow it) it waits forever. Every
    // other path that abandons a pending response — queue eviction, post
    // failure, shutdown — rejects it.
    //
    // Pinned as-is. Rejecting on retirement is the obviously right behaviour
    // and is a contract change, so it is a decision rather than a tidy-up.
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    pool._terminateWorker(pool.workers[0], 'test');
    await expect(pending).rejects.toThrow();
  });

  it('does not double-count tasks when a busy worker is retired', () => {
    const pool = makePool({ size: 1, maxSize: 1 });
    pool.postMessage({ a: 1 });
    expect(pool.workers[0].tasks).toBe(1);
    pool._terminateWorker(pool.workers[0], 'test');
    // The task counter is global. If retirement left it at 1 the pool would
    // report itself busy forever and every later `idle` would never fire.
    expect(pool.workers[0].tasks).toBe(0);
    expect(pool.getStats().activeTasks).toBe(0);
  });

  it('rejects every pending response at shutdown', async () => {
    const pool = makePool({ size: 1, maxSize: 1 });
    const a = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    const b = pool.postMessage({ b: 2 }, undefined, { awaitResponse: true });
    pool.terminate();
    // Both must settle. A shutdown that leaves one pending is a process that
    // cannot exit, because the pending timer is still armed.
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
  });
});

describe('PowerPool pending response cleanup', () => {
  it('resolves with the supplied value', async () => {
    const pool = makePool();
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    const key = [...pool._pendingResponses.keys()].pop();
    pool._cleanupPendingResponse(key, { resolveWith: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('is a no-op for a key that is not pending', () => {
    const pool = makePool();
    // The cleanup runs from several call sites - queue eviction, post failure,
    // shutdown - and any of them can fire twice. Reporting `false` rather than
    // throwing is what makes the second call harmless.
    expect(pool._cleanupPendingResponse('never-registered', { resolveWith: 1 })).toBe(false);
  });

  it('leaves nothing pending after a cleanup', async () => {
    const pool = makePool();
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    const key = [...pool._pendingResponses.keys()].pop();
    pool._cleanupPendingResponse(key, { rejectWith: new Error('gone') });
    await expect(pending).rejects.toThrow('gone');
    // The entry is deleted, so a later cleanup cannot settle it a second time.
    expect(pool._pendingResponses.has(String(key))).toBe(false);
    expect(pool._cleanupPendingResponse(key, { resolveWith: 'late' })).toBe(false);
  });

  it('clears the armed timeout so the pool can exit', async () => {
    const pool = makePool({ awaitResponseTimeout: 60_000 });
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    const key = [...pool._pendingResponses.keys()].pop();
    const entry = pool._pendingResponses.get(String(key));
    expect(entry.timer).toBeTruthy();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    pool._cleanupPendingResponse(key, { resolveWith: 1 });
    // An uncancelled 60-second timer keeps the event loop alive: a resolved
    // response is not enough, the handle has to go with it.
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    await expect(pending).resolves.toBe(1);
  });

  it('resolves a response delivered by the worker', async () => {
    class Replier {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          // Echo the framed payload back. The pool decodes it and matches on
          // the `correlationId` it attached, so a hand-built reply object would
          // never be recognised as this pool's answer.
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 1);
        };
        this.terminate = () => {};
      }
    }
    const pool = makePool({}, Replier);
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    await expect(pending).resolves.toBeTruthy();
  });
});

describe('PowerPool targeted dispatch', () => {
  it('fails fast for a worker id that does not exist', () => {
    const pool = makePool();
    // Targeting a missing worker must not fall back to round-robin. Routing
    // the task somewhere else is the failure mode: the caller asked for a
    // specific worker and silently got a different one.
    expect(pool.postMessage({ a: 1 }, undefined, { workerId: 'nope' })).toBe(false);
  });

  it('rejects a pending response for a missing target worker', async () => {
    const pool = makePool();
    const pending = pool.postMessage({ a: 1 }, undefined, {
      workerId: 'nope',
      awaitResponse: true,
    });
    await expect(pending).rejects.toThrow(/targeted worker unavailable/);
  });

  it('fails fast for a target worker that is at capacity', async () => {
    const pool = makePool({ size: 1, maxSize: 1, maxTasksPerWorker: 1 });
    const id = pool.workers[0].id;
    pool.postMessage({ a: 1 });
    // The worker is busy, so there is nowhere to put this. Queuing it would
    // be the wrong answer for a *targeted* dispatch - the caller named a
    // worker, and a different one is not it.
    expect(pool.postMessage({ b: 2 }, undefined, { workerId: id })).toBe(false);
  });
});

describe('PowerPool pool growth failure', () => {
  /** A factory that fails only once the pool tries to grow past its first worker. */
  let failGrowth;
  function Growable() {
    if (failGrowth) {
      const err = new Error('cannot spawn another worker');
      failGrowth = false;
      throw err;
    }
    Silent.call(this);
  }

  it('rejects a pending response when growing the pool fails', async () => {
    const pool = makePool({ size: 1, minSize: 1, maxSize: 4, maxTasksPerWorker: 1 }, function () {
      return new Growable();
    });
    // `maxTasksPerWorker: 1` is what forces the second post to grow: with the
    // default of Infinity the existing worker absorbs everything and no growth
    // is ever attempted, so the failure path is unreachable.
    pool.postMessage({ occupy: true });
    failGrowth = true;
    // Growing is how a saturated pool absorbs work. If that fails, the task has
    // nowhere to go and the caller is waiting on a reply that cannot arrive -
    // so the Promise must reject rather than linger.
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    await expect(pending).rejects.toThrow(/cannot spawn another worker/);
  });

  it('reports false when growing fails for a non-awaiting caller', () => {
    const pool = makePool({ size: 1, minSize: 1, maxSize: 4, maxTasksPerWorker: 1 }, function () {
      return new Growable();
    });
    pool.postMessage({ occupy: true });
    failGrowth = true;
    // The non-Promise path has no promise to reject, so the only way to report
    // the failure is the documented `false`.
    expect(pool.postMessage({ a: 1 })).toBe(false);
  });
});

describe('PowerPool debug log fallbacks', () => {
  it('stays silent when the logger has no debug method', () => {
    const pool = makePool();
    const consoleDebug = vi.fn();
    pool._logger = { error: vi.fn(), log: vi.fn() };
    const original = console.debug;
    console.debug = consoleDebug;
    try {
      pool._debugLog(new Error('boom'), 'context');
    } finally {
      console.debug = original;
    }
    // A logger with no `debug` means debug logging is off, and the console
    // fallback must not override that by writing anyway. The fallback exists
    // for a *throwing* logger, not a missing one.
    expect(consoleDebug).not.toHaveBeenCalled();
  });

  it('falls back to console.debug when the logger debug method throws', () => {
    const pool = makePool();
    const consoleDebug = vi.fn();
    pool._logger = {
      error: vi.fn(),
      log: vi.fn(),
      debug: () => {
        throw new Error('logger is broken too');
      },
    };
    const original = console.debug;
    console.debug = consoleDebug;
    try {
      pool._debugLog(new Error('boom'), 'context');
    } finally {
      console.debug = original;
    }
    // A throwing logger is not a reason to lose the diagnostic: the console is
    // the floor beneath the pool's own logger.
    expect(consoleDebug).toHaveBeenCalled();
  });

  it('does not throw when neither the logger nor console is usable', () => {
    const pool = makePool();
    pool._logger = {
      error: vi.fn(),
      log: vi.fn(),
      debug: () => {
        throw new Error('logger is broken too');
      },
    };
    const original = console.debug;
    console.debug = undefined;
    try {
      expect(() => pool._debugLog(new Error('boom'), 'context')).not.toThrow();
    } finally {
      console.debug = original;
    }
  });
});
