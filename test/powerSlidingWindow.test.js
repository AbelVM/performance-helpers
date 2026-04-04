import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';

describe('PowerSlidingWindow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows up to capacity within the window and then blocks until window passes', () => {
    const limiter = new PowerSlidingWindow({ capacity: 3, windowMs: 1000 });
    expect(limiter.tryConsume(3)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
    // advance beyond the window
    vi.advanceTimersByTime(1000);
    expect(limiter.tryConsume(1)).toBe(true);
  });

  it('available() reflects remaining slots', () => {
    const limiter = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });
    expect(limiter.available()).toBe(2);
    limiter.tryConsume(1);
    expect(limiter.available()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(limiter.available()).toBe(2);
  });
});
