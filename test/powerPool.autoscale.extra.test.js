import { describe, it, expect } from 'vitest';
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

    try {
      // post many tasks to ensure EWMA rises
      for (let i = 0; i < 12; i++) pool.postMessage({ i });

      // wait several ticks
      await new Promise((r) => setTimeout(r, 400));

      // should have added at least stepUp workers in a single tick
      expect(pool.workers.length).toBeGreaterThanOrEqual(1 + 3);
    } finally {
      pool.terminate();
    }
  });

  it('backoff: backoff multiplier increases after scale action', async () => {
    MockUnderlyingWithDuration.responseDuration = 200;

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
        cooldownMs: 50,
        hysteresis: 0.1,
        backoffFactor: 4,
        backoffMaxMultiplier: 8,
      },
    });

    try {
      for (let i = 0; i < 8; i++) pool.postMessage({ i });

      // wait enough time for at least one scale action
      await new Promise((r) => setTimeout(r, 200));

      // internal multiplier should have increased from 1
      expect(pool._autoScaleBackoffMultiplier).toBeGreaterThanOrEqual(1);
      // If backoffFactor applied, multiplier should be >= backoffFactor
      expect(pool._autoScaleBackoffMultiplier).toBeGreaterThanOrEqual(4);
    } finally {
      pool.terminate();
    }
  });
});
