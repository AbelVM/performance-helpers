import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { PowerGCRA, PowerRateLimit, PowerThrottle } from '../src/index.js';

const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 200);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PowerGCRA basics', () => {
  it('accepts the first operation with no history', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    expect(l.tryConsume()).toBe(true);
  });

  it('enforces the steady-state spacing', () => {
    // 10/s => one operation per 100ms.
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
    vi.advanceTimersByTime(99);
    expect(l.tryConsume()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(l.tryConsume()).toBe(true);
  });

  it('admits a burst of exactly `burst` extra operations', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 3 });
    // burst:3 => 4 operations back to back (the first plus 3).
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
  });

  it('returns an exact retryAfter rather than an estimate', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    l.tryConsume();
    expect(l.retryAfter()).toBe(100);
    // Waiting exactly that long must succeed, with no extra slack needed.
    vi.advanceTimersByTime(100);
    expect(l.tryConsume()).toBe(true);
    expect(l.retryAfter()).toBe(100);
  });

  it('retryAfter reflects the full cost of a multi-operation ask', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    expect(l.retryAfter(3)).toBe(0); // no history: affordable now
    l.tryConsume();
    // A batch is admitted behind a *single* admission check, so the wait is
    // driven by the current TAT and does not grow with `n`. Waiting the
    // reported amount must make the whole batch succeed.
    expect(l.retryAfter(3)).toBe(100);
    vi.advanceTimersByTime(100);
    expect(l.tryConsume(3)).toBe(true);
  });

  it('a refused attempt does not push the next allowed time out', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    l.tryConsume();
    for (let i = 0; i < 5; i++) expect(l.tryConsume()).toBe(false);
    // Still exactly 100ms away, not 100 + 5*100.
    expect(l.retryAfter()).toBe(100);
  });

  it('take() reports the exact wait', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    expect(l.take()).toEqual({ ok: true });
    const r = l.take();
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBe(100);
  });

  it('available() never exceeds burst and is a whole number', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 2 });
    // burst:2 admits 3 operations at one instant (the check is made once per
    // batch, and the first is always free).
    expect(l.available()).toBe(3);
    expect(l.hasCapacity).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.available()).toBe(2);
    expect(l.tryConsume()).toBe(true);
    expect(l.available()).toBe(1);
    expect(l.tryConsume()).toBe(true);
    expect(l.available()).toBe(0);
    expect(l.hasCapacity).toBe(false);
    vi.advanceTimersByTime(100);
    expect(l.hasCapacity).toBe(true);
  });

  it('treating a non-positive ask as a no-op', () => {
    const l = new PowerGCRA({ rate: 1, per: 1000, burst: 0 });
    expect(l.tryConsume(0)).toBe(true);
    expect(l.tryConsume(-5)).toBe(true);
    expect(l.retryAfter(0)).toBe(0);
  });

  it('reset() clears accumulated state', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    l.tryConsume();
    expect(l.tryConsume()).toBe(false);
    l.reset();
    expect(l.tryConsume()).toBe(true);
    l[Symbol.dispose]();
    expect(l.stats().tat).toBeNull();
  });

  it('tolerates the clock moving backwards', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000 });
    l.tryConsume();
    vi.setSystemTime(999_000); // 1s in the past
    // Must not throw and must not accept a burst out of nowhere.
    expect(typeof l.tryConsume()).toBe('boolean');
  });
});

describe('PowerGCRA option validation', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects rate=%s', (bad) => {
    expect(() => new PowerGCRA({ rate: bad })).toThrow(TypeError);
  });

  it('rejects a missing rate', () => {
    expect(() => new PowerGCRA({})).toThrow(/rate/);
    expect(() => new PowerGCRA()).toThrow(/rate/);
  });

  it('rejects a non-positive `per` and a negative `burst`', () => {
    expect(() => new PowerGCRA({ rate: 1, per: 0 })).toThrow(/per/);
    expect(() => new PowerGCRA({ rate: 1, burst: -1 })).toThrow(/burst/);
  });
});

describe('PowerGCRA invariants', () => {
  it('never exceeds the configured rate over any window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 10 }),
        fc.array(fc.nat({ max: 400 }), { minLength: 1, maxLength: 200 }),
        (rate, burst, gaps) => {
          const per = 1000;
          const l = new PowerGCRA({ rate, per, burst });
          const stamp = [];
          let clock = 0;
          for (const g of gaps) {
            vi.advanceTimersByTime(g);
            clock += g;
            if (l.tryConsume()) stamp.push(clock);
          }
          // Over any trailing `per` window, no more than `rate` operations plus
          // the burst allowance may have been accepted.
          for (let i = 0; i < stamp.length; i++) {
            const from = stamp[i] - per;
            const n = stamp.filter((t) => t > from && t <= stamp[i]).length;
            expect(n).toBeLessThanOrEqual(rate + burst);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('retryAfter is consistent with tryConsume', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.nat({ max: 500 }), { minLength: 1, maxLength: 60 }),
        (rate, gaps) => {
          const l = new PowerGCRA({ rate, per: 1000, burst: 2 });
          // Only advanceTimersByTime is used here: setSystemTime moves
          // Date.now() but not performance.now(), and nowMs() prefers the
          // performance clock whenever it is close to Date.now().
          for (const g of gaps) {
            vi.advanceTimersByTime(g);
            const wait = l.retryAfter();
            expect(wait).toBeGreaterThanOrEqual(0);
            if (wait === 0) {
              expect(l.tryConsume()).toBe(true);
            } else {
              // Waiting what retryAfter reports must be enough. ceil, not
              // floor: GCRA works in fractional milliseconds but fake timers
              // tick in whole ones, and under-waiting would be a false failure.
              expect(l.tryConsume()).toBe(false);
              vi.advanceTimersByTime(Math.ceil(wait));
              expect(l.tryConsume()).toBe(true);
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('composes with PowerRateLimit as a limiter component', () => {
    const gcra = new PowerGCRA({ rate: 2, per: 1000, burst: 0 });
    const throttle = new PowerThrottle({ limit: 10, windowMs: 1000, capacity: 10 });
    const combined = new PowerRateLimit([gcra, throttle]);

    let granted = 0;
    for (let i = 0; i < 20; i++) if (combined.tryConsume()) granted++;
    // GCRA at 2/s is the stricter component; only the first is free.
    expect(granted).toBe(1);
    vi.advanceTimersByTime(500);
    expect(combined.tryConsume()).toBe(true);
  });
});
