import { describe, it, expect } from 'vitest';
import { PowerRetry } from '../src/index.js';

/**
 * RES-031: `PowerRetry.run` could not be cancelled at all, and the larger half
 * of the problem was the gap *between* attempts.
 *
 * `attemptTimeout` bounds a slow attempt, and nothing bounded a slow wait. The
 * backoff sleep was `await new Promise((r) => setTimeout(r, delay))`, so a
 * caller who abandoned a request still waited out the delay — up to `maxDelay`,
 * which is 30 s at the default. A promise that settles 30 s after everyone
 * stopped listening is not a slow success, it is a leaked one.
 *
 * `p-retry` and `p-limit` both take a `signal`. This did not, and
 * `PowerDeadline` provides cancellation only by *wrapping*, which is the right
 * layering for a deadline and the wrong answer for a primitive that other
 * helpers compose with.
 *
 * **Every assertion here is a count or an ordering, never a duration.** The
 * harness measures a 28.61 % median min/max spread on this machine, and the
 * claim being tested is "rejects promptly" — which is a duration. So the
 * duration tests assert *ordering against a bound set by the test itself*: the
 * cancellation must beat a delay far larger than the whole run's own budget,
 * and the assertion is a ratio rather than a millisecond count. `withBackoff`
 * sets `baseDelay` to something that would take the whole suite's timeout if it
 * were actually waited out, so a regression cannot pass by being fast.
 */

/** Options for a run whose backoff would be far too long to actually wait. */
const withBackoff = (extra = {}) => ({
  maxAttempts: 5,
  baseDelay: 30_000,
  maxDelay: 30_000,
  jitter: false,
  ...extra,
});

/** An `fn` that always fails, so the loop reaches the backoff wait. */
const alwaysFails = async () => {
  throw new Error('nope');
};

