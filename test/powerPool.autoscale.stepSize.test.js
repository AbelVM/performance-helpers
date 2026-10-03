import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * `stepUp` / `stepDown` as a ceiling, with the magnitude chosen by a PI
 * controller on the relative error.
 *
 * Before this the step was a fixed count, so a pool 20 % over target added as
 * many workers as one 300 % over. These tests pin the three properties that make
 * the change safe, and they are stated in that order because the first is the one
 * that protects every existing user.
 */
class MockUnderlying {
  constructor() {
    this.onmessage = null;
    this.postMessage = () => {};
    this.terminate = () => {};
  }
  addEventListener(type, cb) {
    // Store the listener. An earlier version of this mock *invoked* it, which
    // threw inside `_addWorkerInstance` and made every scale-up look like a
    // no-op — four failures that all pointed at the controller and none of which
    // was the controller.
    if (type === 'message') this.onmessage = cb;
  }
  removeEventListener() {}
}

/**
 * Build a pool and attach `autoScale` directly rather than through the
 * constructor, so no interval is started. An earlier version took the config as
 * an argument and never applied it, so `tick()`'s spread silently kept the
 * constructor's default and every scale-up was a no-op.
 */
const makePool = (autoScale, { size = 1, maxSize = 12, minSize = 0 } = {}) => {
  const pool = new PowerPool(MockUnderlying, {
    size,
    minSize,
    maxSize,
    lazy: false,
    idleTimeout: 100_000,
  });
  pool._autoScale = { enabled: true, ...autoScale };
  return pool;
};

/** Drive one tick with a given latency EWMA, without starting the interval. */
const tick = (pool, ewmaMs, nowMsValue) => {
  pool._autoScale = {
    enabled: true,
    backoffFactor: 1,
    backoffMaxMultiplier: 1,
    ...pool._autoScale,
  };
  pool._autoScaleBackoffMultiplier = 1;
  pool._ewmaLatency = ewmaMs;
  // A *recent* scale action, not 0. `now - 0` is astronomically large, so the
  // quiet-period integral reset fired on every single tick and the integral could
  // never accumulate at all — which looked like a controller that had forgotten
  // its own gains.
  pool._lastAutoScaleAt = 0;
  if (nowMsValue !== undefined) pool._nowOverride = nowMsValue;
  pool._autoScaleTick();
};

