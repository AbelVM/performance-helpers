import { describe, it, expect } from 'vitest';
import PowerRateLimit, { PowerRateLimitBuilder } from '../src/helpers/powerRateLimit.js';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';

describe('PowerRateLimit.builder', () => {
  it('returns a PowerRateLimitBuilder instance', () => {
    const builder = PowerRateLimit.builder();
    expect(builder).toBeInstanceOf(PowerRateLimitBuilder);
  });

  it('builds a composed limiter with add()', () => {
    const t = new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const w = new PowerSlidingWindow({ capacity: 2, windowMs: 10000 });
    const limit = PowerRateLimit.builder().add(t).add(w).build();

    expect(limit.tryConsume()).toBe(true);
    expect(limit.tryConsume()).toBe(false);
  });

  it('supports fluent chaining', () => {
    const t = new PowerThrottle({ capacity: 2, tokens: 2, refillRate: 0 });
    const w = new PowerSlidingWindow({ capacity: 1, windowMs: 10000 });
    const limit = PowerRateLimit.builder().add(t).add(w).atomic(true).build();

    expect(limit.tryConsume()).toBe(true);
    expect(limit.tryConsume()).toBe(false);
  });

  it('sets atomic option', () => {
    const t = new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const limit = PowerRateLimit.builder().add(t).atomic(true).build();
    expect(limit.atomicDefault).toBe(true);
  });

  it('sets keyFn option', () => {
    const factory = () => new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const keyFn = (ctx) => String(ctx.id);
    const limit = PowerRateLimit.builder().add(factory).keyFn(keyFn).build();
    expect(limit.keyFn).toBe(keyFn);
  });

  it('sets buckets option', () => {
    const t = new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const limit = PowerRateLimit.builder().add(t).buckets(256).build();
    expect(limit.buckets).toBe(256);
  });

  it('builds an empty limiter when no limiters added', () => {
    const limit = PowerRateLimit.builder().build();
    expect(limit.tryConsume()).toBe(true);
  });

  it('does not share state between builder instances', () => {
    const t1 = new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const t2 = new PowerThrottle({ capacity: 1, tokens: 1, refillRate: 0 });
    const a = PowerRateLimit.builder().add(t1).build();
    const b = PowerRateLimit.builder().add(t2).build();
    expect(a.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
  });
});
