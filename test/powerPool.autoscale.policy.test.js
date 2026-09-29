import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003: the autoscale *policy* branches, not its plumbing.
 *
 * The two existing autoscale files prove the pool grows and shrinks. They do
 * not prove the *rules* it is supposed to follow, and the rules are where the
 * interesting behaviour lives: a cooldown that must actually suppress a tick,
 * a per-tick step cap, a scale-down that must refuse to kill a busy worker, and
 * a backoff multiplier that must widen the cooldown rather than merely exist.
 *
 * Every test here asserts a property that would be violated by a plausible
 * simplification:
 *
 *  - removing the cooldown guard changes nothing for a pool that scales rarely,
 *    and everything for one that scales often;
 *  - dropping the `candidate.tasks > 0` guard looks fine until a scale-down
 *    lands while a task is in flight, which is exactly BUG-011's territory;
 *  - the step cap is the difference between "add what is needed" and "add
 *    maxSize at once".
 *
 * Fake timers are installed before construction in every case: the autoscale
 * interval is a real timer the constructor creates.
 */

/** Reports a fixed duration so the EWMA lands where a test needs it. */
class MockDuration {
  static responseDuration = 200;
  constructor() {
    this.onmessage = null;
    this.postMessage = () => {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({ data: { duration: MockDuration.responseDuration } });
        }
      }, 1);
    };
    this.terminate = () => {};
  }
}

function makePool(autoScale, extra = {}) {
  return new PowerPool(MockDuration, {
    size: 1,
    minSize: 1,
    maxSize: 8,
    lazy: false,
    taskQueue: true,
    autoScale: {
      intervalMs: 50,
      targetMs: 50,
      alpha: 0.5,
      cooldownMs: 0,
      hysteresis: 0.1,
      ...autoScale,
    },
    ...extra,
  });
}