describe('PowerPool autoscale step sizing', () => {
  it('is unchanged at the default stepUp of 1, whatever the error', () => {
    // **The property that protects every existing user.** `stepUp: 1` is a
    // ceiling of one worker, so the controller's opinion cannot raise it. If this
    // test ever fails, the change has altered behaviour nobody opted into.
    const pool = makePool({
      intervalMs: 1000,
      targetMs: 100,
      hysteresis: 0.2,
      cooldownMs: 0,
      stepUp: 1,
    });
    try {
      // One worker is added per tick whatever the error, so the count after the
      // first tick is 2 and must not grow faster than that.
      for (const [i, ewma] of [121, 200, 1000, 100_000].entries()) {
        tick(pool, ewma);
        expect(pool.workers.length, `ewma ${ewma}`).toBe(2 + i);
      }
    } finally {
      pool.terminate();
    }
  });

  it('adds one worker for a marginal overshoot and more for a large one', () => {
    // The actual improvement. With `stepUp: 4` the caller has already said four
    // workers is acceptable; the controller decides how many of those four this
    // tick actually needs.
    const pool = makePool({
      intervalMs: 1000,
      targetMs: 100,
      hysteresis: 0.2,
      cooldownMs: 0,
      stepUp: 4,
    });
    try {
      // 20 % over is barely past the hysteresis band: relative error 0.2, which
      // rounds to zero and is floored at one worker — the old behaviour.
      tick(pool, 121);
      expect(pool.workers.length).toBe(2);

      // Far over: the proportional term is large, so more than one.
      const marginal = pool.workers.length;
      const wide = makePool({
        intervalMs: 1000,
        targetMs: 100,
        hysteresis: 0.2,
        cooldownMs: 0,
        stepUp: 4,
      });
      try {
        tick(wide, 600);
        expect(wide.workers.length).toBeGreaterThan(marginal);
        expect(wide.workers.length).toBeLessThanOrEqual(5); // 1 + the ceiling of 4
      } finally {
        wide.terminate();
      }
    } finally {
      pool.terminate();
    }
  });

  it('never exceeds the ceiling, however long the overshoot persists', () => {
    // The integral is what makes the step large, and an unbounded integral would
    // eventually ask for more than the caller allowed. `PowerServo` clamps the
    // integral to the output window for exactly this, so the ceiling holds.
    const pool = makePool({
      intervalMs: 1000,
      targetMs: 100,
      hysteresis: 0.2,
      cooldownMs: 0,
      stepUp: 3,
    });
    try {
      // The ceiling is **per tick**, not a cap on the fleet: 500 ticks of a large
      // overshoot may legitimately walk the pool up to `maxSize`. What must hold
      // is that no single tick moves more than `stepUp` workers, which is what an
      // unbounded integral would eventually break.
      let previous = pool.workers.length;
      for (let i = 0; i < 500; i += 1) {
        tick(pool, 10_000);
        const added = pool.workers.length - previous;
        expect(added, `tick ${i} added ${added}`).toBeLessThanOrEqual(3);
        previous = pool.workers.length;
      }
      expect(pool.workers.length).toBeLessThanOrEqual(12);
      expect(Number.isFinite(pool._autoscaleServo.integral)).toBe(true);
      // And it saturates rather than diverging. The clamp gives the *contribution*
      // the window `[min - kp·e, max - kp·e]`, which at error -99 and ceiling 3 is
      // [96, 102]; with `ki: 0.25` that pins the integral at 384. The property is
      // that it stops, not that it is small — so run it far longer and check it
      // has not moved.
      const pinned = pool._autoscaleServo.integral;
      for (let i = 0; i < 5000; i += 1) tick(pool, 10_000);
      expect(pool._autoscaleServo.integral).toBeCloseTo(pinned, 6);
      expect(Math.abs(pool._autoscaleServo.integral)).toBeLessThanOrEqual(408);
    } finally {
      pool.terminate();
    }
  });

  it('scales the step down the same way', () => {
    const pool = makePool(
      { intervalMs: 1000, targetMs: 100, hysteresis: 0.2, cooldownMs: 0, stepDown: 4 },
      { size: 10, maxSize: 12 }
    );
    try {
      for (const w of pool.workers) w.tasks = 0;
      // Far *under* target, so the relative error is large negative.
      tick(pool, 1);
      expect(pool.workers.length).toBeLessThan(10);
      expect(pool.workers.length).toBeGreaterThanOrEqual(10 - 4);
    } finally {
      pool.terminate();
    }
  });

  it('treats a stepUp of 1 as a ceiling without ever constructing a controller', () => {
    // Not an optimisation to assert for its own sake: it is that the default path
    // allocates nothing, so a pool that never leaves the default pays nothing for
    // a feature it does not use.
    const pool = makePool({
      intervalMs: 1000,
      targetMs: 100,
      hysteresis: 0.2,
      cooldownMs: 0,
      stepUp: 1,
    });
    try {
      tick(pool, 5000);
      expect(pool._autoscaleServo).toBeUndefined();
    } finally {
      pool.terminate();
    }
  });

  it('drops the accumulated integral once the pool has been quiet past the cooldown', () => {
    // Otherwise a burst's integral is paid back during the next quiet period,
    // which is the windup bug in the shape it actually appears in here.
    const pool = makePool(
      {
        intervalMs: 1000,
        targetMs: 100,
        hysteresis: 0.2,
        cooldownMs: 50,
        stepUp: 4,
      },
      // Headroom, so the pool cannot reach `maxSize` and stop consulting the
      // controller before the test has looked at it. At the default `maxSize` of
      // 12 the servo was never constructed at all and the assertion read
      // `undefined.integral`. Modest rather than generous: `maxSize: 500` built
      // enough mock workers to crash the vitest worker outright.
      { maxSize: 40 }
    );
    try {
      for (let i = 0; i < 5; i += 1) tick(pool, 10_000);
      expect(Math.abs(pool._autoscaleServo.integral)).toBeGreaterThan(0);
      // Quiet means latency back **on target**, not merely a cooldown having
      // expired. An earlier version drove this with `ewma` still at 10 000, so the
      // tick scaled up and the integral correctly survived — the assertion was
      // testing a different condition than the one the reset fires on.
      tick(pool, 100);
      pool._lastAutoScaleAt = -1e9;
      pool._autoScaleTick();
      expect(pool._autoscaleServo.integral).toBe(0);
    } finally {
      pool.terminate();
    }
  });
});
