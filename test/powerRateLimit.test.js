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
