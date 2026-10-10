import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import PowerRateLimit from '../src/helpers/powerRateLimit.js';

describe('PowerRateLimit', () => {
  it('succeeds only when all underlying limiters allow', () => {
    const t = new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const w = new PowerSlidingWindow({ capacity: 2, windowMs: 10000 });
    const r = new PowerRateLimit([t, w]);

    expect(r.tryConsume()).toBe(true);
    // throttle consumed (capacity 1) so next immediate attempt should fail
    expect(r.tryConsume()).toBe(false);
  });

  it('respects sliding-window when throttle has higher capacity', () => {
    const t = new PowerThrottle({ capacity: 5, tokens: 5, refillRate: 0 });
    const w = new PowerSlidingWindow({ capacity: 1, windowMs: 10000 });
    const r = new PowerRateLimit([t, w]);

    expect(r.tryConsume()).toBe(true);
    // sliding window capacity is 1, so second immediate attempt is blocked
    expect(r.tryConsume()).toBe(false);
  });

  it('reset resets underlying limiters', () => {
    const t = new PowerThrottle({ capacity: 1, tokens: 0, refillRate: 0 });
    const w = new PowerSlidingWindow({ capacity: 1, windowMs: 10000 });
    const r = new PowerRateLimit([t, w]);

    // nothing available initially
    expect(r.tryConsume()).toBe(false);
    // reset should restore underlying limiters to default/full state
    r.reset();
    expect(r.tryConsume()).toBe(true);
  });
});

// --- AUD-021: a throwing leg must be visible, not mistaken for a rate limit --

describe('PowerRateLimit leg errors (AUD-021)', () => {
  /** A leg whose `available()` throws, standing in for a broken custom clock. */
  const throwingLeg = () => ({
    available() {
      throw new Error('clock is broken');
    },
    tryConsume: () => true,
  });

  it('counts a throwing leg instead of reporting it as a rejection', () => {
    // A throw from a leg's `available()` used to be indistinguishable from "no
    // capacity" — both returned `false` — so a broken custom clock or a throwing
    // third-party leg looked exactly like a rate limit, and `rejectionRate`
    // reported a busy limiter rather than a broken one.
    const r = new PowerRateLimit([throwingLeg()]);

    expect(r.tryConsume(1)).toBe(false);
    expect(r.stats().legErrors).toBe(1);

    // And it keeps counting, so the rate is observable rather than a one-off.
    r.tryConsume(1);
    r.tryConsume(1);
    expect(r.stats().legErrors).toBe(3);
  });

  it('keeps legErrors out of rejectionRate, because they are not rejections', () => {
    // The whole point: a refusal caused by a fault and a refusal caused by a full
    // bucket are the same `false` to the caller and must not be the same number
    // to an operator. `rejectionRate` counts refusals; `legErrors` counts faults.
    const r = new PowerRateLimit([throwingLeg()]);
    r.tryConsume(1);

    const s = r.stats();
    expect(s.legErrors).toBe(1);
    expect(s.rejectionRate).toBe(1); // the request was refused
    // But the two are reported separately, so "every request refused" is
    // distinguishable from "every request refused *and the limiter is broken*".
    expect(s.legErrors).toBeGreaterThan(0);
  });

  it('still refuses rather than charging a leg that cannot answer', () => {
    // The safe direction, and the reason the throw is counted rather than
    // re-thrown: a leg that cannot say whether it can afford the request is not a
    // leg that should be charged. Pinned so a future change cannot "fix" the
    // visibility by making the fault admit traffic.
    const r = new PowerRateLimit([throwingLeg()]);
    expect(r.tryConsume(1)).toBe(false);
    expect(r.stats().legErrors).toBe(1);
  });

  it('clears the count on reset, because reset is what fixes the fault', () => {
    // The counters describe the current window of traffic, and a reset is the
    // caller saying "start measuring again". Leaving the count behind would
    // report a problem the reset just fixed.
    const r = new PowerRateLimit([throwingLeg()]);
    r.tryConsume(1);
    expect(r.stats().legErrors).toBe(1);

    r.reset();
    expect(r.stats().legErrors).toBe(0);
  });

  it('does not count a leg that simply has no capacity', () => {
    // The other half: an ordinary refusal must not inflate the fault counter, or
    // the number stops meaning anything.

    const r = new PowerRateLimit([new PowerThrottle({ capacity: 1, tokens: 0, refillRate: 0 })]);

    expect(r.tryConsume(1)).toBe(false);
    expect(r.stats().legErrors).toBe(0);
    expect(r.stats().rejectionRate).toBe(1);
  });

  it('reports legErrors through getStats() as well', () => {
    // Both spellings exist for backwards compatibility (guides/stats-naming.md),
    // and a field present in one and absent in the other is the kind of drift
    // that sends an operator looking in the wrong place.
    const r = new PowerRateLimit([throwingLeg()]);
    r.tryConsume(1);
    expect(r.getStats().legErrors).toBe(1);
  });
});
