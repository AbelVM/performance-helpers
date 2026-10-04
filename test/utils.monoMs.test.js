import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { monoMs, nowMs } from '../src/utils/now.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerCron } from '../src/helpers/powerCron.js';

// RES-019: a monotonic clock for the helpers that only ever subtract.
//
// **The defect, measured first.** `nowMs()` is two clock reads, and the second
// exists only to notice that the high-resolution source has diverged from the
// wall clock. Within a second it passes and the reading tracks `performance`.
// Step the wall clock by more than a second and the guard fails, so from that
// moment the helper reads `Date.now()` instead - which means an NTP adjustment
// silently becomes elapsed time inside a rate limiter. Both measurements below
// were taken with **zero** real milliseconds passing, only the wall clock moved,
// and both are asserted here as they behaved *before* the fix:
//
//   PowerGCRA  available() 0 -> 2, and tryConsume() admitted. `2` is
//              `_ceiling()`, so that is the whole burst, granted.
//   PowerCircuit  open -> half-open after a 60 s step, so a dependency that had
//              been failing for a millisecond was offered a trial call.
//
// **Forward, not backward.** The obvious reading is that a backward step is the
// dangerous one, and it is the reverse: `PowerGCRA`'s `Math.max(now, _tat)`
// clamp and `PowerCircuit`'s `nowMs() - _openedAt < _openWindowMs` comparison
// both keep reading an earlier instant as "not much time has passed". It is the
// jump *forward* that hands out budget nobody spent. Every assertion here uses
// a forward step for that reason.
//
// **Counters and shapes, never durations** (TEST-001). A wall-clock step is
// exact, so `toBe` is used rather than a tolerance, and the clock-read claim is
// a spy count rather than a timing.

describe('monoMs: the clock a wall-clock step cannot move', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not move when the wall clock steps forward', () => {
    const before = monoMs();
    // Exact equality, not a tolerance: under fake timers `performance.now()` is
    // frozen until a timer is advanced, and `setSystemTime` advances nothing the
    // monotonic clock can see. Any drift here is a real drift.
    expect(monoMs()).toBe(before);
    vi.setSystemTime(1_060_000);
    expect(monoMs()).toBe(before);
  });

  it('does not move when the wall clock steps backward either', () => {
    const before = monoMs();
    vi.setSystemTime(999_000);
    expect(monoMs()).toBe(before);
  });

  it('never reads Date.now(), which is the whole of the fix', () => {
    // The claim is a *count*, so it is asserted as one. `nowMs()` reads the wall
    // clock exactly once per call; `monoMs()` never does, which is why it cannot
    // be moved and why it is cheaper. Both halves are asserted together so the
    // test cannot pass by a spy that simply stopped working.
    const dateNow = vi.spyOn(Date, 'now');
    try {
      monoMs();
      monoMs();
      monoMs();
      expect(dateNow).not.toHaveBeenCalled();
      nowMs();
      expect(dateNow).toHaveBeenCalledTimes(1);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('never decreases across many readings', () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 500; i += 1) {
      const v = monoMs();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('is an epoch timestamp, not a relative one', () => {
    // The offset is captured once at module load, so the value is still
    // comparable with a wall clock and with `stats().tat` /
    // `tryReserve().runAt`, which are documented as instants. A `performance.now()`
    // reading would be ~0 here and both of those would become nonsense.
    vi.useRealTimers();
    expect(monoMs()).toBeGreaterThan(1.6e12);
  });

  it('follows the monotonic clock when the harness advances it', () => {
    const before = monoMs();
    vi.advanceTimersByTime(250);
    expect(monoMs() - before).toBe(250);
  });
});

describe('RES-019: a wall-clock step no longer hands out budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('PowerGCRA stays saturated when the wall clock jumps forward', () => {
    const g = new PowerGCRA({ rate: 10, per: 1000, burst: 1 });
    expect(g.tryConsume()).toBe(true);
    expect(g.tryConsume()).toBe(true);
    expect(g.available()).toBe(0);
    vi.setSystemTime(1_005_000);
    // Was 2 before the fix - `_ceiling()`, the entire burst.
    expect(g.available()).toBe(0);
    expect(g.tryConsume()).toBe(false);
  });

  it('PowerThrottle does not refill when the wall clock jumps forward', () => {
    const t = new PowerThrottle({ capacity: 2, refillRate: 1 });
    expect(t.tryConsume(2)).toBe(true);
    expect(t.available()).toBe(0);
    vi.setSystemTime(1_060_000);
    // Was 2 before the fix: a minute of wall clock at one token per second.
    expect(t.available()).toBe(0);
    expect(t.tryConsume()).toBe(false);
  });

  it('PowerSlidingWindow keeps entries the wall clock claims have expired', () => {
    const w = new PowerSlidingWindow({ capacity: 1, windowMs: 1000 });
    expect(w.tryConsume()).toBe(true);
    expect(w.tryConsume()).toBe(false);
    vi.setSystemTime(1_060_000);
    // Was true before the fix: the window is 1 s and the wall clock moved a minute.
    expect(w.tryConsume()).toBe(false);
  });

  it('PowerCircuit stays open when the wall clock jumps past its window', async () => {
    const c = new PowerCircuit({ threshold: 1, timeout: 60_000 });
    await expect(
      c.call(() => {
        throw new Error('down');
      })
    ).rejects.toThrow('down');
    // `_state`, not the getter: the getter computes 'half-open' logically and
    // reading it is itself the announcement (FLAKE-001).
    expect(c._state).toBe('open');
    vi.setSystemTime(1_060_000);
    // Was 'half-open' before the fix, with 0 ms of real time elapsed.
    expect(c.state).toBe('open');
    await expect(c.call(() => 'ok')).rejects.toMatchObject({ code: 'ECIRCUITOPEN' });
  });
});

describe('RES-019: the split between the two clocks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('PowerCron keeps the wall clock, because nextRunAt is an instant', () => {
    // The other half of the row: `nextRunAt` is documented as epoch
    // milliseconds, so a caller can hand it to a scheduler or read it in a log
    // line. Reading it off a monotonic clock would make it a number since page
    // load, which is not a time anyone can use. This is the counterpart that
    // keeps the change from being "make everything monotonic".
    const cron = new PowerCron(() => {}, { intervalMs: 1000 });
    cron.start();
    expect(cron.nextRunAt).toBe(1_001_000);
    cron.stop();

    vi.setSystemTime(1_060_000);
    const moved = new PowerCron(() => {}, { intervalMs: 1000 });
    moved.start();
    expect(moved.nextRunAt).toBe(1_061_000);
    moved.stop();
  });

  it('an injected now still beats the monotonic default', () => {
    // The documented injection point, and the answer for anyone who needs to
    // drive a limiter's clock in their own tests. It has always won
    // (`resolveLimiterNow`), and the change must not have displaced it.
    let now = 5000;
    const g = new PowerGCRA({ rate: 1, per: 1000, burst: 0, now: () => now });
    expect(g.tryConsume()).toBe(true);
    expect(g.tryConsume()).toBe(false);
    vi.setSystemTime(9_000_000);
    // Neither clock nor wall clock moves the limiter, because neither is read.
    expect(g.tryConsume()).toBe(false);
    now = 6000;
    expect(g.tryConsume()).toBe(true);
  });
});
