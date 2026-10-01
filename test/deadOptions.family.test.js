/**
 * RES-017: four documented-but-dead options, and two of them were not what the
 * row said.
 *
 * The row grouped all four as "inert or contradictory". Measured, they split
 * three ways, and only the first pair is actually dead:
 *
 *   1. `PowerThrottle.refillInterval` — **inert, and unimplementable as
 *      described.** Destructured, validated, typed, published, and never read.
 *      The bucket refills lazily and *proportionally* to elapsed time on every
 *      read, so a token is earned every `1000 / refillRate` ms whether or not
 *      anything observes it. There is no interval in the design to configure:
 *      honouring one would mean a timer and a strictly worse model to express
 *      the same arithmetic. Removed.
 *   2. `PowerGCRA.onError` — **inert, and implementable.** Documented for a
 *      backwards clock and never called. But the clamp it describes was already
 *      there — `Math.max(now, this._tat)` — so the safety half of the promise
 *      held while the observable half did not. Now it is called, and the clamp is
 *      what keeps it non-throwing as documented.
 *   3. `PowerRetryOptions.attemptTimeout` — **not inert, mis-documented.** The
 *      published type said a timed-out attempt is "**not** retried … retrying
 *      would multiply it by `maxAttempts`". Measured with `attemptTimeout: 40`
 *      and `maxAttempts: 3`: **three attempts**, ~328 ms. The doc promised a
 *      guarantee the code does not make, and in the direction that misleads a
 *      caller choosing a bound.
 *   4. `PowerCron._fireCount` — **not inert either, and real.** It is read by two
 *      getters. Its *doc* claimed it counts catch-up replays of periods missed
 *      while stopped, which `start()` cannot produce: it sets
 *      `_nextAt = nowMs() + intervalMs`, so a restart begins a fresh cadence.
 *
 * Every assertion is a count, a call count, or a returned value.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerCron } from '../src/helpers/powerCron.js';

describe('PowerGCRA.onError is called for a backwards clock', () => {
  it('reports the offending reading', () => {
    // The defect: `onError` was stored and never invoked, so a limiter running
    // on a clock that jumped was silently clamping.
    const onError = vi.fn();
    let t = 10_000;
    const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 0, now: () => t, onError });

    expect(gcra.tryConsume()).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    // Move the clock backwards, as NTP or a suspended host would.
    t = 5_000;
    gcra.tryConsume();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(5_000);
  });

  it('does not throw, because the clamp is what provides the bound', () => {
    // The documented contract is "instead of throwing". The safety half was
    // already real — `Math.max(now, this._tat)` — so a backwards clock cannot
    // admit unbounded traffic and calling the hook changes nothing about that.
    const onError = vi.fn();
    let t = 10_000;
    const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 0, now: () => t, onError });
    gcra.tryConsume();

    t = 1;
    expect(() => gcra.tryConsume()).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('a throwing onError does not break admission', () => {
    // Individually guarded, because this runs inside `tryConsume`: a user
    // callback that throws would otherwise replace a rate-limit decision with an
    // exception the caller did not ask for.
    //
    // The property is that the handler changes **nothing** about the decision, so
    // the comparison is against a limiter with no handler at all. The first
    // version asserted `true` and read `false` — which was the limiter correctly
    // refusing, having been saturated by the previous consume, and not the
    // handler throwing at all.
    const attempt = (handler) => {
      let t = 10_000;
      const gcra = new PowerGCRA({
        rate: 10,
        per: 1000,
        burst: 0,
        now: () => t,
        ...(handler ? { onError: handler } : {}),
      });
      gcra.tryConsume();
      t = 1; // backwards
      return () => gcra.tryConsume();
    };
    const withoutHandler = attempt(null);
    const withThrowing = attempt(() => {
      throw new Error('handler is broken');
    });
    expect(withThrowing()).toBe(withoutHandler());
  });

  it('does not fire when the clock moves forward', () => {
    // The counterpart, and the reason this is not "reports every consume".
    const onError = vi.fn();
    let t = 10_000;
    const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 0, now: () => t, onError });
    for (let i = 1; i <= 5; i += 1) {
      t += 5_000;
      gcra.tryConsume();
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it('is still optional', () => {
    let t = 10_000;
    const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 0, now: () => t });
    gcra.tryConsume();
    t = 1;
    expect(() => gcra.tryConsume()).not.toThrow();
  });
});

describe('PowerThrottle has no refillInterval', () => {
  it('is not a property of the instance', () => {
    // Removed rather than left inert, for the reason every inert option is
    // removed here: a caller can set it and believe it did something.
    const throttle = new PowerThrottle({ capacity: 10, refillRate: 5 });
    expect('refillInterval' in throttle).toBe(false);
  });

  it('refills proportionally to elapsed time, which is what the option promised to bound', () => {
    // The behaviour that made the option meaningless, pinned so the removal
    // cannot be read as losing a capability: tokens accrue with elapsed time on
    // every read, and nothing has to be scheduled for that to happen.
    let t = 1_000_000;
    // Drained to start, so the refill is observable rather than hidden by the
    // capacity clamp.
    const throttle = new PowerThrottle({ capacity: 100, tokens: 0, refillRate: 10, now: () => t });
    expect(throttle.tokens).toBe(0);

    t += 1_000; // one second at 10 tokens/sec
    throttle.tryConsume(1);

    // 10 earned, 1 spent. A `tryConsume(0)` would not show this: it returns
    // before the refill, which is what the first version of this test did.
    expect(throttle.tokens).toBe(9);
  });

  it('an unknown option is an error naming the option, not a silent no-op', () => {
    // This previously read "an unknown option is ignored rather than erroring",
    // justified by: a caller already passing `refillInterval` could not have
    // been depending on behaviour that never existed. Sound for a **removed**
    // option; it does not cover a **misspelled** one, which is the common case
    // and the one that reaches production:
    //
    //     new PowerThrottle({ capacity: 10, refillRat: 5 })
    //
    // builds a bucket that never refills — nothing thrown, nothing warned, and
    // indistinguishable from a correct limiter until a request is refused. The
    // same tolerance let nine tests across six classes pass options that do not
    // exist, every one of them asserting nothing, and let
    // `guides/powerThrottle.md` document `refillInterval` as live.
    //
    // The removed-option caller now gets an error at construction rather than
    // silence at request time.
    expect(() => new PowerThrottle({ capacity: 10, refillRate: 5, refillInterval: 999 })).toThrow(
      /^PowerThrottle: unknown option `refillInterval`\./
    );
  });

  it('names the intended option when there is an obvious near miss', () => {
    // "unknown option `refillRat`" is much less use than this.
    let err = null;
    try {
      new PowerThrottle({ capacity: 10, refillRat: 5 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toMatch(/Did you mean `refillRate`\?/);
    // Machine-readable, so a caller need not parse the message.
    expect(err.code).toBe('ERR_UNKNOWN_OPTION');
    expect(err.option).toBe('refillRat');
  });

  it('offers no suggestion when nothing is close enough', () => {
    // A wrong suggestion is worse than none, so the threshold scales with the
    // length of the word rather than always naming the nearest option.
    expect(() => new PowerThrottle({ capacity: 10, zzzzzzzzzzz: 5 })).toThrow(
      /^PowerThrottle: unknown option `zzzzzzzzzzz`\. Accepted options:/
    );
  });
});

describe('PowerCron._fireCount counts invocations, not catch-up', () => {
  it('a restart begins a fresh cadence rather than replaying missed periods', () => {
    // What the corrected doc claims and the old one denied. `start()` sets
    // `_nextAt = now + interval`, so periods missed while stopped are not
    // replayed — the right behaviour for a cron, since replaying a backlog after
    // a deploy would stamp a dozen tasks at once.
    //
    // Fake timers, because this is about *how many* times the task runs over a
    // span of simulated time, and counting runs is the whole point.
    vi.useFakeTimers();
    try {
      const task = vi.fn();
      const cron = new PowerCron(task, { intervalMs: 100 });

      cron.start();
      cron.stop();
      // 25 intervals pass with nothing running. The first version of this test
      // forgot the `stop()` and advanced the clock on a *running* cron, so it
      // observed 25 ordinary firings and called it a catch-up failure — the
      // assertion was about a scenario that was never arranged.
      vi.advanceTimersByTime(2_500);
      expect(task).not.toHaveBeenCalled();

      cron.start();
      vi.advanceTimersByTime(100); // exactly one interval

      // **One** run, not 26. A catch-up implementation would replay the backlog.
      expect(task).toHaveBeenCalledTimes(1);
      // And the counter agrees, which is what `fireCount` documents.
      expect(cron.fireCount).toBe(1);
      cron.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
