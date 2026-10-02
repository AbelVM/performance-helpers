import { describe, it, expect } from 'vitest';
import { PowerRetry } from '../src/index.js';

/**
 * RES-032 — `retryIf` is user code and was not guarded the way `onRetry` is.
 *
 * **The defect, probed on the real call path before the fix.** `retryIf` is
 * invoked from inside the retry loop's `catch` block. An unguarded throw from
 * there escapes the `catch` entirely and becomes the caller's rejection, so the
 * error the caller needs — the one their operation actually failed with — is
 * replaced by an error from a predicate that was only supposed to advise about
 * it. Before the fix, `PowerRetry.run` with a throwing `retryIf` rejected with
 * `"retryIf exploded"`; with `retryIf: () => false`, and with no `retryIf` at
 * all, both correctly rejected with the real error. `onRetry`, three lines below,
 * already had a `try`/`catch` and a comment saying why.
 *
 * **A throw is treated as declining, and that is a decision, not a shrug.**
 * `retryIf` answers "is it safe to run this again?". A predicate that cannot be
 * evaluated has not said yes, so the conservative reading is the one that does
 * not repeat a possibly non-idempotent operation. Every test here therefore
 * asserts the *identity* of the error the caller receives, not its message — a
 * test asserting a string would pass against an implementation that wrapped the
 * original error and lost the stack.
 *
 * These drive `PowerRetry.run` through the real retry loop rather than calling a
 * private, because the defect is specifically about *where* the throw lands —
 * inside the `catch` — and a private-level call cannot distinguish an error that
 * escaped the block from one that was re-thrown after it.
 */

/** An error the caller must still receive, identifiable by identity. */
function realFailure(message = 'the real failure') {
  return new Error(message);
}

/** Retry options with the delays collapsed, so a test is not waiting on backoff. */
const fast = { attempts: 3, baseDelay: 1, maxDelay: 1, jitter: false };

describe('RES-032: a throwing retryIf does not replace the error the caller needs', () => {
  it('rejects with the original error, not the predicate throw', async () => {
    const real = realFailure();
    await expect(
      PowerRetry.run(
        async () => {
          throw real;
        },
        {
          ...fast,
          retryIf: () => {
            throw new Error('retryIf exploded');
          },
        }
      )
    ).rejects.toBe(real);
  });

  it('is the same error object, so the stack and any attached fields survive', async () => {
    // **Identity, not equality of message.** The failure mode this guards is
    // *replacement*: a wrapper carrying the right text would satisfy a message
    // assertion while losing the stack, the `code`, and everything else the
    // caller attached to the error they were given.
    const real = realFailure();
    real.code = 'EORIGINAL';
    real.detail = { attempt: 1 };

    let caught;
    try {
      await PowerRetry.run(
        async () => {
          throw real;
        },
        {
          ...fast,
          retryIf: () => {
            throw new Error('predicate failure');
          },
        }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(real);
    expect(caught.code).toBe('EORIGINAL');
    expect(caught.detail).toEqual({ attempt: 1 });
  });

  it('stops retrying when the predicate throws, rather than repeating the operation', async () => {
    // **The "decline" half of the decision.** Three attempts are configured; a
    // throwing predicate on the first failure must end the run, because the
    // predicate has not answered the question it was asked. If a later change
    // treated a throw as permitting a retry, this fails — and the operation would
    // be running again on a caller that never said it was safe to.
    let calls = 0;
    await expect(
      PowerRetry.run(
        async () => {
          calls += 1;
          throw realFailure();
        },
        {
          ...fast,
          retryIf: () => {
            throw new Error('predicate failure');
          },
        }
      )
    ).rejects.toThrow();

    expect(calls, 'one attempt, because the predicate never said retry').toBe(1);
  });

  it('still retries normally when the predicate answers true', async () => {
    // The fix must not have turned `retryIf` into a permanent `false`. This is
    // the regression that a too-eager guard would introduce.
    let calls = 0;
    const result = await PowerRetry.run(
      async () => {
        calls += 1;
        if (calls < 3) throw realFailure(`attempt ${calls} failed`);
        return 'ok';
      },
      { ...fast, retryIf: () => true }
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('still stops normally when the predicate answers false', async () => {
    let calls = 0;
    await expect(
      PowerRetry.run(
        async () => {
          calls += 1;
          throw realFailure();
        },
        { ...fast, retryIf: () => false }
      )
    ).rejects.toThrow('the real failure');

    expect(calls).toBe(1);
  });

  it('leaves a non-function retryIf working as before', async () => {
    // `retryIf` accepts a boolean as well as a predicate. The guard wraps the
    // whole coercion, so the boolean path must be unchanged.
    await expect(
      PowerRetry.run(
        async () => {
          throw realFailure();
        },
        { ...fast, retryIf: false }
      )
    ).rejects.toThrow('the real failure');

    let calls = 0;
    await PowerRetry.run(
      async () => {
        calls += 1;
        if (calls < 2) throw realFailure(`attempt ${calls}`);
        return 'ok';
      },
      { ...fast, retryIf: true }
    );
    expect(calls, 'a boolean true still retries').toBe(2);
  });

  it('does not let a throwing retryIf mask a later onRetry either', async () => {
    // `onRetry` had its guard already; this pins that the two guards compose and
    // that adding the `retryIf` one did not reorder them. With `retryIf` throwing
    // the run ends before `onRetry` fires, so `onRetry` must not have been called
    // at all — if the guard were placed after the observer, this would be 1.
    let observed = 0;
    await expect(
      PowerRetry.run(
        async () => {
          throw realFailure();
        },
        {
          ...fast,
          retryIf: () => {
            throw new Error('predicate failure');
          },
          onRetry: () => {
            observed += 1;
          },
        }
      )
    ).rejects.toThrow('the real failure');

    expect(observed, 'a declined attempt is never announced as a retry').toBe(0);
  });
});

describe('RES-032: the PowerRetry constructor claims no metrics it does not have', () => {
  it('exposes no metrics surface, so the comment that described one is gone', async () => {
    // The second half of the row: the constructor ended with "FEAT-007: opt-in
    // metrics. Off by default, so the common case pays nothing and allocates no
    // closure" while calling nothing. It described a cost this class does not pay
    // and implied a `stats()` that does not exist — `_metrics` is on
    // `PowerRetryBudget` alone, because the budget is the state that decides
    // whether a call is refused.
    //
    // **A comment cannot be asserted directly**, so this pins the *consequence*
    // instead: if `PowerRetry` ever gains opt-in metrics, this fails and the
    // comment's removal is then a decision to revisit rather than an oversight.
    const retry = new PowerRetry({});
    expect(retry._metrics, 'PowerRetry has no metrics of its own').toBeUndefined();
    expect(retry.stats, 'and no stats() reporting any').toBeUndefined();
  });
});
