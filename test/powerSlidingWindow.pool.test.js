import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerSlidingWindow + PowerPool integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('paces dispatches to the pool according to sliding-window quota', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1 });
    const limiter = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });

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
    // initially capacity (2) consumed
    expect(underlying.postMessage).toHaveBeenCalledTimes(2);

    // advance 1s -> window slides, two more slots available
    vi.advanceTimersByTime(1000);
    while (pending.length && limiter.tryConsume()) {
      const p = pending.shift();
      pool.postMessage({ task: 'do', payload: p });
    }
    expect(underlying.postMessage).toHaveBeenCalledTimes(4);

    // advance another 1s -> remaining slot consumed
    vi.advanceTimersByTime(1000);
    while (pending.length && limiter.tryConsume()) {
      const p = pending.shift();
      pool.postMessage({ task: 'do', payload: p });
    }
    expect(underlying.postMessage).toHaveBeenCalledTimes(5);

    pool.terminate();
  });
});
