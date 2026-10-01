import { describe, it, expect, vi } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';

/**
 * PERF-007: thread a single `now` through a limiter composition.
 *
 * `nowMs()` reads *two* clocks per call - the high-resolution one and
 * `Date.now()`, the second purely to check the two have not diverged under a
 * test harness - and measures ~141 ns. An N-limiter composition therefore spent
 * N of those on deciding what time it was, which is most of the work of the call
 * and all of it duplicated: every limiter inside one `tryConsume` is deciding
 * at the same instant.
 *
 * These check the *contract*, not the speed. A benchmark would be noise on
 * shared CI, and the review's own note is that the previous attempt at this
 * landed below the noise floor. What is testable is that every leg is handed
 * the same reading, and - the part that needs pinning - that a leg which
 * injected its own clock is never overruled.
 *
 * A note on the shape of the API, because it is not symmetric and the asymmetry
 * is deliberate: on the *limiters* `now` is a constructor option that must be a
 * **function**; on the *composition* it is a per-call option that must be a
 * **number**. One name, two types, two kinds of object. The composer gets no
 * constructor injection at all, because the per-call value covers every use it
 * did - the composer reads once and tells everyone.
 */
describe('limiter clock injection', () => {
  /**
   * A leg that records the instant it was handed, so "one reading, shared by
   * every leg" is directly observable. A real limiter cannot show this, because
   * a correctly-behaved one either reads its own clock or adopts the value, and
   * both look the same from outside.
   */
  const recordingLeg = (name, seen) => ({
    name,
    tryConsume(_n, options) {
      seen.push(options?.now);
      return true;
    },
    available(options) {
      seen.push(options?.now);
      return 100;
    },
  });

  it('accepts a `now` function on every limiter and rejects a non-function', () => {
    const limiters = [
      (now) => new PowerThrottle({ capacity: 100, now }),
      (now) => new PowerSlidingWindow({ capacity: 100, windowMs: 1000, now }),
      (now) => new PowerGCRA({ rate: 100, burst: 100, now }),
    ];
    for (const make of limiters) {
      expect(make(() => 1000)).toBeInstanceOf(Object);
      expect(() => make('not a function')).toThrow('`now` must be a function');
      expect(() => make(1234)).toThrow('`now` must be a function');
    }
  });

  it('uses the injected clock rather than the real one', () => {
    let clock = 0;
    const now = () => clock;
    // `refillRate` is not optional to this test: at the default of 0 the bucket
    // never refills, so advancing the clock would change nothing and the
    // assertion would pass for the wrong reason.
    const throttle = new PowerThrottle({ capacity: 1, refillRate: 100, now });
    expect(throttle.tryConsume()).toBe(true);
    // Nothing has refilled, because no *injected* time has passed - even though
    // real time certainly has.
    expect(throttle.tryConsume()).toBe(false);
    clock = 100_000;
    expect(throttle.tryConsume()).toBe(true);
  });

  it('hands every leg the same reading', () => {
    // The load-bearing property: one reading, shared. Before, each leg went and
    // read its own clock, so a limiter straddling a window boundary would prune
    // against one instant and record against another.
    const seen = [];
    const composed = new PowerRateLimit([
      recordingLeg('a', seen),
      recordingLeg('b', seen),
      recordingLeg('c', seen),
    ]);
    composed.tryConsume(1);
    // More records than legs, because the default atomic path asks each leg
    // `available()` before committing and then calls `tryConsume` - two touches
    // per leg. The count is not the point; that every touch saw the *same*
    // instant is, and it is what the threading buys.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
    // A real reading, not a placeholder.
    expect(typeof seen[0]).toBe('number');
    expect(Math.abs(Date.now() - seen[0])).toBeLessThan(1000);
  });

  it('honours a per-call `now` over the clock it would otherwise read', () => {
    const seen = [];
    new PowerRateLimit([recordingLeg('a', seen)]).tryConsume(1, { now: 4242 });
    // Both the availability pre-flight and the commit carry the caller's value.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === 4242)).toBe(true);
  });

  it('uses the per-call `now` to steer a throttle, a window and a GCRA alike', () => {
    // Otherwise "threaded" would only mean the composition paid for a reading it
    // then ignored.
    let clock = 0;
    const now = () => clock;
    const throttle = new PowerThrottle({ capacity: 1, refillRate: 100, now });
    const window = new PowerSlidingWindow({ capacity: 1, windowMs: 1000, now });
    const gcra = new PowerGCRA({ rate: 1, per: 1000, burst: 0, now });
    for (const limiter of [throttle, window, gcra]) expect(limiter.tryConsume(1)).toBe(true);

    // One second later, all three must admit again, because all three were told
    // the same time rather than each reading a clock of its own.
    clock = 1_000;
    expect(throttle.tryConsume(1)).toBe(true);
    expect(window.tryConsume(1)).toBe(true);
    expect(gcra.tryConsume(1)).toBe(true);
  });

  it('honours a per-call `now` on a limiter used directly, with no injected clock', () => {
    // QUAL-011 (F8). Every path above goes through an injected `now` or through
    // the composition. This is the case a caller actually writes — construct a
    // limiter with no clock at all, then stamp individual calls — and it is the
    // one the published types now promise via `options?: LimiterNowOptions`
    // (previously `options?: {}`, which type-checked anything and told the caller
    // nothing). Declaring an option is a promise that it works, so it is pinned
    // here rather than inferred from the composed cases above.
    const throttle = new PowerThrottle({ capacity: 2, refillRate: 1 });
    const window = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });

    expect(throttle.tryConsume(2)).toBe(true);
    expect(window.tryConsume(2)).toBe(true);

    // One window's worth of expiry on the window — derived purely from the
    // per-call stamp, with no injected clock involved.
    const later = Date.now() + 2_000;
    expect(window.available({ now: later })).toBe(2);

    // The throttle pins a subtlety that is easy to get wrong in either
    // direction. `_lastRefill` is seeded from the real clock at construction
    // (`powerThrottle.js:_refill` clamps `elapsedMs` to `Math.max(0, …)`), so a
    // per-call stamp refills only when it is *ahead* of that seed. One second
    // past it refills one token at `refillRate: 1`; a stamp behind it is inert
    // rather than an error, because a negative delta cannot un-refill.
    //
    // Asserted because this reads as "the option is being ignored" otherwise —
    // which is exactly the wrong conclusion to draw, and the one that cost time
    // while writing the declaration this test accompanies.
    //
    // The window is wide deliberately: `tryConsume` above seeded `_lastRefill`
    // from the real clock, so a stamp 1 s ahead yields a fraction of a token
    // at `refillRate: 1` (one token *per second*) and floors to zero. 10 s
    // ahead is unambiguous and not sensitive to scheduling jitter.
    expect(throttle.available({ now: Date.now() + 10_000 })).toBe(2);
    expect(throttle.available({ now: 0 })).toBe(2);
    expect(throttle.available({ now: -5_000 })).toBe(2);
    // Nothing is taken from the bucket by an impossible timestamp.
    expect(throttle.tokens).toBe(2);
  });

  it('lets an injected clock win over a threaded one, observably', () => {
    // The precedence rule, and the reason it is not "per-call value first". A
    // limiter built with a fake clock is a limiter under test; if the composer
    // overrode it, the test would silently start measuring something else.
    //
    // Call counts cannot show which *value* a limiter used, so this shows it
    // through behaviour: a throttle with a frozen clock at t=1000 and a refill
    // rate sees zero elapsed time and does not refill. Had the composer leaked
    // its reading into the limiter, elapsed time would be enormous.
    let clock = 1_000;
    const throttle = new PowerThrottle({
      capacity: 1,
      refillRate: 100,
      now: () => clock,
    });
    const composed = new PowerRateLimit([throttle]);
    expect(composed.tryConsume(1, { now: 9_999_999 })).toBe(true);
    expect(composed.tryConsume(1, { now: 9_999_999 })).toBe(false);
    // Advancing the limiter's *own* clock is what makes it admit again - the
    // composer's value cannot do it.
    clock = 1_000_000;
    expect(composed.tryConsume(1, { now: 9_999_999 })).toBe(true);
  });

  it('uses each injected clock when a leg brings one', () => {
    const throttleNow = vi.fn(() => 1_000);
    const windowNow = vi.fn(() => 2_000);
    const solo = new PowerRateLimit([
      new PowerThrottle({ capacity: 10, now: throttleNow }),
      new PowerSlidingWindow({ capacity: 10, windowMs: 1000, now: windowNow }),
    ]);
    solo.tryConsume(1);
    expect(throttleNow).toHaveBeenCalled();
    expect(windowNow).toHaveBeenCalled();
  });

  it('is a no-op for a third-party limiter that ignores the second argument', () => {
    // The reason threading needs no capability check on the limiter: one the
    // library did not write reads its own clock and the extra argument is inert.
    const calls = [];
    const foreign = {
      tryConsume(n, options) {
        calls.push(options);
        return true;
      },
      available(options) {
        calls.push(options);
        return 10;
      },
    };
    expect(new PowerRateLimit([foreign]).tryConsume(1, { now: 4242 })).toBe(true);
    expect(calls[0].now).toBe(4242);
  });

  it('keeps the atomic pre-flight and available() on one reading too', () => {
    // `available()` walks every limiter as well, and used to read the clock per
    // limiter - a second N reads per composed call.
    const seen = [];
    const composed = new PowerRateLimit([recordingLeg('a', seen), recordingLeg('b', seen)]);
    composed.available();
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1);

    seen.length = 0;
    composed.tryConsume(1, { now: 777 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === 777)).toBe(true);
  });

  it('does not change limiter behaviour when no clock is supplied anywhere', () => {
    // The regression guard that matters most: a caller who knows nothing about
    // this option must get identical behaviour.
    const t = new PowerThrottle({ capacity: 2, refillRate: 0 });
    expect(t.tryConsume()).toBe(true);
    expect(t.tryConsume()).toBe(true);
    expect(t.tryConsume()).toBe(false);

    const w = new PowerSlidingWindow({ capacity: 2, windowMs: 60_000 });
    expect(w.tryConsume()).toBe(true);
    expect(w.tryConsume()).toBe(true);
    expect(w.tryConsume()).toBe(false);

    // `burst: 0` admits exactly the steady-state spacing, so the second call in
    // the same millisecond is refused. `burst: 2` would admit three (one steady
    // plus two extra), which is correct and is why this pins 0.
    const g = new PowerGCRA({ rate: 1, per: 1000, burst: 0 });
    expect(g.tryConsume()).toBe(true);
    expect(g.tryConsume()).toBe(false);
  });

  it('treats a per-call `now` as authoritative, which is the sharp edge', () => {
    // A threaded time far in the future legitimately empties a sliding window.
    // That is correct - it is what a real clock jumping would do - and it is why
    // a caller must thread one instant for the whole composition rather than
    // letting each leg drift.
    const real = Date.now();
    const window = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });
    expect(window.tryConsume(2)).toBe(true);
    expect(window.tryConsume(1, { now: real })).toBe(false);
    // Comfortably more than a window, so the reading is past every timestamp
    // already recorded. `real` itself is captured *before* the pushes, so
    // `real + windowMs` would still sit on the near side of them.
    expect(window.tryConsume(1, { now: real + 5000 })).toBe(true);
  });
});
