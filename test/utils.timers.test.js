/**
 * `utils/timers.js` — one real timer per call.
 *
 * `setSafeTimeout` and `setSafeInterval` each asked a `_canUnref()` helper
 * whether the runtime's timer handle supports `unref`, and that helper
 * implemented the question by **calling `setTimeout` itself** — a throwaway
 * 0 ms timer, never cleared, per invocation. So every call allocated two
 * `Timeout` objects where one was wanted, and the 17 call sites in `src/` are
 * on the paths that call this in a loop: cache eviction sweeps, the pool idle
 * reaper, the backpressure refill, socket and websocket heartbeats, and
 * `PowerEventLoopMonitor._schedule` — the last of which created 100 wasted
 * timers a second at a 5 ms sample, in the code whose job is to measure the
 * loop.
 *
 * The assertion is a **count of allocations**, not a duration. Timing a
 * throwaway `setTimeout` is measuring the thing the test is trying to remove,
 * and this harness measures a ~28% median spread on a typical machine, so a
 * duration could not separate one timer from two reliably. A count is exact.
 *
 * The count is taken by replacing `globalThis.setTimeout` /
 * `globalThis.setInterval` with counting wrappers, which is the only place the
 * probe was observable from. It is restored in a `finally` so a failing
 * assertion cannot leave the global patched for the rest of the suite — a
 * consequence that has bitten this repo before, via `vi.stubGlobal('require')`
 * (see `AGENTS.md` on `WorkerAgnostic.js:47-65`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setSafeTimeout, setSafeInterval } from '../src/utils/timers.js';

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

/** @returns {{timeouts: () => number, intervals: () => number, restore: () => void}} */
function countTimerAllocations() {
  let timeouts = 0;
  let intervals = 0;
  globalThis.setTimeout = (/** @type {any} */ fn, /** @type {any} */ ms) => {
    timeouts += 1;
    return /** @type {any} */ (realSetTimeout(fn, ms));
  };
  globalThis.setInterval = (/** @type {any} */ fn, /** @type {any} */ ms) => {
    intervals += 1;
    return /** @type {any} */ (realSetInterval(fn, ms));
  };
  return {
    timeouts: () => timeouts,
    intervals: () => intervals,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
    },
  };
}

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
});

describe('utils/timers.js allocates one timer per call', () => {
  it('setSafeTimeout schedules exactly one timer, not two', () => {
    // The defect: 2 allocations per call (one real, one throwaway probe).
    const counter = countTimerAllocations();
    try {
      const handle = setSafeTimeout(() => {}, 10_000);
      clearTimeout(handle);
      expect(counter.timeouts()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  it('setSafeInterval schedules exactly one timer, not two', () => {
    // The interval path had the identical probe. It is asserted separately
    // from the one-shot case because a fix that only touched `setSafeTimeout`
    // would leave this arm of the defect in place.
    //
    // The count is over *both* allocators, and that detail is load-bearing.
    // This test originally counted only `setInterval` and passed with the
    // per-call probe reinstated, because `_canUnref()` asked its question by
    // calling `setTimeout` — so the interval path's throwaway timer was billed
    // to the other counter and the instrument could not see it. Found by
    // mutation, not by reading. The probe's cost is real either way; only the
    // accounting was wrong.
    const counter = countTimerAllocations();
    try {
      const handle = setSafeInterval(() => {}, 10_000);
      clearInterval(handle);
      expect(counter.timeouts() + counter.intervals()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  it('holds at 1.0x over a batch, not 2.0x', () => {
    // The row's own figure is a ratio over a large batch, so pin the ratio and
    // not a single call. A single-call assertion could be satisfied by a probe
    // that is somehow amortised away; this cannot.
    const counter = countTimerAllocations();
    const BATCH = 50;
    try {
      for (let i = 0; i < BATCH; i += 1) {
        clearTimeout(setSafeTimeout(() => {}, 10_000));
        clearInterval(setSafeInterval(() => {}, 10_000));
      }
      const allocated = counter.timeouts() + counter.intervals();
      expect(allocated).toBe(BATCH * 2);
    } finally {
      counter.restore();
    }
  });

  it('returns the real handle, so the caller can still clear it', () => {
    // Guards a plausible wrong fix: a helper that stops probing by returning
    // its own bookkeeping object rather than the platform's. Clearing has to
    // work, or every caller leaks.
    const handle = setSafeTimeout(() => {}, 10_000);
    expect(typeof handle).not.toBe('undefined');
    expect(() => clearTimeout(handle)).not.toThrow();
  });

  it('unrefs the handle it returns on Node', () => {
    // The behaviour the probe existed to preserve. `hasRef()` is the
    // observable: an unref'd timer reports false, and is what stops a bare
    // `PowerCache` from hanging a CLI.
    const handle = /** @type {any} */ (setSafeTimeout(() => {}, 10_000));
    if (typeof handle?.hasRef === 'function') {
      expect(handle.hasRef()).toBe(false);
    }
    clearTimeout(handle);
  });

  it('leaves the handle ref-ed when keepProcessAlive is set', () => {
    // The documented opt-out, and the one caller of this feature that exists:
    // a CLI awaiting a background flush. Asserted in the other direction from
    // the test above, because "always unref" would pass the first and fail
    // this one.
    const handle = /** @type {any} */ (
      setSafeTimeout(() => {}, 10_000, { keepProcessAlive: true })
    );
    if (typeof handle?.hasRef === 'function') {
      expect(handle.hasRef()).toBe(true);
    }
    clearTimeout(handle);
  });

  it('does not throw when the handle has no unref, as in a browser', () => {
    // `setTimeout` returns a DOM `number` there, so the check has to tolerate
    // a primitive. This also pins that the capability is read off the handle
    // rather than assumed: a helper that called `t.unref()` unconditionally
    // would throw on the browser build, which is a supported target.
    globalThis.setTimeout = /** @type {any} */ (() => 1);
    globalThis.setInterval = /** @type {any} */ (() => 2);
    expect(() => setSafeTimeout(() => {}, 10)).not.toThrow();
    expect(() => setSafeInterval(() => {}, 10)).not.toThrow();
  });

  it('does not touch the handle at all when keepProcessAlive is set', () => {
    // The browser shape again, but with the opt-out: the `keepProcessAlive`
    // branch must short-circuit before any capability check, so a handle with
    // no `unref` is fine here too.
    globalThis.setTimeout = /** @type {any} */ (() => 1);
    globalThis.setInterval = /** @type {any} */ (() => 2);
    expect(() => setSafeTimeout(() => {}, 10, { keepProcessAlive: true })).not.toThrow();
    expect(() => setSafeInterval(() => {}, 10, { keepProcessAlive: true })).not.toThrow();
  });
});
