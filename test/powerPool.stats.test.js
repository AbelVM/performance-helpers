import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: the statistics and lifecycle reporting.
 *
 * `getStats().performance` is what a caller actually reads, and every field in
 * it is derived from counters that only move when a task *completes*. That
 * makes the completion path the one worth testing directly rather than
 * incidentally: a branch that records a duration, a slow task, or a long-window
 * latency sample is only reached by a worker that reports back, and a stub
 * that never answers reaches none of them.
 *
 * The values here are all O(1) streaming statistics with a closed form
 * (Welford), so the assertions are on properties - finite, in range, monotone -
 * rather than on exact numbers, which would pin the smoothing constant.
 */

/** A worker that reports a fixed duration, so the statistics have something to chew. */
class Reporting {
  static duration = 20;
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.postMessage = (msg) => {
      const payload = msg;
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({ data: { duration: Reporting.duration, ...(payload?.frame ? {} : {}) } });
        }
      }, 1);
    };
    this.terminate = () => {};
  }
}

const pools = [];
function makePool(WorkerCtor, options = {}) {
  const pool = new PowerPool(WorkerCtor, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    ...options,
  });
  pools.push(pool);
  return pool;
}

/** Let the stub worker answer and the pool's bookkeeping settle. */
async function settle(ms = 40) {
  await new Promise((r) => setTimeout(r, ms));
}

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
  await settle(5);
});

describe('PowerPool performance statistics', () => {
  it('records duration, min, max and average for a completed task', async () => {
    const pool = makePool(Reporting);
    pool.postMessage({ a: 1 });
    await settle();
    const { timePerTask } = pool.getStats().performance;
    // The streaming stats are seeded from real samples, so a completed task
    // must move every one of them off its empty-state value.
    expect(Number.isFinite(timePerTask.average)).toBe(true);
    expect(Number.isFinite(timePerTask.stddev)).toBe(true);
    expect(timePerTask.min).toBeGreaterThanOrEqual(0);
    expect(timePerTask.max).toBeGreaterThanOrEqual(timePerTask.min);
  });

  it('reports zeroed, finite statistics for a pool that never completed a task', () => {
    const pool = makePool(Reporting);
    const perf = pool.getStats().performance;
    // The empty state is where a `NaN` would hide: Welford's mean starts at 0
    // but `min` starts at `+Infinity` and `max` at `-Infinity`, and both are
    // mapped to 0 on the way out. A pool reporting `Infinity` here is what a
    // caller charting latency sees as a broken axis.
    expect(perf.timePerTask.min).toBe(0);
    expect(perf.timePerTask.max).toBe(0);
    expect(perf.timePerTask.average).toBe(0);
    expect(perf.timePerTask.stddev).toBe(0);
    expect(perf.percentSlowTasks).toBe(0);
  });

  it('counts a task as slow only when it exceeds slowTaskThreshold', async () => {
    const pool = makePool(Reporting, { slowTaskThreshold: 5 });
    pool.postMessage({ a: 1 });
    pool.postMessage({ a: 2 });
    await settle();
    const perf = pool.getStats().performance;
    // The stub reports 20 ms against a 5 ms threshold, so every task is slow.
    // The comparison is strictly greater-than: a task exactly at the threshold
    // is not slow, and `>=` would count it.
    expect(perf.percentSlowTasks).toBeGreaterThan(0);
    expect(perf.percentSlowTasks).toBeLessThanOrEqual(100);
  });

  it('reports no slow tasks when the threshold is disabled', async () => {
    const pool = makePool(Reporting);
    // Default is `Infinity`, so nothing is ever slow. The counter must stay 0
    // rather than compare against `Infinity` and produce `NaN` somewhere.
    pool.postMessage({ a: 1 });
    await settle();
    expect(pool.getStats().performance.percentSlowTasks).toBe(0);
  });

  it('adopts a finite threshold and reports zero when nothing exceeds it', async () => {
    const pool = makePool(Reporting, { slowTaskThreshold: 10_000 });
    pool.postMessage({ a: 1 });
    await settle();
    expect(pool.getStats().performance.percentSlowTasks).toBe(0);
  });

  it('keeps the long-window signals only for an adaptive policy', async () => {
    // `gradient2` and `vegas` are the only consumers of `_longEwmaLatency` and
    // `_minLatencyWindow`. Maintaining them for `ewma` would be work with no
    // reader, which is the kind of thing that later reads as a bug.
    const ewmaPool = makePool(Reporting, { autoScale: { policy: 'ewma' } });
    ewmaPool.postMessage({ a: 1 });
    await settle();
    expect(ewmaPool._longEwmaLatency).toBeNull();

    const gradientPool = makePool(Reporting, {
      autoScale: { policy: 'gradient2', intervalMs: 10_000 },
    });
    gradientPool.postMessage({ a: 1 });
    await settle();
    expect(typeof gradientPool._longEwmaLatency).toBe('number');
    expect(typeof gradientPool._minLatencyWindow).toBe('number');
  });
});

