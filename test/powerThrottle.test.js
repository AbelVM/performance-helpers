import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

describe('PowerThrottle (token-bucket)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows consuming up to capacity', () => {
    const t = new PowerThrottle({ capacity: 3, tokens: 3, refillRate: 0 });
    expect(t.tryConsume(1)).toBe(true);
    expect(t.tryConsume(2)).toBe(true);
    expect(t.tryConsume(1)).toBe(false);
  });

  it('refills tokens over time according to refillRate', () => {
    const t = new PowerThrottle({ capacity: 5, tokens: 0, refillRate: 2 }); // 2 tokens/s
    expect(t.tryConsume(1)).toBe(false);
    // advance half a second -> 1 token
    vi.advanceTimersByTime(500);
    expect(t.tryConsume(1)).toBe(true);
    // consume remaining
    expect(t.tryConsume(1)).toBe(false);
    // advance another 1500ms -> 3 tokens (total refill since last)= ~3
    vi.advanceTimersByTime(1500);
    expect(t.tryConsume(3)).toBe(true);
    // capacity cap
    vi.advanceTimersByTime(5000);
    expect(t.available()).toBeLessThanOrEqual(5);
  });

  it('addTokens and reset behave as expected', () => {
    const t = new PowerThrottle({ capacity: 4, tokens: 0, refillRate: 0 });
    expect(t.tryConsume(1)).toBe(false);
    t.addTokens(2);
    expect(t.tryConsume(2)).toBe(true);
    t.reset(1);
    expect(t.tryConsume(1)).toBe(true);
    t.reset();
    expect(t.tryConsume(4)).toBe(true);
  });
});
