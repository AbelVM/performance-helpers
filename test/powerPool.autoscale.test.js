import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

// Lightweight mock underlying used for the first autoscale test
class MockUnderlying {
  constructor() {
    this.onmessage = null;
    this.postMessage = () => {};
    this.terminate = () => {};
  }
  addEventListener(type, cb) {
    if (type === 'message') this.onmessage = cb;
  }
  removeEventListener() {}
}

describe('PowerPool autoscale', () => {
  it('does not terminate workers with in-flight tasks during scale-down', () => {
    const pool = new PowerPool(MockUnderlying, {
      size: 2,
      minSize: 0,
      maxSize: 2,
      lazy: false,
      maxTasksPerWorker: 1,
      idleTimeout: 1000,
    });
    try {
      // simulate autoscale config without starting an interval
      pool._autoScale = {
        enabled: true,
        intervalMs: 1000,
        targetMs: 100,
        alpha: 0.2,
        cooldownMs: 100,
        hysteresis: 0.5,
        stepUp: 1,
        stepDown: 2,
        backoffFactor: 1,
        backoffMaxMultiplier: 1,
        backoffResetMs: 10000,
      };
      pool._autoScaleBackoffMultiplier = 1;

      // set EWMA low to request scale-down
      pool._ewmaLatency = 1;

      // mark both workers as busy
      pool.workers[0].tasks = 1;
      pool.workers[1].tasks = 1;

      pool._autoScaleTick();
      // no idle workers -> none removed
      expect(pool.workers.length).toBe(2);

      // make one worker idle - it should be eligible for removal
      pool.workers[1].tasks = 0;
      pool._autoScaleTick();
      expect(pool.workers.length).toBe(1);
    } finally {
      pool.terminate();
    }
  });
});

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

describe('PowerPool autoscale', () => {
  it('scales up when observed EWMA latency exceeds target', async () => {
    // heavy tasks reported as 200ms each
    MockUnderlyingWithDuration.responseDuration = 200;

    const pool = new PowerPool(MockUnderlyingWithDuration, {
      size: 1,
      minSize: 1,
      maxSize: 4,
      lazy: false,
      taskQueue: true,
      // aggressive autoscale tick for tests
      autoScale: { intervalMs: 50, targetMs: 50, alpha: 0.5, cooldownMs: 100, hysteresis: 0.1 },
    });

    try {
      // post multiple tasks to accumulate EWMA
      for (let i = 0; i < 6; i++) pool.postMessage({ i });

      // wait enough time for several autoscale ticks
      await new Promise((r) => setTimeout(r, 500));

      // pool should have scaled up at least one worker
      expect(pool.workers.length).toBeGreaterThan(1);
    } finally {
      pool.terminate();
    }
  });

  it('scales down when latency is low and queue is empty', async () => {
    // light tasks reported as 1ms each
    MockUnderlyingWithDuration.responseDuration = 1;

    const pool = new PowerPool(MockUnderlyingWithDuration, {
      size: 3,
      minSize: 1,
      maxSize: 4,
      lazy: false,
      taskQueue: true,
      autoScale: { intervalMs: 50, targetMs: 50, alpha: 0.5, cooldownMs: 100, hysteresis: 0.1 },
    });

    try {
      // run a few quick tasks to seed a low EWMA
      for (let i = 0; i < 4; i++) pool.postMessage({ i });

      // allow tasks to complete and autoscaler to observe low latencies
      await new Promise((r) => setTimeout(r, 400));

      // after cooldown and empty queue, pool should have shrunk toward minSize
      expect(pool.workers.length).toBeLessThanOrEqual(2);
      expect(pool.workers.length).toBeGreaterThanOrEqual(1);
    } finally {
      pool.terminate();
    }
  });
});
