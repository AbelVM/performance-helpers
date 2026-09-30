import { describe, it, expect } from 'vitest';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';

/**
 * `ALGO-010`: the AIMD controller stopped learning under sustained congestion.
 *
 * The signal was fixed in `RES-003`/`RES-024` — the in-flight count is now
 * honest, and it is a real Netflix `AIMDLimit` loss signal. But the controller
 * was almost never *asked*. `_scheduleRefill()` returned early unless a producer
 * was queued, and the refill **drains** the queue by minting, so the sequence
 * under load was: producers queue, a tick mints, the queue empties, and from then
 * on nothing armed the next tick. `_adaptiveHeartbeat` was set to `true` and
 * nothing consumed it.
 *
 * Measured before the fix — 16 producers against a capacity of 8, each holding
 * its permit:
 *
 *     aimd steps   2          (400ms)
 *     window       8 -> 4 -> 2, then frozen    (floor is 1)
 *     inFlight     16 of 8                    (2x oversubscribed)
 *     heartbeat    true                       (nothing acted on it)
 *     _refillTimer null                       (nothing armed it)
 *
 * After: 97 steps, and the window reaches its floor.
 *
 * These assert on **counters and shapes, not durations** — the number of
 * decisions taken and the value the window settled at. A timing assertion here
 * would be measuring the harness; the project's median min/max spread is ~28%.
 */
describe('PowerBackpressure AIMD keeps learning under congestion (ALGO-010)', () => {
  /**
   * @param {Object} [options]
   * @returns {Promise<{bp: PowerBackpressure, steps: Array<object>, stop: () => void}>}
   */
  async function withCongestion(options = {}) {
    const bp = new PowerBackpressure({
      capacity: 8,
      refillInterval: 4,
      refillAmount: 8,
      lowWaterMark: 2,
      adaptive: true,
      ...options,
    });
    const steps = [];
    const realStep = bp._aimdStep.bind(bp);
    bp._aimdStep = function patched() {
      const before = this._refillAmount;
      const inFlight = this._inFlight;
      realStep();
      steps.push({ before, after: this._refillAmount, inFlight });
    };
    const loops = [];
    for (let p = 0; p < 16; p += 1) {
      loops.push(
        (async () => {
          try {
            await bp.acquire();
            await new Promise(() => {});
          } catch {
            /* queue full */
          }
        })()
      );
    }
    return { bp, steps, stop: () => bp.dispose() };
  }

  it('keeps taking decisions while the gate stays oversubscribed', async () => {
    // The regression assertion, and the one that fails on the old code: two
    // decisions, then a controller that had stopped. Nothing here depends on
    // *when* they happen, only that the count keeps climbing.
    const { steps, stop } = await withCongestion();
    const deadline = Date.now() + 2000;
    while (steps.length < 20 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    stop();

    // 20+ decisions, where the broken code managed 2 in 400ms and then stopped
    // for good. A floor, not an exact count: the exact number is a function of
    // timer resolution, so pinning it would be pinning the harness.
    expect(steps.length).toBeGreaterThanOrEqual(20);
    // Every record carries the signal and both window values, so the count above
    // is counting decisions rather than a loop that spun without deciding.
    expect(steps.every((s) => typeof s.after === 'number' && typeof s.inFlight === 'number')).toBe(
      true
    );
    // Every decision here is a cut, which is the correct answer to this workload
    // specifically: 16 permits out, none of them ever returned, so the loss
    // signal is permanently asserted. The growth branch needs a *returning*
    // permit and is covered by `test/powerBackpressure.aimd.test.js`; asserting
    // it here would be asserting that a permanently broken consumer looks
    // healthy.
    expect(steps.every((s) => s.after <= s.before)).toBe(true);
    expect(steps.filter((s) => s.after < s.before).length).toBeGreaterThan(0);
  });

  it('cuts the window to its floor under sustained congestion', async () => {
    // The outcome, and a shape rather than a bound: every permit is out and
    // nothing is coming back, so the loss signal is permanently asserted and a
    // loss-based controller must converge on its floor. The old code stopped at
    // 2 of a floor of 1 and stayed there.
    const { bp, stop } = await withCongestion();
    const deadline = Date.now() + 2000;
    while (bp.refillAmount > bp._adaptive.min && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    const settled = bp.refillAmount;
    const floor = bp._adaptive.min;
    // Still oversubscribed throughout — the floor is being held under
    // congestion, not reached because the load went away.
    expect(bp._inFlight).toBeGreaterThanOrEqual(bp.capacity);
    // ...and the probe is still armed, because the condition has not lifted.
    expect(bp._refillTimer).not.toBeNull();
    stop();
    expect(settled).toBe(floor);
  });

  it('stops probing when the gate goes quiet, rather than ticking for its lifetime', async () => {
    // The termination condition that makes honouring the heartbeat affordable.
    // Without it, fixing the blindness buys an `unref()`'d timer that runs for
    // as long as the object lives, learning only that the window should grow.
    const bp = new PowerBackpressure({
      capacity: 2,
      refillInterval: 4,
      refillAmount: 1,
      lowWaterMark: 1,
      adaptive: true,
    });
    const first = await bp.acquire();
    const second = await bp.acquire();
    const queued = bp.acquire();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // A producer did queue, so the heartbeat is engaged and a tick is pending.
    expect(bp._adaptiveHeartbeat).toBe(true);
    expect(bp._refillTimer).not.toBeNull();

    first();
    second();
    const third = await queued;
    // One permit is still outstanding, so there is still something to observe and
    // the probe must stay armed — this is the branch that actually runs under
    // sustained congestion, because the refill has just drained the queue.
    expect(bp._inFlight).toBe(1);
    expect(bp._adaptiveHeartbeat).toBe(true);

    third();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bp._inFlight).toBe(0);
    expect(bp._adaptiveHeartbeat).toBe(false);
    expect(bp._refillTimer).toBeNull();
    bp.dispose();
  });

  it('adaptive: false arms no heartbeat and keeps no timer alive', async () => {
    // The opt-in boundary, and the reason the fix is cheap: the heartbeat only
    // exists for a caller who asked for adaptation, so a default-constructed
    // controller gains no timer at all. This is the test that stops the fix
    // becoming "every PowerBackpressure polls forever".
    const bp = new PowerBackpressure({
      capacity: 2,
      refillInterval: 4,
      refillAmount: 1,
      lowWaterMark: 1,
    });
    const first = await bp.acquire();
    const second = await bp.acquire();
    const queued = bp.acquire();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(bp._adaptiveHeartbeat).toBe(false);
    // It still relieves the queue once, which is the documented behaviour of a
    // non-adaptive controller — it mints, it does not tune.
    const third = await queued;
    expect(bp.pending).toBe(0);
    first();
    second();
    third();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(bp._refillTimer).toBeNull();
    bp.dispose();
  });
});
