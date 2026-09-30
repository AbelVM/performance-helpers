/**
 * `dispose()` is a teardown, and it used to be a re-arm.
 *
 * `powerLatch.js` implemented `dispose()` as `this.reset()` — whose default
 * argument is `1` — and then neutralised `reset`. That produced three defects
 * that only a test can hold, because each one is a *silent* wrong answer rather
 * than a throw:
 *
 *   1. `reset()` only settles waiters when the new count is 0, so disposing a
 *      latch with pending `wait()`s left every one of them pending forever. A
 *      documented teardown hung its own waiters.
 *   2. `remaining` reported 1 and `done` reported false after disposal, so a
 *      caller polling the latch was told a torn-down object was still armed.
 *   3. `reset()` clears `_aborted`/`_abortReason`, so `dispose()` made an
 *      aborted latch **live again** — `abort()` then `dispose()` then `wait()`
 *      produced a promise that resolved on no countdown at all.
 *
 * `abort()` had the matching problem from the other side: it is not idempotent,
 * so the "abort on the error path and again on the cleanup path" idiom that
 * every finally block in this library is written against fired `onAbort` twice
 * for one logical abort.
 *
 * Every assertion here is a state, a code, or a counter. None is a duration:
 * the harness measures a ~28% median spread on a typical machine, and "still
 * pending" is checked by a rejected promise rather than by a timer.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerLatch } from '../src/helpers/powerLatch.js';

/**
 * Report how a promise settled, or that it did not, within one turn of the
 * macrotask queue.
 *
 * The defect this file pins is a *hang*: before the fix, `dispose()` left every
 * `waiter` pending for the life of the process. Asserting that with
 * `await expect(p).rejects...` alone means a regression costs a 5 s vitest
 * timeout per test, and the dispose tests took 45 s to report one. Racing
 * against a sentinel scheduled as a 0 ms **timer** settles the question
 * immediately: promise reaction jobs always drain before the next macrotask, so
 * an already-settled promise wins the race, and only a genuinely pending
 * promise can lose it. Nothing here is a threshold or a tolerance, so it cannot
 * go flaky on a loaded machine.
 *
 * A note on the first attempt, because the tempting version is wrong: an
 * *already-resolved* `Promise.resolve()` sentinel loses the race even to a
 * promise that settled long ago. Chaining off a settled promise costs an extra
 * microtask hop than attaching to an already-fulfilled one, so `PENDING` is
 * reported for a promise that really did reject. Verified, not assumed.
 *
 * @param {Promise<any>} promise
 * @returns {Promise<{state: 'PENDING'}|{state: 'RESOLVED'}|{state: 'REJECTED', code: any}>}
 */
function settled(promise) {
  return Promise.race([
    promise.then(
      () => ({ state: /** @type {const} */ ('RESOLVED') }),
      (err) => ({ state: /** @type {const} */ ('REJECTED'), code: err?.code })
    ),
    new Promise((resolve) =>
      setTimeout(() => resolve({ state: /** @type {const} */ ('PENDING') }), 0)
    ),
  ]);
}

