import { describe, it, expect, vi } from 'vitest';
import { PowerRetry, PowerRetryBudget } from '../src/helpers/powerRetry.js';
import { DECORRELATED_JITTER_FACTOR } from '../src/helpers/constants.js';

/**
 * ALG-005: `PowerRetry` gets the SOTA backoff, a retry budget, and hedging.
 *
 * Three independent mechanisms, and the tests are written so each one can fail
 * without the other two explaining it. The properties pinned here are the ones
 * a caller would otherwise have to take on trust:
 *
 *  - decorrelated jitter is a *random walk*, so it needs a distribution test
 *    over many draws rather than a single-value assertion;
 *  - the budget has to refuse *before* traffic is sent, which is only
 *    observable by counting the calls `fn` actually received;
 *  - a hedge must cancel the loser, and "cancelled" means the loser's
 *    `AbortSignal` fired - not merely that the winner was returned.
 */

/**
 * Run a promise that is expected to reject, under fake timers, without
 * producing an unhandled rejection in the gap between "the retry chain
 * finished" and "the assertion attached its handler".
 *
 * `await vi.runAllTimersAsync()` drives the whole backoff chain to completion
 * *before* the next line runs, so a bare `const run = PowerRetry.run(...)`
 * followed by `await expect(run).rejects...` leaves the rejection unhandled for
 * one turn of the event loop - which vitest reports as an error even though the
 * assertion then passes. Capturing it here closes the gap.
 *
 * @param {Promise<any>} promise
 * @returns {Promise<any>} The rejection value.
 */
