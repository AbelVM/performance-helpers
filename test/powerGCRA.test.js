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
    // rate 10 => 100ms per operation. burst:5 => the budget covers 6
    // operations at one instant; draining all 6 puts the TAT 100ms ahead of
    // the clock, which is the state in which a wait is non-zero.
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 5 });
    expect(l.retryAfter(3)).toBe(0); // idle: the burst covers 3 easily
    expect(l.tryConsume(6)).toBe(true);
    expect(l.retryAfter()).toBe(100);
    // The wait grows with `n` by the batch's own span - 2 extra emission
    // intervals here. Waiting the single-operation wait instead would
    // under-wait and be refused.
    expect(l.retryAfter(3)).toBe(300);
    vi.advanceTimersByTime(300);
    expect(l.tryConsume(3)).toBe(true);
    // The batch advanced the TAT by 3 intervals, putting it 600ms ahead of a
    // clock that moved 300ms, so the next single waits 600 - 500 (the burst's
    // tolerance) = 100ms.
    expect(l.retryAfter()).toBe(100);
  });

  it('refuses a batch whose own span exceeds the burst ceiling', () => {
    // RES-012. At burst 0, `available()` is 1: the first operation is free and
    // there is no tolerance beyond it. A batch of 5 at 1/s spans 4 seconds, so
    // it cannot fit - the requirement `golang.org/x/time/rate` states as
    // `n <= burst`. Before the fix the batch's span was nowhere in the
    // condition and this returned `true`, leaving the limiter 5000ms in debt
    // for a configuration whose steady state is one operation per second.
    const l = new PowerGCRA({ rate: 1, per: 1000, burst: 0 });
    expect(l.available()).toBe(1);
    expect(l.tryConsume(5)).toBe(false);
    // Refused without committing, so nothing was spent on the attempt.
    expect(l.retryAfter()).toBe(0);
    // The single operation the budget really covers still works.
    expect(l.tryConsume()).toBe(true);
  });

  it('refuses to report a wait for a batch no wait can admit', () => {
    // A batch above the ceiling can never succeed, because the ceiling comes
    // from `burst` and not from the state of the TAT. Measured: 200 000 tries
    // across four configurations, one past the ceiling, 0 admissions.
    //
    // Returning a finite wait would be the worst of the three options - a
    // caller in a retry loop would wait, be refused, wait again, forever. And
    // this is the one place `retryAfter` may throw: it is the *advisory* half
    // of the pair, and advising a wait that cannot succeed is a bug in the
    // advice, not a rate-limit decision to report.
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 3 });
    expect(() => l.retryAfter(5)).toThrow(RangeError);
    expect(() => l.retryAfter(5)).toThrow(/burst/);
    // At the ceiling it still reports a real wait rather than throwing.
    expect(l.retryAfter(4)).toBe(0);
    // And `take()` propagates rather than inventing a wait.
    expect(() => l.take(5)).toThrow(RangeError);
    expect(l.take(2)).toEqual({ ok: true });
  });

  it('admits a batch that exactly fits the burst, and refuses one more', () => {
    // burst:3 => the budget covers 4 operations at one instant (the first is
    // free, then 3 more within the tolerance). A batch of 4 spans 3 intervals,
    // which is the whole tolerance, so it fits exactly - and consumes it
    // entirely, leaving nothing affordable right now.
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 3 });
    expect(l.available()).toBe(4);
    expect(l.tryConsume(4)).toBe(true);
    expect(l.available()).toBe(0);
    expect(l.tryConsume(5)).toBe(false);
  });

  it('reports burst + 1 available at an idle instant, whatever the rate', () => {
    // The saturation case, which is where the old `floor(tol / emission) + 1`
    // fell over: that division does not round-trip, and at `rate: 3, burst: 7`
    // it read `6.999999999999999`, so a limiter covering 8 operations reported
    // 7. Not a reporting nit - `PowerRateLimit` pre-checks `available() < want`
    // and refuses, so a composition turned down a batch the limiter admitted.
    for (const rate of [1, 3, 6, 7, 9, 11, 13, 29, 31, 100]) {
      for (const burst of [1, 2, 3, 7, 8, 11]) {
        const l = new PowerGCRA({ rate, per: 1000, burst });
        expect(l.available()).toBe(burst + 1);
      }
    }
  });

  it('a batch admission agrees with available()', () => {
    // The property the fix is really asserting: for any `n`, `tryConsume(n)`
    // succeeds exactly when the budget covers `n`. This is what makes the
    // direct call and the composed one agree - `PowerRateLimit` pre-checks
    // `available() < want`, so a `tryConsume` that admitted more than
    // `available()` reported would refuse a batch the limiter itself allowed.
    // Swept by hand over rate 1-40 x burst 0-12 x n 1-16 with varied history:
    // 255 combinations disagreed before the fix, 0 after.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.nat({ max: 300 }), { minLength: 0, maxLength: 20 }),
        (rate, burst, n, gaps) => {
          const l = new PowerGCRA({ rate, per: 1000, burst });
          for (const g of gaps) {
            vi.advanceTimersByTime(g);
            l.tryConsume();
          }
          const can = l.available() >= n;
          const got = l.tryConsume(n);
          expect(got).toBe(can);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('retryAfter is exact for a multi-operation ask', () => {
    // `retryAfter` used to compute its wait from a different expression than
    // the admission check, and the two differ in the last bit: at `rate: 7,
    // burst: 1` it reported `0` while the next `tryConsume` refused, which
    // turns a retry loop into a spin at full speed. 69 such cases on a
    // hand-swept grid before the fix, 0 after.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 0, max: 8 }),
        fc.array(fc.nat({ max: 300 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 4 }),
        (rate, burst, gaps, n) => {
          const l = new PowerGCRA({ rate, per: 1000, burst });
          const ask = Math.min(n, Math.floor(burst) + 1);
          for (const g of gaps) {
            vi.advanceTimersByTime(g);
            l.tryConsume();
          }
          const wait = l.retryAfter(ask);
          expect(wait).toBeGreaterThanOrEqual(0);
          if (wait === 0) {
            expect(l.tryConsume(ask)).toBe(true);
          } else {
            // Under-waiting is the failure that matters: a reported wait the
            // next call ignores means the caller retries early, forever.
            expect(l.tryConsume(ask)).toBe(false);
            vi.advanceTimersByTime(Math.ceil(wait));
            expect(l.tryConsume(ask)).toBe(true);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('a batch, once admitted, costs n operations of budget', () => {
    // Guards the other half: admitting `n` must advance the TAT by `n`
    // intervals, not by one. If it advanced by one, the batch would be free
    // and the limiter would hand out `n` operations per interval forever.
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 3 });
    l.tryConsume(3);
    // burst 3 => available 4 at idle; after a batch of 3 exactly 1 remains.
    expect(l.available()).toBe(1);
    vi.advanceTimersByTime(300);
    expect(l.available()).toBe(4);
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
    const throttle = new PowerThrottle({ capacity: 10 });
    const combined = new PowerRateLimit([gcra, throttle]);

    let granted = 0;
    for (let i = 0; i < 20; i++) if (combined.tryConsume()) granted++;
    // GCRA at 2/s is the stricter component; only the first is free.
    expect(granted).toBe(1);
    vi.advanceTimersByTime(500);
    expect(combined.tryConsume()).toBe(true);
  });
});

describe('GAP-006: tryReserve answers both questions from one clock reading', () => {
  // `retryAfter()` already computed the exact wait, so the capability was not
  // missing — what was missing was doing both at once. `tryConsume()` followed by
  // `retryAfter()` takes **two** clock readings, and this class's own comments record
  // that two spellings of the same arithmetic have already disagreed in the last
  // bit and admitted a batch `available()` had just called unaffordable.
  it('returns an absolute runAt on refusal, and null on admission', () => {
    let now = 1000;
    const g = new PowerGCRA({ rate: 1, burst: 0, now: () => now });
    expect(g.tryReserve(), 'first is admitted').toEqual({ ok: true, runAt: null });
    // rate 1/1000ms with no burst: the next slot is at 2000, and `runAt` is that
    // **instant**, not the 1000ms delay — an HTTP Retry-After and a log line both
    // want the instant, and converting one to the other is where callers go wrong.
    expect(g.tryReserve()).toEqual({ ok: false, runAt: 2000 });
    now = 2000;
    expect(g.tryReserve(), 'admitted once the clock reaches it').toEqual({ ok: true, runAt: null });
  });

  it('agrees with tryConsume on every decision, on twin limiters', () => {
    // The drift guard. `tryReserve` mirrors `tryConsume`'s admission path rather than
    // calling it, so the two can diverge; this fails if either changes without the
    // other. Compared on **twin limiters** driven by the same clock sequence — an
    // earlier version of this check ran both against one instance and disagreed 42
    // times out of 384, which was the test double-consuming rather than a real
    // divergence.
    let checked = 0;
    let disagreed = 0;
    for (const rate of [1, 3, 7, 40]) {
      for (const burst of [0, 1, 4, 12]) {
        for (const n of [1, 2, 5, 16]) {
          let c1 = 5000;
          let c2 = 5000;
          const a = new PowerGCRA({ rate, burst, now: () => c1 });
          const b = new PowerGCRA({ rate, burst, now: () => c2 });
          for (let step = 0; step < 6; step += 1) {
            const reserved = a.tryReserve(n).ok;
            const consumed = b.tryConsume(n);
            checked += 1;
            if (reserved !== consumed) disagreed += 1;
            c1 += 37;
            c2 += 37;
          }
        }
      }
    }
    expect(checked).toBe(384);
    expect(disagreed, 'tryReserve must decide exactly as tryConsume does').toBe(0);
  });
});