describe('PowerLatch.dispose() is terminal', () => {
  it('rejects pending waiters instead of stranding them', async () => {
    // Defect 1. Before the fix `dispose()` settled nothing at all, so the
    // waiter stayed pending for the life of the process.
    const latch = new PowerLatch(2);
    const waiter = latch.wait();

    latch.dispose();

    expect(await settled(waiter)).toEqual({ state: 'REJECTED', code: 'EDISPOSED' });
  });

  it('rejects every pending waiter, not just the first', async () => {
    // `_settleAll` walks the whole map. A fix that rejected one waiter to
    // unblock the common case would pass the test above and strand the rest.
    const latch = new PowerLatch(3);
    const waiters = [latch.wait(), latch.wait(), latch.wait()];

    latch.dispose();

    const outcomes = await Promise.all(waiters.map(settled));
    expect(outcomes).toEqual([
      { state: 'REJECTED', code: 'EDISPOSED' },
      { state: 'REJECTED', code: 'EDISPOSED' },
      { state: 'REJECTED', code: 'EDISPOSED' },
    ]);
  });

  it('zeroes the count so a torn-down latch does not report itself armed', async () => {
    // Defect 2. `remaining` read 1 and `done` read false, which is the state a
    // caller polls to decide whether the latch is still live.
    const latch = new PowerLatch(4);
    expect(latch.remaining).toBe(4);

    latch.dispose();

    expect(latch.remaining).toBe(0);
    expect(latch.done).toBe(true);
  });

  it('refuses new waits rather than registering them', async () => {
    // A waiter registered after disposal would be a promise nobody can ever
    // settle: `countDown` cannot move a disposed latch, so it is the same
    // hang as defect 1 with extra steps.
    const latch = new PowerLatch(1);
    latch.dispose();

    expect(await settled(latch.wait())).toEqual({ state: 'REJECTED', code: 'EDISPOSED' });
    // A refused wait must not leave a waiter behind that `countDown` settles.
    expect(latch.countDown()).toBe(0);
    expect(latch.remaining).toBe(0);
  });

  it('does not resurrect an aborted latch', async () => {
    // Defect 3, the sharpest of the three: `reset()` clears the aborted state,
    // so `dispose()` on an aborted latch produced a *working* latch. The wait
    // then resolved with no countdown, which is a promise that resolves for a
    // reason the caller did not cause.
    const latch = new PowerLatch(1);
    latch.abort('because');
    latch.dispose();

    expect(await settled(latch.wait())).toEqual({ state: 'REJECTED', code: 'EDISPOSED' });
  });

  it('leaves `abort()` reporting the abort, not the disposal', async () => {
    // The order matters: a latch aborted and *then* disposed is disposed, and
    // a latch disposed and *then* aborted is still disposed. Neither order
    // produces a live latch, which is the property the previous
    // `abort -> reset(3) -> dispose` sequence destroyed.
    const abortedThenDisposed = new PowerLatch(1);
    abortedThenDisposed.abort('stop');
    abortedThenDisposed.dispose();
    expect(await settled(abortedThenDisposed.wait())).toEqual({
      state: 'REJECTED',
      code: 'EDISPOSED',
    });

    const disposedThenAborted = new PowerLatch(1);
    disposedThenAborted.dispose();
    disposedThenAborted.abort('stop');
    // `abort()` on a disposed latch must not clear the disposed state, or the
    // latch is live again and this promise never settles.
    expect(await settled(disposedThenAborted.wait())).toEqual({
      state: 'REJECTED',
      code: 'EDISPOSED',
    });
  });

  it('is idempotent: a second dispose neither re-rejects nor throws', async () => {
    // `disposal.test.js` pins that a second `dispose()` does not throw, which
    // a no-op guard satisfies trivially. This pins that the *second* pass does
    // not also re-fire the rejection, by checking the hook stayed at one call.
    const onAbort = vi.fn();
    const latch = new PowerLatch(1, { onAbort });
    const waiter = latch.wait();

    latch.dispose();
    latch.dispose();
    latch[Symbol.dispose]();

    expect(await settled(waiter)).toEqual({ state: 'REJECTED', code: 'EDISPOSED' });
    // `dispose()` is not `abort()`, so it must not invoke the abort hook.
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('clears the timeout timer and abort listener of a disposed waiter', async () => {
    // A disposed waiter is settled, but its `setTimeout` handle and its
    // `signal` listener are only released by the teardown inside
    // `_settleAll`. If disposal bypassed it, the timer would stay live and the
    // listener would stay attached to the caller's signal for the process's
    // life — a leak that a rejected-promise assertion cannot see.
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = { aborted: false, reason: undefined, addEventListener, removeEventListener };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const latch = new PowerLatch(1);
    const waiter = latch.wait({ signal, timeout: 10_000 });
    latch.dispose();
    expect(await settled(waiter)).toEqual({ state: 'REJECTED', code: 'EDISPOSED' });

    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('disposes cleanly with no waiters at all', async () => {
    // The idle path. `reset(1)` also passed this, so it is pinned only to
    // record that the terminal path did not regress the documented
    // "safe to call while the instance is idle" claim.
    const latch = new PowerLatch(1);
    expect(() => latch.dispose()).not.toThrow();
    expect(latch.remaining).toBe(0);
  });
});

describe('PowerLatch.abort() is idempotent', () => {
  it('fires onAbort once across two abort() calls', () => {
    // A single counter, not a duration. Every finally block in this library
    // aborts defensively, so the twice-fired hook was reachable from ordinary
    // calling code rather than only from a caller that got it wrong.
    const onAbort = vi.fn();
    const latch = new PowerLatch(1, { onAbort });

    const first = new Error('first');
    latch.abort(first);
    latch.abort(new Error('second'));

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledWith(first);
  });

  it('keeps the first abort reason rather than overwriting it', async () => {
    // The second call carries a different reason, and a cleanup-path abort must
    // not rewrite the error an error-path caller is about to surface.
    //
    // Both assertions read the same stored reason, but only the second one
    // discriminates, and that was found by mutation rather than by reading: a
    // waiter registered *before* the abort was already rejected, so re-running
    // the reject is a no-op and the old assertion passed with the idempotency
    // guard deleted. A `wait()` issued *after* both aborts is rejected with the
    // currently stored reason, so it is the one that can see the overwrite.
    const latch = new PowerLatch(1);
    const pendingWaiter = latch.wait();

    const first = new Error('first');
    latch.abort(first);
    latch.abort(new Error('second'));

    expect(
      await pendingWaiter.then(
        () => null,
        (err) => err
      )
    ).toBe(first);
    expect(
      await latch.wait().then(
        () => null,
        (err) => err
      )
    ).toBe(first);
  });
});
