import { describe, it, expect, vi } from 'vitest';
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

    // **Before the pool exists, and that ordering is the whole trick.** The
    // autoscale interval is a real timer created in the constructor, so a
    // `useFakeTimers()` after it leaves the scaler on the real clock and
    // `advanceTimersByTimeAsync` never fires it — the test then passes for the
    // wrong reason, because queued tasks grew the pool without the scaler
    // running at all. Caught by converting this test and watching the sibling
    // scale-down case fail.
    vi.useFakeTimers();

    const pool = new PowerPool(MockUnderlyingWithDuration, {
      size: 1,
      minSize: 1,
      maxSize: 4,
      lazy: false,
      taskQueue: true,
      // aggressive autoscale tick for tests
      autoScale: { intervalMs: 50, targetMs: 50, alpha: 0.5, cooldownMs: 100, hysteresis: 0.1 },
    });

    // TEST-008: this used to sleep 500 ms of real time and hoped several
    // autoscale ticks landed. Advancing the clock says *how many* ticks, and a
    // tick that takes longer than the timer under a loaded machine can no longer
    // silently turn into "no scale-up".
    // `workers.length > 1` does **not** prove the scaler ran: the pool also
    // grows on demand when the queue backs up, so a test with the scaler
    // entirely dead still passes — verified, by stubbing `_autoScaleTick` to
    // return immediately and watching this assertion alone survive.
    //
    // The spy closes the gap the fake-timer conversion opened, and its claim is
    // deliberately narrower than "the scaler worked": it proves the autoscale
    // **interval fired**, which is exactly the regression the reordering was
    // about — a real interval is never advanced by the clock. It does **not**
    // prove the tick did useful work; the scale-down case below is what proves
    // that, by asserting the pool actually shrinks.
    const tick = vi.spyOn(pool, '_autoScaleTick');

    try {
      for (let i = 0; i < 6; i++) pool.postMessage({ i });

      // Ten ticks at `intervalMs: 50`, plus room for task completions to be
      // observed in between.
      await vi.advanceTimersByTimeAsync(1000);

      expect(tick).toHaveBeenCalled();
      expect(pool.workers.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
      pool.terminate();
    }
  });

  it('scales down when latency is low and queue is empty', async () => {
    // light tasks reported as 1ms each
    MockUnderlyingWithDuration.responseDuration = 1;

    // Before construction, for the reason above.
    vi.useFakeTimers();

    const pool = new PowerPool(MockUnderlyingWithDuration, {
      size: 3,
      minSize: 1,
      maxSize: 4,
      lazy: false,
      taskQueue: true,
      autoScale: { intervalMs: 50, targetMs: 50, alpha: 0.5, cooldownMs: 100, hysteresis: 0.1 },
    });

    // TEST-008: was a 400 ms real sleep. Same reasoning as the scale-up case,
    // and this one additionally needs enough ticks to clear the 100 ms cooldown
    // and then satisfy the hysteresis branch.
    // The interval must have fired (see the note on the scale-up case for what
    // that does and does not prove). The `toBeLessThanOrEqual(2)` below is the
    // assertion that the scaler actually *did* something: with `_autoScaleTick`
    // stubbed to return, this test fails.
    const tick = vi.spyOn(pool, '_autoScaleTick');

    try {
      for (let i = 0; i < 4; i++) pool.postMessage({ i });

      // Well past `cooldownMs: 100` and several scale-down opportunities.
      await vi.advanceTimersByTimeAsync(1000);

      // after cooldown and empty queue, pool should have shrunk toward minSize
      expect(tick).toHaveBeenCalled();
      expect(pool.workers.length).toBeLessThanOrEqual(2);
      expect(pool.workers.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
      pool.terminate();
    }
  });
});
