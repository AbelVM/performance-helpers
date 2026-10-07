import { describe, it, expect } from 'vitest';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';

/**
 * LIM-001 — `onError` fires on every ordinary refusal, so a correctly
 * rate-limiting limiter looks broken to anything watching it.
 *
 * The predicate was `now < this._tat`. A TAT ahead of `now` is not a clock
 * fault — it is **the normal saturated state**, and it is exactly what a limiter
 * looks like while it is doing its job. Measured at `rate: 1, burst: 1`:
 * **19 refusals produced 19 `onError` calls**, each carrying the raw clock
 * reading (a number, not an `Error`), on a clock that never moved backwards.
 *
 * The documented contract is the opposite. `PowerGCRAOptions.onError` is
 * `onError(function(err))` called "when the internal clock misbehaves", so an
 * observer wired to it is told that a working limiter is faulty, and a real
 * backwards step — the event it exists for — was indistinguishable from the
 * noise.
 *
 * `rg -n onError test/powerGCRA.test.js` returned nothing before this file: the
 * option was documented, implemented, and never tested, which is why a predicate
 * reading the wrong variable survived.
 */
describe('PowerGCRA.onError reports clock faults, not refusals', () => {
  it('stays silent while the limiter is rate-limiting correctly', () => {
    // The regression, in the shape that makes it obvious: ask a saturated
    // limiter for more than it has, repeatedly, and watch the clock alone.
    const errors = [];
    const g = new PowerGCRA({
      rate: 1,
      burst: 1,
      now: () => 1000,
      onError: (e) => errors.push(e),
    });

    let refusals = 0;
    for (let i = 0; i < 20; i += 1) {
      if (!g.tryConsume(1)) refusals += 1;
    }

    expect(refusals, 'the limiter must actually be refusing').toBeGreaterThan(5);
    expect(errors, 'a correct limiter must not report a clock fault').toHaveLength(0);
  });

  it('stays silent across many forward clock steps', () => {
    // A weaker form of the same thing, and the one a logger would see over a
    // normal run: a healthy clock moving forwards must never report. Pins that
    // the fix is not simply "never report".
    const errors = [];
    let t = 0;
    const g = new PowerGCRA({ rate: 1, burst: 1, now: () => t, onError: (e) => errors.push(e) });

    for (let i = 0; i < 10; i += 1) {
      t += 1000;
      g.tryConsume(1);
    }

    expect(errors).toHaveLength(0);
  });

  it('reports a genuine backwards clock step', () => {
    // The event the option exists for. NTP, a suspended host, a test driving the
    // clock by hand: the reading moves backwards while the limiter is idle.
    const errors = [];
    let t = 100_000;
    const g = new PowerGCRA({ rate: 1, burst: 1, now: () => t, onError: (e) => errors.push(e) });

    g.tryConsume(1); // first reading: no previous one to compare against
    t -= 10_000; // the clock jumps back ten seconds
    g.tryConsume(1);

    expect(errors, 'a backwards clock must be visible').toHaveLength(1);
    expect(errors[0], 'the offending reading, not an Error').toBe(90_000);
  });

  it('recovers after a forward step and reports a later backward step', () => {
    const errors = [];
    let t = 1000;
    const g = new PowerGCRA({ rate: 1, burst: 1, now: () => t, onError: (e) => errors.push(e) });

    g.tryConsume(1);
    t += 10_000;
    g.tryConsume(1);
    t -= 5000;
    g.tryConsume(1);

    expect(errors).toEqual([6000]);
  });

  it('does not report on the very first reading', () => {
    // The `_lastNow === null` guard. Without it a freshly constructed limiter
    // reports once against a clock that has not moved at all, which is the same
    // false positive as a refusal — just once.
    const errors = [];
    const t = 5_000;
    const g = new PowerGCRA({ rate: 1, burst: 1, now: () => t, onError: (e) => errors.push(e) });
    g.tryConsume(1);
    expect(errors).toHaveLength(0);
  });

  it('still admits at a bounded rate while reporting the fault', () => {
    // The report is observability, never safety: a backwards clock must not let
    // unbounded traffic through, and must not throw either. The clamp below the
    // report is what guarantees that, and this pins both halves.
    const errors = [];
    let t = 100_000;
    const g = new PowerGCRA({
      rate: 10,
      burst: 1,
      now: () => t,
      onError: (e) => errors.push(e),
    });

    expect(g.tryConsume(1)).toBe(true);
    t -= 60_000; // a minute backwards
    // Safe rather than throwing, and still not a free-for-all.
    expect(() => g.tryConsume(1)).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('a throwing onError still cannot break admission', () => {
    // The individual guard on `_notifyClock` predates this fix and is the reason
    // the option is safe to wire up at all. Kept, because the new predicate
    // makes the callback reachable in situations it was not before.
    let t = 1000;
    const g = new PowerGCRA({
      rate: 1,
      burst: 1,
      now: () => t,
      onError: () => {
        throw new Error('logger exploded');
      },
    });
    expect(g.tryConsume(1)).toBe(true);
    t -= 5_000;
    expect(g.tryConsume(1)).toBe(false);
  });
});