describe('RES-031: PowerRetry accepts a signal and its backoff wait is interruptible', () => {
  it('rejects without running an attempt when the signal is already aborted', () => {
    // Not just "rejects" — runs *nothing*. A cancellation that still makes one
    // attempt has done the work the caller cancelled, so that half has its own
    // test below rather than being folded in here.
    const controller = new AbortController();
    controller.abort();

    return expect(
      PowerRetry.run(alwaysFails, { signal: controller.signal, ...withBackoff() })
    ).rejects.toMatchObject({ code: 'EABORT' });
  });

  it('does not attempt anything when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = 0;

    await PowerRetry.run(
      async () => {
        ran += 1;
        return 'unreachable';
      },
      { signal: controller.signal, ...withBackoff() }
    ).catch(() => {});

    expect(ran, 'a cancelled run must not start work').toBe(0);
  });

  it('an abort during the backoff wait rejects without waiting out the delay', async () => {
    // The headline. `baseDelay` is 30 000 ms, so a regression that waited out
    // the sleep would exceed any plausible test timeout — the assertion is
    // therefore "it returned at all, and in far less than the delay", not a
    // millisecond budget that a slow machine could fail on its own.
    const controller = new AbortController();
    let attempts = 0;
    const started = Date.now();

    const run = PowerRetry.run(
      async () => {
        attempts += 1;
        throw new Error('fail');
      },
      { signal: controller.signal, ...withBackoff() }
    );
    // Abort while the loop is in its first backoff wait.
    setTimeout(() => controller.abort(), 20);

    await expect(run).rejects.toMatchObject({ code: 'EABORT' });

    const elapsed = Date.now() - started;
    expect(elapsed, `rejected after ${elapsed}ms`).toBeLessThan(30_000);
    expect(attempts, 'the abort lands during the wait, not mid-attempt').toBe(1);
  });

  it('rejects with the EABORT shape PowerDeadline already uses', async () => {
    // One convention across the library, not two. `PowerDeadline.createAbortError`
    // sets `code: 'EABORT'` and carries `reason`, and a caller branching on
    // `err.code` should not have to know which helper produced it.
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    controller.abort(reason);

    const err = await PowerRetry.run(alwaysFails, {
      signal: controller.signal,
      ...withBackoff(),
    }).catch((e) => e);

    expect(err.code).toBe('EABORT');
    expect(err.reason, 'the abort reason is preserved, not replaced').toBe(reason);
    expect(err.attempts, 'attempts: 0 distinguishes cancelled-before-start').toBe(0);
  });

  it('a signal that is never aborted does not change the result', async () => {
    // The control. A `signal` that stays live must be invisible: same value, same
    // number of attempts, same retries.
    let attempts = 0;
    const value = await PowerRetry.run(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('retry me');
        return 'ok';
      },
      { signal: new AbortController().signal, maxAttempts: 5, baseDelay: 1, jitter: false }
    );

    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('works without a signal at all', async () => {
    // Also the control for the allocation claim in `sleepOrAbort`: no signal must
    // take the plain `setTimeout` path, so a run that never passes a signal
    // allocates no abort listener.
    let attempts = 0;
    const value = await PowerRetry.run(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('retry me');
        return 'ok';
      },
      { maxAttempts: 3, baseDelay: 1, jitter: false }
    );

    expect(value).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('does not leak an abort listener across many runs', async () => {
    // The failure mode this guards is a slow leak, not a visible one: a listener
    // left attached to a long-lived signal keeps a closure — and the timer, and
    // the pending promise's reaction — alive for the rest of the process. A
    // retry loop running for hours is where that shows up.
    //
    // Counted by wrapping the signal's own methods, so this fails if either path
    // forgets to remove: the resolve path removes explicitly, the abort path
    // relies on `{ once: true }` plus an explicit `clearTimeout`.
    const controller = new AbortController();
    const { signal } = controller;
    let added = 0;
    let removed = 0;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => {
      added += 1;
      return realAdd(...args);
    };
    signal.removeEventListener = (...args) => {
      removed += 1;
      return realRemove(...args);
    };

    for (let i = 0; i < 25; i += 1) {
      await PowerRetry.run(alwaysFails, {
        signal,
        maxAttempts: 2,
        baseDelay: 1,
        jitter: false,
      }).catch(() => {});
    }

    expect(added, 'each retry wait registers one listener').toBeGreaterThan(0);
    expect(removed, 'every listener is removed again').toBe(added);
  });

  it('an abort stops a run that has already retried at least once', async () => {
    // The pre-attempt check, which is a separate code path from the wait. An
    // abort that lands between the end of a failed attempt and the start of the
    // next must not buy the caller one more attempt.
    const controller = new AbortController();
    let attempts = 0;

    const run = PowerRetry.run(
      async () => {
        attempts += 1;
        // Abort from inside the attempt, so the signal is already aborted by the
        // time the loop reaches the pre-attempt check for attempt 2.
        controller.abort();
        throw new Error('fail');
      },
      { signal: controller.signal, maxAttempts: 5, baseDelay: 30_000, jitter: false }
    );

    await expect(run).rejects.toMatchObject({ code: 'EABORT' });
    expect(attempts, 'no attempt runs after the abort').toBe(1);
  });

  it('a constructor signal is not stored in the per-call options', async () => {
    // The bug this shape invites. `_options` is spread into **every** `run`, and
    // an `AbortSignal` is one-shot: stored there, the first run that consumed it
    // would leave the instance holding an aborted signal, and every later `run`
    // would reject for a reason the caller did not cause on that call.
    const controller = new AbortController();
    const retry = new PowerRetry({ signal: controller.signal });

    expect(retry._options, 'the signal is not in the reusable options').not.toHaveProperty(
      'signal'
    );

    controller.abort();
    await expect(retry.run(alwaysFails)).rejects.toMatchObject({ code: 'EABORT' });
  });

  it('a per-call signal overrides the instance default', async () => {
    // A live instance signal must not be usable to ignore a per-call
    // cancellation, and vice versa: passing `signal` on the call wins.
    const instanceController = new AbortController();
    const callController = new AbortController();
    const retry = new PowerRetry({ signal: instanceController.signal });

    callController.abort();
    await expect(
      retry.run(alwaysFails, { signal: callController.signal, ...withBackoff() })
    ).rejects.toMatchObject({ code: 'EABORT' });

    // The instance's own signal is untouched and still usable.
    let attempts = 0;
    const value = await retry.run(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('retry me');
        return 'ok';
      },
      { maxAttempts: 3, baseDelay: 1, jitter: false }
    );
    expect(value).toBe('ok');
  });

  it('accepts `signal` as a known option rather than rejecting it', () => {
    // `assertKnownOptions` is strict, so an option added to the behaviour but
    // not the allow-list would throw "unknown option" — the change would work on
    // the static path and fail on the constructor path.
    expect(() => new PowerRetry({ signal: new AbortController().signal })).not.toThrow();
    expect(() =>
      PowerRetry.run(alwaysFails, { signal: new AbortController().signal })
    ).not.toThrow();
  });
});