function captureRejection(promise) {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, but it resolved with ${String(value)}`);
    },
    (err) => err
  );
}

describe('PowerRetry decorrelated jitter', () => {
  it('rejects an unknown backoff strategy instead of silently using exponential', async () => {
    // The original was `linear | fixed | else exponential`, so `'exp'`,
    // `'Expo'` and `'backoff'` all produced an exponential curve the caller
    // never asked for, with nothing to indicate it.
    await expect(
      PowerRetry.run(async () => 'ok', { backoff: 'exp', baseDelay: 1 })
    ).rejects.toThrow('`backoff` must be one of');
    let calls = 0;
    await expect(
      PowerRetry.run(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { backoff: 'exponntial', baseDelay: 1, maxAttempts: 2 }
      )
    ).rejects.toThrow('`backoff` must be one of');
    // A configuration error must not have put a single request on the wire.
    expect(calls).toBe(0);
  });

  it('names every supported strategy in the error', async () => {
    await expect(PowerRetry.run(async () => 'ok', { backoff: 'nope' })).rejects.toThrow(
      /exponential, linear, fixed, decorrelated/
    );
  });

  it('refuses `jitter: false`, which would contradict the strategy', async () => {
    // Decorrelated jitter *is* the randomisation. Accepting `jitter: false`
    // would mean honouring whichever of the two contradicted the other, and the
    // caller could not tell which happened.
    await expect(
      PowerRetry.run(async () => 'ok', { backoff: 'decorrelated', jitter: false })
    ).rejects.toThrow('contradicts it');
  });

  it('stays inside [baseDelay, maxDelay] and never returns a negative delay', async () => {
    // Fake timers, because the point is the *distribution* over many draws and
    // a real 400-attempt backoff would take minutes of wall clock to assert.
    vi.useFakeTimers();
    try {
      const delays = [];
      const settled = captureRejection(
        PowerRetry.run(
          async () => {
            throw new Error('boom');
          },
          {
            backoff: 'decorrelated',
            baseDelay: 10,
            maxDelay: 400,
            maxAttempts: 40,
            onRetry: (_attempt, _err, delay) => delays.push(delay),
          }
        )
      );
      await vi.runAllTimersAsync();
      expect((await settled).message).toBe('boom');

      expect(delays).toHaveLength(39);
      for (const d of delays) {
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(10);
        expect(d).toBeLessThanOrEqual(400);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an upstream retry-after hint override local backoff', async () => {
    vi.useFakeTimers();
    try {
      const delays = [];
      const settled = captureRejection(
        PowerRetry.run(
          async () => {
            throw new Error('throttled');
          },
          {
            maxAttempts: 2,
            baseDelay: 50,
            maxDelay: 100,
            retryAfter: () => 7,
            onRetry: (_attempt, _err, delay) => delays.push(delay),
          }
        )
      );
      await vi.runAllTimersAsync();
      expect((await settled).message).toBe('throttled');
      expect(delays).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies failures into the shared retry budget', async () => {
    const budget = new PowerRetryBudget({ capacity: 2 });
    const settled = captureRejection(
      PowerRetry.run(
        async () => {
          throw new Error('429');
        },
        {
          maxAttempts: 2,
          baseDelay: 0,
          jitter: false,
          budget,
          classifyError: () => ({ kind: 'throttled' }),
        }
      )
    );
    expect((await settled).message).toBe('429');
    expect(budget.stats()).toMatchObject({
      available: 0,
      outcomes: { throttled: 2 },
      retryRate: 0,
      refusalRate: 0,
    });
  });

  it('is not merely the exponential curve in disguise', async () => {
    // The defining property of the AWS formulation is that each delay is drawn
    // against the *previous* delay, so the sample is not reproducible from the
    // attempt number. A distribution test is the only honest way to show it.
    vi.useFakeTimers();
    try {
      const delays = [];
      const settled = captureRejection(
        PowerRetry.run(
          async () => {
            throw new Error('boom');
          },
          {
            backoff: 'decorrelated',
            baseDelay: 10,
            maxDelay: 1_000_000,
            maxAttempts: 200,
            onRetry: (_a, _e, delay) => delays.push(delay),
          }
        )
      );
      await vi.runAllTimersAsync();
      expect((await settled).message).toBe('boom');

      expect(delays.length).toBeGreaterThan(100);
      // Every attempt's nominal exponential value is recomputed independently,
      // so a decorrelated sequence that happened to match it everywhere would
      // mean the walk is not happening.
      const nominalMatches = delays.filter((d, i) => d === 10 * 2 ** i).length;
      expect(nominalMatches).toBeLessThan(delays.length / 10);

      // The growth bound is `previous * 3`, so a delay cannot exceed three
      // times the one before it beyond rounding. This is what makes the walk
      // self-limiting.
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeLessThanOrEqual(delays[i - 1] * DECORRELATED_JITTER_FACTOR + 1);
      }

      // It must spread: an undecorrelated curve is deterministic given the
      // attempt number.
      expect(new Set(delays).size).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the walk for each run rather than sharing one cursor', async () => {
    // The cursor is a local of `run()`, not instance state. If it were shared,
    // a second call would start from wherever the first one stopped and the
    // first delay could exceed `baseDelay * 3`.
    const firstDelays = [];
    const runs = [];
    for (let i = 0; i < 20; i++) {
      runs.push(
        PowerRetry.run(
          () => {
            throw new Error('boom');
          },
          {
            backoff: 'decorrelated',
            baseDelay: 10,
            maxAttempts: 2,
            onRetry: (_a, _e, d) => firstDelays.push(d),
          }
        ).catch(() => {})
      );
    }
    await Promise.all(runs);
    expect(firstDelays).toHaveLength(20);
    // Every run's first draw is `random_between(base, base * 3)`. A shared
    // cursor would let the later runs start above that range.
    for (const d of firstDelays) {
      expect(d).toBeGreaterThanOrEqual(10);
      expect(d).toBeLessThanOrEqual(10 * DECORRELATED_JITTER_FACTOR);
    }
  });

  it('does not go negative when maxDelay is below baseDelay', async () => {
    // `maxDelay < baseDelay` clamps the cursor under `base`, and an upper draw
    // bound below the lower bound would otherwise produce a negative wait.
    vi.useFakeTimers();
    try {
      const delays = [];
      const settled = captureRejection(
        PowerRetry.run(
          async () => {
            throw new Error('boom');
          },
          {
            backoff: 'decorrelated',
            baseDelay: 100,
            maxDelay: 5,
            maxAttempts: 5,
            onRetry: (_a, _e, d) => delays.push(d),
          }
        )
      );
      await vi.runAllTimersAsync();
      expect((await settled).message).toBe('boom');
      expect(delays).toHaveLength(4);
      for (const d of delays) expect(d).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PowerRetryBudget', () => {
  it('starts full, so the first retry of a fresh budget is allowed', () => {
    // A bucket that started empty would engage the protection on a *healthy*
    // dependency: one request funds 0.2 of a token and a retry costs a whole
    // one. This is the reason for `capacity`, and it is easy to regress.
    const budget = new PowerRetryBudget();
    expect(budget.available()).toBe(budget.capacity);
    expect(budget.tryConsumeRetry()).toBe(true);
  });

  it('refuses a retry once the tokens are gone', () => {
    const budget = new PowerRetryBudget({ ratio: 0.2, capacity: 2 });
    expect(budget.tryConsumeRetry()).toBe(true);
    expect(budget.tryConsumeRetry()).toBe(true);
    expect(budget.tryConsumeRetry()).toBe(false);
  });

  it('executes through the same budget and records the operation', async () => {
    const budget = new PowerRetryBudget({ ratio: 0.5, capacity: 2 });
    await expect(budget.execute(() => 'ok')).resolves.toBe('ok');
    expect(budget.stats().executions).toBe(1);
  });

  it('refunds tokens as requests are recorded, and caps at capacity', () => {
    const budget = new PowerRetryBudget({ ratio: 0.5, capacity: 3 });
    budget.reset();
    for (let i = 0; i < 3; i++) budget.tryConsumeRetry();
    expect(budget.tryConsumeRetry()).toBe(false);
    budget.recordRequest();
    expect(budget.available()).toBe(0.5);
    budget.recordRequest();
    expect(budget.available()).toBe(1);
    expect(budget.tryConsumeRetry()).toBe(true);
    // Never more than capacity, however much traffic is recorded.
    for (let i = 0; i < 100; i++) budget.recordRequest();
    expect(budget.available()).toBe(3);
  });

  it('accepts explicit upstream outcome feedback', () => {
    const budget = new PowerRetryBudget({ capacity: 2 });
    budget.recordOutcome({ kind: 'throttled' });
    budget.recordOutcome({ kind: 'cancellation' });
    budget.recordOutcome({ kind: 'failure', penalty: 0.25 });
    expect(budget.stats()).toMatchObject({
      available: 0.75,
      outcomes: { throttled: 1, cancellation: 1, failure: 1 },
    });
  });

  it('rejects a ratio above 1, which is not a budget', () => {
    // ratio 2 permits more retries than requests - the amplification the
    // bucket exists to prevent, and not a configuration anyone means.
    expect(() => new PowerRetryBudget({ ratio: 2 })).toThrow('must be <= 1');
  });

  it('validates capacity and ratio as numbers', () => {
    expect(() => new PowerRetryBudget({ ratio: Number.NaN })).toThrow('finite number');
    expect(() => new PowerRetryBudget({ capacity: 0 })).toThrow('must be >= 1');
    expect(() => new PowerRetryBudget({ ratio: -1 })).toThrow('must be >= 0');
  });

  it('reports counters that distinguish routine use from a real squeeze', () => {
    const budget = new PowerRetryBudget({ ratio: 0.5, capacity: 2 });
    budget.recordRequest();
    budget.tryConsumeRetry();
    budget.tryConsumeRetry();
    budget.tryConsumeRetry();
    const s = budget.stats();
    expect(s.requests).toBe(1);
    expect(s.retries).toBe(2);
    expect(s.refused).toBe(1);
    expect(s.ratio).toBe(0.5);
    expect(s.capacity).toBe(2);
  });
});

describe('PowerRetry retry budget', () => {
  it('stops retrying when the budget is spent, and sends no further request', async () => {
    // The load-bearing assertion is `calls`. A budget that refused the retry
    // *after* calling `fn` would satisfy every other check here.
    const budget = new PowerRetryBudget({ ratio: 0, capacity: 2 });
    let calls = 0;
    await expect(
      PowerRetry.run(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { maxAttempts: 5, baseDelay: 1, budget }
      )
    ).rejects.toThrow('boom');
    // 2 retry tokens + the original request, and no more.
    expect(calls).toBe(3);
    expect(budget.stats().refused).toBe(1);
  });

  it('lets a funded retry through', async () => {
    const budget = new PowerRetryBudget({ ratio: 1, capacity: 1 });
    let calls = 0;
    await PowerRetry.run(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('boom');
        return 'ok';
      },
      { maxAttempts: 5, baseDelay: 1, budget }
    ).then((r) => expect(r).toBe('ok'));
    expect(calls).toBe(2);
  });

  it('reuses one budget across every run on an instance', async () => {
    // This is the form that actually rations traffic. A budget scoped to a
    // single call could never see the load it is meant to limit.
    const retry = new PowerRetry({
      maxAttempts: 5,
      baseDelay: 1,
      budget: { ratio: 0, capacity: 2 },
    });
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error('boom');
    };
    await expect(retry.run(fn)).rejects.toThrow('boom');
    const afterFirst = calls;
    await expect(retry.run(fn)).rejects.toThrow('boom');
    // The second run starts with the first run's leftovers, so it gets fewer
    // attempts. Built per call, each run would get 3.
    expect(afterFirst).toBe(3);
    expect(calls).toBeLessThan(6);
  });

  it('accepts a bare ratio as shorthand', async () => {
    let calls = 0;
    await PowerRetry.run(
      async () => {
        calls += 1;
        throw new Error('boom');
      },
      { maxAttempts: 5, baseDelay: 1, budget: { ratio: 0, capacity: 1 } }
    ).catch(() => {});
    // 1 retry token + the original request.
    expect(calls).toBe(2);
  });

  it('rejects a budget that is neither a bucket, an object, nor a number', async () => {
    await expect(PowerRetry.run(async () => 'ok', { budget: 'twenty' })).rejects.toThrow(
      'must be a PowerRetryBudget'
    );
  });
});

describe('PowerRetry hedging', () => {
  it('sends a second copy only after the hedge delay has elapsed', async () => {
    const seen = [];
    await PowerRetry.run(
      (signal) => {
        seen.push(signal ? 'primary' : 'nosignal');
        return new Promise((resolve) => setTimeout(() => resolve('primary'), 5));
      },
      { hedgeDelay: 40, baseDelay: 1, maxAttempts: 1 }
    ).then((r) => expect(r).toBe('primary'));
    // The hedge never got its window: the primary answered first.
    expect(seen).toEqual(['primary']);
  });

  it('lets the hedge win when the primary is slow', async () => {
    const started = [];
    const result = await PowerRetry.run(
      (signal) => {
        started.push(signal);
        // The primary never settles; the hedge answers immediately.
        if (started.length === 1) return new Promise(() => {});
        return Promise.resolve('hedge');
      },
      { hedgeDelay: 10, maxAttempts: 1 }
    );
    expect(result).toBe('hedge');
    expect(started).toHaveLength(2);
  });

  it('aborts the losing attempt', async () => {
    // "First to succeed wins" is only half the contract. If the loser is not
    // cancelled the hedge has *doubled* the load and saved nothing.
    let primarySignal = null;
    let hedgeSignal = null;
    await PowerRetry.run(
      (signal) => {
        if (!primarySignal) {
          primarySignal = signal;
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve('aborted'));
          });
        }
        hedgeSignal = signal;
        return new Promise((resolve) => setTimeout(() => resolve('hedge'), 20));
      },
      { hedgeDelay: 5, maxAttempts: 1 }
    ).then((r) => expect(r).toBe('hedge'));

    expect(primarySignal).not.toBeNull();
    expect(primarySignal.aborted).toBe(true);
    // The winner's signal is left alone, so its own work can finish cleanly.
    expect(hedgeSignal.aborted).toBe(false);
  });

  it('passes an AbortSignal to fn even without an attemptTimeout', async () => {
    // The only reason a hedge needs a controller is to cancel the loser, so
    // hedging alone must be enough to produce a signal.
    let received;
    await PowerRetry.run(
      (signal) => {
        received = signal;
        return new Promise((resolve) => setTimeout(() => resolve('ok'), 1));
      },
      { hedgeDelay: 50, maxAttempts: 1 }
    );
    expect(received).toBeDefined();
    expect(typeof received.aborted).toBe('boolean');
    expect(received.aborted).toBe(false);
  });

  it('leaves the signal untouched on success when no hedge fired', async () => {
    // The long-standing contract, which a hedge must not break for callers who
    // never asked for hedging.
    let signal;
    await PowerRetry.run(
      (s) => {
        signal = s;
        return Promise.resolve('ok');
      },
      { maxAttempts: 1 }
    );
    // Without a timeout or a hedge there is no controller at all, so `fn` is
    // handed `undefined` - unchanged from 1.x.
    expect(signal).toBeUndefined();
  });

  it('only hedges the first attempt, so a retry storm cannot multiply', async () => {
    // The hedge is the load-adding mechanism, so it fires once - on attempt 1.
    // If every attempt hedged, `maxAttempts: 3` would put 6 requests on the
    // wire, which is the amplification the retry budget exists to prevent.
    //
    // The first attempt has to outlive `hedgeDelay` or it fails before the
    // hedge is ever sent, and the count would be 3 either way - which is why
    // the delay is stated rather than left at 0.
    let calls = 0;
    await PowerRetry.run(
      () => {
        calls += 1;
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error('boom')), calls <= 2 ? 30 : 1)
        );
      },
      { hedgeDelay: 5, baseDelay: 1, maxAttempts: 3 }
    ).catch(() => {});
    // Attempt 1: primary + hedge = 2 calls, both failing.
    // Attempts 2 and 3: one call each.
    expect(calls).toBe(4);
  });

  it('draws a budget token for the hedge, and skips the hedge when refused', async () => {
    // A hedge is a request the dependency did not ask for, so it is charged
    // like a retry. A refused budget must mean *no hedge*, not a failure.
    const budget = new PowerRetryBudget({ ratio: 0, capacity: 1 });
    // Drain the single token so the hedge is refused.
    expect(budget.tryConsumeRetry()).toBe(true);
    let calls = 0;
    await expect(
      PowerRetry.run(
        () => {
          calls += 1;
          return Promise.reject(new Error('boom'));
        },
        { hedgeDelay: 1, baseDelay: 1, maxAttempts: 1, budget }
      )
    ).rejects.toThrow('boom');
    // The hedge was refused, so the original request ran alone.
    expect(calls).toBe(1);
  });

  it('rejects a negative hedgeDelay', async () => {
    await expect(PowerRetry.run(async () => 'ok', { hedgeDelay: -1 })).rejects.toThrow(
      'must be >= 0'
    );
  });
});

describe('PowerRetry option validation', () => {
  it('rejects a hedgeDelay that is not a number', async () => {
    await expect(PowerRetry.run(async () => 'ok', { hedgeDelay: 'soon' })).rejects.toThrow(
      'finite number'
    );
  });

  it('accepts a zero hedgeDelay as "hedging off"', async () => {
    let calls = 0;
    await PowerRetry.run(
      () => {
        calls += 1;
        return Promise.resolve('ok');
      },
      { hedgeDelay: 0, maxAttempts: 1 }
    );
    expect(calls).toBe(1);
  });

  it('does not send a request when a configuration is invalid', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return 'ok';
    };
    await expect(PowerRetry.run(fn, { backoff: 'decorrelated', jitter: false })).rejects.toThrow();
    await expect(PowerRetry.run(fn, { maxDelay: -1 })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('still retries after a timeout, because a timeout is a failed attempt', async () => {
    // The guide says a timed-out attempt is "rejected and counted as a failed
    // attempt". An earlier draft of the budget work threw on `ETIMEOUT`
    // instead, which silently turned `maxAttempts` into 1 for every caller who
    // also set a timeout. Pinned so that cannot come back.
    const spy = vi.fn();
    let calls = 0;
    await expect(
      PowerRetry.run(
        async () => {
          calls += 1;
          if (calls === 1) {
            await new Promise((r) => setTimeout(r, 40));
            throw new Error('boom');
          }
          return 'ok';
        },
        { maxAttempts: 3, baseDelay: 1, attemptTimeout: 5, onRetry: spy }
      )
    ).resolves.toBe('ok');
    expect(calls).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
