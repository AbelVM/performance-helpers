import { describe, it, expect } from 'vitest';
import { PowerGCRA, PowerThrottle, PowerSlidingWindow, PowerRateLimit } from '../src/index.js';

// RES-011. Before this, every limiter coerced a request count with
// `Math.max(0, Math.floor(+n) || 0)`, which turns `NaN` into `0` - and `0` is
// the *admit* case. So `throttle.tryConsume(NaN)` returned `true` having
// consumed nothing: `Math.floor(NaN) || 0` makes it 0, and `want === 0`
// returns true before any accounting happens.
//
// This is a gap rather than a regression, and the asymmetry is the point: the
// previous review made every *limit* throw on `NaN` (via `assertLimit`), and a
// request count is a different thing - caller input to one call, not
// configuration the library enforces on itself. `assertCount` is deliberately a
// separate function for that reason, and the message has to say which half is
// which.

const now = () => 1_000_000;

describe('a non-finite request count throws instead of admitting', () => {
  // The four limiters that take a request count. `PowerRateLimit` is in the
  // list deliberately: it is the composition, and its `want === 0` early return
  // used to run *before* any validation, so `NaN` skipped the whole method.
  const limiters = [
    ['PowerGCRA', () => new PowerGCRA({ rate: 10, per: 1000, now })],
    ['PowerThrottle', () => new PowerThrottle({ capacity: 10, refillRate: 1, now })],
    ['PowerSlidingWindow', () => new PowerSlidingWindow({ capacity: 10, windowMs: 1000, now })],
    ['PowerRateLimit', () => new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000, now })])],
  ];

  for (const [name, make] of limiters) {
    it(`${name}.tryConsume rejects a count it cannot price`, () => {
      const l = make();
      // NaN is the case the old coercion silently turned into a free pass.
      expect(() => l.tryConsume(Number.NaN)).toThrow(TypeError);
      // And the ones beside it: Infinity would grant an unbounded batch,
      // -Infinity the same, and a string is simply not a number.
      expect(() => l.tryConsume(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => l.tryConsume(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
      expect(() => l.tryConsume('many')).toThrow(TypeError);
      // The message names the class and the method, so a failure inside a
      // composition says which leg refused rather than just "invalid".
      expect(() => l.tryConsume(Number.NaN)).toThrow(
        /PowerRateLimit|PowerGCRA|PowerThrottle|PowerSlidingWindow/
      );
      expect(() => l.tryConsume(Number.NaN)).toThrow(/tryConsume/);
    });
  }

  it('a refused count leaves the limiter exactly as it was', () => {
    // The important half: throwing must not half-apply. An earlier commit's
    // lesson (PowerRateLimit) was that a validation check placed *inside* the
    // commit loop throws only after earlier limiters already consumed.
    const gcra = new PowerGCRA({ rate: 10, per: 1000, now });
    const before = gcra.available();
    expect(() => gcra.tryConsume(Number.NaN)).toThrow();
    expect(gcra.available()).toBe(before);
    expect(gcra.stats().tat).toBeNull();

    const throttle = new PowerThrottle({ capacity: 10, refillRate: 0, now });
    expect(() => throttle.tryConsume(Number.NaN)).toThrow();
    expect(throttle.available()).toBe(10);

    const window = new PowerSlidingWindow({ capacity: 10, windowMs: 1000, now });
    expect(() => window.tryConsume(Number.NaN)).toThrow();
    expect(window.available()).toBe(10);
  });

  it('a composition refuses before touching any leg', () => {
    // This is the shape that made the old coercion dangerous: `PowerRateLimit`
    // returned `true` for `NaN` while every limiter inside it was asked nothing
    // at all. A caller with three limiters behind one composition would have
    // believed the composition admitted a request no leg ever saw.
    let consulted = 0;
    const spy = {
      tryConsume() {
        consulted++;
        return true;
      },
      available: () => Infinity,
    };
    const combined = new PowerRateLimit([spy]);
    expect(() => combined.tryConsume(Number.NaN)).toThrow(TypeError);
    expect(consulted).toBe(0);
  });
});

describe('a request count that is readable is still accepted', () => {
  // The counterpart, and the reason this is not simply "throw on anything
  // unusual". `assertCount` draws one line: non-finite throws, everything else
  // is coerced. A test that only checked the throwing half would pass against
  // an implementation that rejected every count it did not already understand.

  it('zero and a negative count stay the documented no-op', () => {
    // `tryConsume(0)` means "consume nothing", and refusing to admit nothing
    // would be a behaviour change with no defect behind it.
    for (const [name, make] of [
      ['PowerGCRA', () => new PowerGCRA({ rate: 10, per: 1000, now })],
      ['PowerThrottle', () => new PowerThrottle({ capacity: 10, refillRate: 0, now })],
      ['PowerSlidingWindow', () => new PowerSlidingWindow({ capacity: 10, windowMs: 1000, now })],
    ]) {
      const l = make();
      expect(l.tryConsume(0), name).toBe(true);
      expect(l.tryConsume(-5), name).toBe(true);
    }
  });

  it('a fractional count floors rather than throwing', () => {
    // Deliberately different from `assertLimit`'s `integer` flag, which makes
    // `capacity: 2.5` an error because a fractional *limit* over-issues. A
    // fractional *count* cannot: rounding down can only under-charge.
    const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 5, now });
    // 3.9 floors to 3. burst:5 covers 6 at an idle instant; consuming 3 puts
    // the TAT 300ms ahead against a 500ms tolerance, so 2 whole operations
    // remain affordable plus the one that always fits.
    expect(gcra.tryConsume(3.9)).toBe(true);
    expect(gcra.available()).toBe(3);

    const throttle = new PowerThrottle({ capacity: 10, refillRate: 0, now });
    expect(throttle.tryConsume(3.9)).toBe(true);
    expect(throttle.available()).toBe(7);
  });

  it('a numeric string is still read as a count', () => {
    // `Number('3')` is 3. The coercion was never the defect - only its
    // treatment of `NaN` was - so string counts keep working.
    const throttle = new PowerThrottle({ capacity: 10, refillRate: 0, now });
    expect(throttle.tryConsume('3')).toBe(true);
    expect(throttle.available()).toBe(7);
  });

  it('reserve() validates too, on both the throttle and the composition', () => {
    const throttle = new PowerThrottle({ capacity: 10, refillRate: 0, now });
    expect(() => throttle.reserve(Number.NaN)).toThrow(TypeError);
    const combined = new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000, now })]);
    expect(() => combined.reserve(Number.NaN)).toThrow(TypeError);
  });

  it('retryAfter() validates, because a wait it cannot compute is a lie', () => {
    // `retryAfter(NaN)` used to return `0`, and `0` means "succeeds now". A
    // caller in a retry loop would read that as an answer, call `tryConsume`,
    // and be refused - a spin loop reporting that no wait is needed.
    const l = new PowerGCRA({ rate: 10, per: 1000, now });
    expect(() => l.retryAfter(Number.NaN)).toThrow(TypeError);
    expect(() => l.retryAfter(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => l.retryAfter('soon')).toThrow(TypeError);
    // Zero and negative stay the documented no-op: 0 means "no wait", which is
    // the same answer the ask already gave.
    expect(l.retryAfter(0)).toBe(0);
    expect(l.retryAfter(-5)).toBe(0);
  });

  it('addTokens() validates, so a refill cannot be a silent no-op', () => {
    // `addTokens(NaN)` used to add nothing and report nothing. It is the
    // refill path rather than the admission path, but a caller using it to
    // hand capacity back gets a silently empty bucket.
    const throttle = new PowerThrottle({ capacity: 10, refillRate: 0, now });
    throttle.tokens = 0;
    expect(() => throttle.addTokens(Number.NaN)).toThrow(TypeError);
    expect(throttle.tokens).toBe(0);
  });
});

describe('PowerGCRA.retryAfter refuses to report an impossible wait', () => {
  // Not `assertCount`, but the same principle one level up. A batch above the
  // burst ceiling can never be admitted at any wait, because the ceiling comes
  // from `burst` and not from the state of the TAT. Measured: 200 000 tries
  // across four configurations, one past the ceiling, zero admissions.
  it('throws a RangeError naming the ceiling, and still works at it', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 3, now });
    expect(() => l.retryAfter(5)).toThrow(RangeError);
    expect(() => l.retryAfter(5)).toThrow(/at most 4/);
    // Exactly at the ceiling is a real ask with a real answer.
    expect(l.retryAfter(4)).toBe(0);
    l.tryConsume(4);
    expect(l.retryAfter(4)).toBeGreaterThan(0);
  });

  it('take() propagates rather than inventing a wait', () => {
    const l = new PowerGCRA({ rate: 10, per: 1000, burst: 3, now });
    expect(() => l.take(5)).toThrow(RangeError);
    expect(l.take(2)).toEqual({ ok: true });
  });
});
