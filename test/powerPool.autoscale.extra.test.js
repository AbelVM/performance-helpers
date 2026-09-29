import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

// Lightweight mock underlying that reports a fixed processing duration
class MockUnderlyingWithDuration {
  constructor() {
    this.onmessage = null;
    this.postMessage = () => {
      // respond on next tick with a reported duration
      setTimeout(() => {
        if (this.onmessage)
          this.onmessage({ data: { duration: MockUnderlyingWithDuration.responseDuration } });
      }, 1);
    };
    this.terminate = () => {};
  }
}

describe('PowerPool autoscale - extra behaviors', () => {
  it('multi-step scaling: adds up to `stepUp` workers in one tick', async () => {
    MockUnderlyingWithDuration.responseDuration = 200;

    // TEST-008: before construction - the autoscale interval is a real
    // timer the constructor creates, so a later switch would leave it
    // on the real clock and `advanceTimersByTimeAsync` would never
    // fire it. See the same note in `powerPool.autoscale.test.js`.
    vi.useFakeTimers();

    const pool = new PowerPool(MockUnderlyingWithDuration, {
      size: 1,
      minSize: 1,
      maxSize: 8,
      lazy: false,
      taskQueue: true,
      autoScale: {
        intervalMs: 50,
        targetMs: 50,
        alpha: 0.5,
        cooldownMs: 10,
        hysteresis: 0.1,
        stepUp: 3,
      },
    });

    // TEST-008: 400 ms of real sleep replaced by an explicit clock advance.
    // Installed before construction because the autoscale interval is a real
    // timer the constructor creates - see the note in `powerPool.autoscale.test.js`.
    try {
      // post many tasks to ensure EWMA rises
      for (let i = 0; i < 12; i++) pool.postMessage({ i });

      await vi.advanceTimersByTimeAsync(1000);

      // should have added at least stepUp workers in a single tick
      expect(pool.workers.length).toBeGreaterThanOrEqual(1 + 3);
    } finally {
      vi.useRealTimers();
      pool.terminate();
    }
  });

  it('backoff: backoff multiplier increases after scale action', async () => {
    MockUnderlyingWithDuration.responseDuration = 10;

    // TEST-008: before construction - the autoscale interval is a real
    // timer the constructor creates, so a later switch would leave it
    // on the real clock and `advanceTimersByTimeAsync` would never
    // fire it. See the same note in `powerPool.autoscale.test.js`.
    vi.useFakeTimers();

    const pool = new PowerPool(MockUnderlyingWithDuration, {
      size: 8,
      minSize: 1,
      maxSize: 8,
      lazy: false,
      taskQueue: true,
      autoScale: {
        intervalMs: 50,
        targetMs: 50,
        alpha: 0.5,
        cooldownMs: 50,
        hysteresis: 0.1,
        backoffFactor: 4,
        backoffMaxMultiplier: 8,
        backoffResetMs: 1000,
      },
    });

    // TEST-008: 200 ms of real sleep replaced by an explicit clock advance.
    try {
      // Start at max size so normal auto-growth cannot add workers.
      for (let i = 0; i < 8; i++) pool.postMessage({ i });

      await vi.advanceTimersByTimeAsync(1000);

      // internal multiplier should have increased from 1 when autoscale scaled down
      expect(pool._autoScaleBackoffMultiplier).toBeGreaterThanOrEqual(1);
      expect(pool._autoScaleBackoffMultiplier).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
      pool.terminate();
    }
  });
});