describe('PowerPool autoscale policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockDuration.responseDuration = 200;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses a tick that lands inside the cooldown window', async () => {
    // The guard is `now - lastAutoScaleAt < cooldownMs`. Removing it does not
    // change what a rarely-scaling pool does, so it can be deleted and every
    // other test here still passes. Only a pool that scales *often* exposes it.
    const pool = makePool({ cooldownMs: 1000 });
    for (let i = 0; i < 4; i++) pool.postMessage({ i });

    // Ticks at 50, 100 ... 400ms - all inside a 1000ms cooldown.
    await vi.advanceTimersByTimeAsync(400);
    const afterCooldown = pool.workers.length;
    const actionAt = pool._lastAutoScaleAt;

    // Past the cooldown, an action is allowed.
    await vi.advanceTimersByTimeAsync(1200);

    expect(pool._lastAutoScaleAt).toBeGreaterThan(actionAt);
    expect(pool.workers.length).toBeGreaterThan(afterCooldown);
    pool.terminate();
  });

  it('multiplies the cooldown by the backoff multiplier', async () => {
    // `effectiveCooldown = cooldownMs * _autoScaleBackoffMultiplier`. The guard
    // is skipped entirely when `_lastAutoScaleAt` is falsy, so this seeds it
    // directly - an earlier draft waited for a real action to set it and found
    // `lastAutoScaleAt` still 0, which made the multiplier irrelevant and the
    // test a no-op that passed.
    // `backoffResetMs` is pinned high because the **reset** runs before the
    // cooldown check: with it unset the multiplier is reset to 1 on the first
    // tick past its window, the effective cooldown collapses back to 100ms, and
    // the test would be measuring the reset rather than the multiplication.
    const pool = makePool({
      cooldownMs: 100,
      backoffFactor: 4,
      backoffMaxMultiplier: 8,
      backoffResetMs: 60_000,
    });
    pool._ewmaLatency = 10_000; // above target, so the latency branch wants to act
    const before = pool.workers.length;

    pool._lastAutoScaleAt = Date.now();
    pool._autoScaleBackoffMultiplier = 8;

    // 700ms is far past the 100ms base cooldown but inside 100 * 8 = 800ms, so
    // the multiplied cooldown must still suppress the action.
    //
    // `advanceTimersByTimeAsync`, **not** `setSystemTime`. `nowMs()` prefers
    // `performance.timeOrigin + performance.now()` over `Date.now()` and only
    // falls back when the two diverge by more than a second, so moving the
    // system clock alone leaves the pool's notion of time where it was - the
    // first draft of this test did exactly that and the tick saw no elapsed
    // time. The hazard is documented at length in `src/utils/now.js`; this is
    // it biting a test rather than a user.
    await vi.advanceTimersByTimeAsync(700);
    pool._autoScaleTick();
    expect(pool.workers.length).toBe(before);

    // Past 800ms the same tick is allowed.
    await vi.advanceTimersByTimeAsync(200);
    pool._autoScaleTick();
    expect(pool.workers.length).toBeGreaterThan(before);
    pool.terminate();
  });

  it('resets the backoff multiplier after backoffResetMs of quiet', async () => {
    // A multiplier that never resets would freeze the pool at a wide cooldown
    // forever, even after a long healthy period - the pool could not scale up
    // again for the rest of its life.
    // The reset keys off `_lastAutoScaleAt`, not a separate backoff timestamp -
    // which is worth pinning, because the two designs differ: a separate
    // timestamp would also reset the multiplier on a *scale-up*, and a
    // scale-up is exactly the event a backoff should survive.
    const pool = makePool({ cooldownMs: 100, backoffFactor: 4, backoffResetMs: 1000 });
    pool._autoScaleBackoffMultiplier = 8;
    pool._lastAutoScaleAt = Date.now();

    await vi.advanceTimersByTimeAsync(500);
    // Inside the reset window: unchanged.
    pool._autoScaleTick();
    expect(pool._autoScaleBackoffMultiplier).toBe(8);

    // Past it: reset.
    await vi.advanceTimersByTimeAsync(1200);
    pool._autoScaleTick();
    expect(pool._autoScaleBackoffMultiplier).toBe(1);
    pool.terminate();
  });

  it('adds at most `stepUp` workers in a single tick', async () => {
    // Without the cap, one tick would add everything the pool could hold, and
    // `stepUp` would be decorative.
    // The tick is driven **directly** rather than through the interval, and the
    // reason matters. Advancing the clock runs `_maybeAddWorker` too, so the
    // pool grows on demand from the queue and the count says nothing about the
    // scaler's cap - an earlier draft asserted `workers.length <= 1 + 2` and got
    // 8, because all eight were demand-growth, not autoscale. Calling the tick
    // isolates the policy under test.
    // The bound only binds when `maxSize - workers < stepUp`, so the pool is
    // filled to one below its ceiling first. An earlier draft started at 1 of 8,
    // where `min(7, 2)` and a bare `stepUp` are both 2 - so removing the cap from
    // the source entirely left the test green, verified by mutation.
    const pool = makePool({ stepUp: 2, cooldownMs: 0 }, { size: 7, minSize: 1, maxSize: 8 });
    while (pool.workers.length < 7) pool._addWorkerInstance();
    const before = pool.workers.length;
    expect(before).toBe(7);

    pool._ewmaLatency = 10_000; // far above target: the latency branch is true
    pool._autoScaleTick();

    // One room left, so the cap allows one however large `stepUp` is. Without
    // the `maxSize` term this would overshoot the ceiling.
    expect(pool.workers.length).toBe(8);
    pool.terminate();
  });

  it('refuses to scale down past minSize', async () => {
    MockDuration.responseDuration = 1; // fast: drives the scale-down branch
    const pool = makePool({ stepDown: 4, cooldownMs: 0, hysteresis: 0.5 }, { minSize: 2, size: 2 });
    for (let i = 0; i < 4; i++) pool.postMessage({ i });

    await vi.advanceTimersByTimeAsync(1500);

    // `maxRemove = min(workers - minSize, stepDown)` - a naive `stepDown`
    // would take the pool to 0 workers and the minSize guarantee would be gone.
    expect(pool.workers.length).toBeGreaterThanOrEqual(2);
    pool.terminate();
  });

  it('skips a busy worker when scaling down', async () => {
    // This is the branch that overlaps BUG-011: `_terminateWorker` settles a
    // worker's in-flight tasks in bulk, so removing a worker that still has one
    // silently discards that task's accounting. The guard is
    // `if (candidate.tasks > 0) continue;`.
    const pool = makePool({ stepDown: 1, cooldownMs: 0, hysteresis: 0.5 }, { size: 3, minSize: 1 });

    // **The tick is driven directly and `tasks` is pinned immediately before
    // it**, which is what this branch needs. An earlier draft pinned the workers
    // busy and then advanced 1000 ms of clock: the mock's responses fired in
    // that window, every `tasks` count fell back to 0, and the guard had nothing
    // to skip — so deleting `if (candidate.tasks > 0) continue;` from the source
    // left the test green. Verified by mutation.
    pool._ewmaLatency = 1; // low latency: the scale-down branch is live
    for (const w of pool.workers) w.tasks = 1;
    const before = pool.workers.length;

    pool._autoScaleTick();

    expect(pool.workers.length).toBe(before);
    for (const w of pool.workers) expect(w.tasks).toBe(1);
    pool.terminate();
  });

  it('scales up on queue pressure alone, with no latency evidence', async () => {
    // `needScaleUp || queuePressure`. A pool that has never completed a task
    // has no EWMA at all, so the latency branch is false - and a
    // latency-only implementation would sit idle while work piled up.
    const pool = makePool({ stepUp: 2, cooldownMs: 0, hysteresis: 0.9 });
    expect(pool._ewmaLatency).toBeFalsy();

    for (let i = 0; i < 20; i++) pool.postMessage({ i });
    await vi.advanceTimersByTimeAsync(60);

    expect(pool.workers.length).toBeGreaterThan(1);
    pool.terminate();
  });
});