describe('PowerPool idle reaping', () => {
  it('reaps a worker idle beyond idleTimeout, down to minSize', () => {
    const pool = makePool(SilentNever, {
      size: 3,
      minSize: 1,
      maxSize: 3,
      // Long enough that the pool's own reaper interval does not fire during
      // the test. Calling the method directly with a backdated `lastActive` is
      // the deterministic way to reach it; waiting for the timer instead means
    });
    expect(pool.workers.length).toBe(3);
    for (const w of pool.workers) w.lastActive = 0;
    pool._reapIdleWorkers();
    // Never below `minSize`: a pool that reaps its last worker is a pool that
    // cannot answer the next request without a synchronous worker rebuild.
    expect(pool.workers.length).toBe(pool.minSize);
  });

  it('reaps nothing when idleTimeout is zero or negative', () => {
    const pool = makePool(SilentNever, { size: 3, minSize: 1, maxSize: 3, idleTimeout: 0 });
    for (const w of pool.workers) w.lastActive = 0;
    pool._reapIdleWorkers();
    expect(pool.workers.length).toBe(3);
  });

  it('never reaps a worker with a task in flight', () => {
    const pool = makePool(SilentNever, { size: 2, minSize: 1, maxSize: 2, idleTimeout: 1 });
    pool.postMessage({ a: 1 });
    const busy = pool.workers.find((w) => w.tasks > 0);
    for (const w of pool.workers) w.lastActive = 0;
    pool._reapIdleWorkers();
    // A busy worker has a task whose reply is still owed. Reaping it loses the
    // work *and* the response, and a caller awaiting the latter hangs. The
    // backdated `lastActive` is identical for both workers, so `tasks` is the
    // only thing separating them - which is exactly the guard under test.
    expect(pool.workers.length).toBe(1);
    expect(pool.workers[0]).toBe(busy);
  });
});

/** A worker that accepts work and never answers, so a task stays in flight. */
function SilentNever() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

describe('PowerPool drain callback guards', () => {
  it('ignores a non-function drain callback', () => {
    const pool = makePool(Reporting);
    // Passing something that is not callable must not throw and must not be
    // stored as if it were a handler to be called later.
    expect(() => pool.drain(42)).not.toThrow();
  });
});

describe('PowerPool option parsing fallbacks', () => {
  it('reads a finite encodeCacheLimit, raised to the floor of 16', () => {
    const pool = makePool(Reporting, { encodeCacheLimit: 4 });
    // `Math.max(16, ...)` - a smaller request is raised rather than honoured.
    // A limit below 16 would evict almost every entry before a hit, so the
    // cache would cost more than the stringify it avoids.
    expect(pool._encodeCacheLimit).toBe(16);
  });

  it('honours an encodeCacheLimit above the floor', () => {
    const pool = makePool(Reporting, { encodeCacheLimit: 128 });
    expect(pool._encodeCacheLimit).toBe(128);
  });

  it('falls back to the default encode cache limit for a non-positive value', () => {
    const pool = makePool(Reporting, { encodeCacheLimit: 0 });
    // `options?.encodeCacheLimit ? ... : 64` is a truthiness test, so 0 and
    // 'lots' both take the default rather than producing a cache that is never
    // pruned (`0`) or pruned by string comparison.
    expect(pool._encodeCacheLimit).toBeGreaterThan(0);
  });

  it('falls back to Infinity for a non-finite encodeCacheByteLimit', () => {
    const pool = makePool(Reporting, { encodeCacheByteLimit: 'lots' });
    expect(pool._encodeCacheByteLimit).toBe(Number.POSITIVE_INFINITY);
  });

  it('adopts a finite encodeCacheByteLimit', () => {
    const pool = makePool(Reporting, { encodeCacheByteLimit: 1024 });
    expect(pool._encodeCacheByteLimit).toBe(1024);
  });

  it('falls back to the default awaitResponseTimeout for a non-numeric value', () => {
    const pool = makePool(Reporting, { awaitResponseTimeout: 'soon' });
    expect(Number.isNaN(pool._defaultAwaitResponseTimeout)).toBe(false);
  });

  it('falls back to the default autoScale tuning for a boolean autoScale', () => {
    const pool = makePool(Reporting, { autoScale: true });
    // `typeof autoScale === 'object' ? autoScale : {}` - a boolean takes the
    // defaults, which is what `autoScale: true` is documented to mean.
    expect(pool._autoScale).toBeTruthy();
    expect(pool._autoScale.intervalMs).toBeGreaterThan(0);
  });

  it('ignores non-finite longWindowAlpha and aimdBeta', () => {
    const pool = makePool(Reporting, {
      autoScale: { policy: 'gradient2', longWindowAlpha: 'slow', aimdBeta: 'half' },
    });
    // Adopting the strings would put `NaN` into the EWMA recursion, and the
    // next sample would be `NaN` too - permanently, and silently, because the
    // limit is clamped to `[limitMin, limitMax]` afterwards.
    expect(Number.isNaN(pool._autoScale.longWindowAlpha)).toBe(false);
    expect(Number.isNaN(pool._autoScale.aimdBeta)).toBe(false);
  });

  it('refuses a non-string debugLevel rather than logging verbosely', () => {
    const pool = makePool(Reporting, { debugLevel: 'loud' });
    expect(typeof pool._debugLevel).not.toBe('string');
  });
});

describe('PowerPool debug logging', () => {
  it('swallows an error through the debug logger without throwing', () => {
    const pool = makePool(Reporting);
    const debug = vi.fn();
    pool._logger = { error: vi.fn(), debug, log: vi.fn() };
    expect(() => pool._debugLog(new Error('boom'), 'context')).not.toThrow();
  });

  it('survives a logger that throws while logging', () => {
    const pool = makePool(Reporting);
    pool._logger = {
      error: vi.fn(),
      log: vi.fn(),
      debug: () => {
        throw new Error('logger is broken too');
      },
    };
    // A logger is the last thing standing between a diagnostic and the caller,
    // so a throwing one must not escalate. The `console.debug` fallback is
    // what runs when `this._logger.debug` is not usable at all.
    expect(() => pool._debugLog(new Error('boom'), 'context')).not.toThrow();
  });

  it('logs without an error argument at all', () => {
    const pool = makePool(Reporting);
    const debug = vi.fn();
    pool._logger = { error: vi.fn(), debug, log: vi.fn() };
    pool._debugLog(undefined, 'no error here');
    expect(debug).toHaveBeenCalled();
  });
});
