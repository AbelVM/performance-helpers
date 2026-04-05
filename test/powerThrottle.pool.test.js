import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerThrottle + PowerPool integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('paces dispatches to the pool according to limiter', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }

    // ensure a single eager worker so postMessage calls target the same underlying
    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 1, lazy: false });
    const limiter = new PowerThrottle({ capacity: 2, tokens: 2, refillRate: 1 });

    const pending = [];
    function scheduleTask(payload) {
      if (limiter.tryConsume()) {
        pool.postMessage({ task: 'do', payload });
      } else {
        pending.push(payload);
      }
    }

    for (let i = 0; i < 5; i++) scheduleTask({ i });

    const underlying = pool.workers[0].worker._underlying;
    // initially capacity (2) should have been consumed
    expect(underlying.postMessage).toHaveBeenCalledTimes(2);

    // advance 1 second -> +1 token, dispatch one pending
    vi.advanceTimersByTime(1000);
    if (pending.length) scheduleTask(pending.shift());
    expect(underlying.postMessage).toHaveBeenCalledTimes(3);

    // advance another second -> +1 token
    vi.advanceTimersByTime(1000);
    if (pending.length) scheduleTask(pending.shift());
    expect(underlying.postMessage).toHaveBeenCalledTimes(4);

    // advance another second -> +1 token, final pending consumed
    vi.advanceTimersByTime(1000);
    if (pending.length) scheduleTask(pending.shift());
    expect(underlying.postMessage).toHaveBeenCalledTimes(5);

    pool.terminate();
  });
});
