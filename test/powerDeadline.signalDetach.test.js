import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { PowerDeadline } from '../src/index.js';

/**
 * RES-013 — `combineSignals` retained an abort listener per attempt and there was
 * no way to remove one, plus an already-aborted signal still started the work.
 *
 * **The leak, measured before the fix:** 20 runs × 4 attempts against one shared
 * external signal left **80 `abort` listeners** on it — one per attempt, each
 * holding `onAbort` → the internal `AbortController` → the combined signal and
 * everything the caller had attached. `{ once: true }` was doing no work here: it
 * only avoids a second invocation *after* the event fires, and in the common case
 * it never fires, because the run succeeds and the process moves on. Nothing
 * warned, because nothing could — `AbortSignal` is an `EventTarget`, not an
 * `EventEmitter`, so there is no listener count to observe and no `off()`.
 *
 * These are counted with `getEventListeners` from `node:events`, which reads a
 * real `EventTarget` rather than counting calls to a fake one. That matters: a
 * stub that recorded `addEventListener` would have passed against a
 * `removeEventListener` that removed the wrong function.
 */

/** Count the abort listeners currently attached to a signal. */
const listenerCount = (signal) => getEventListeners(signal, 'abort').length;

/**
 * Drive `count` failing attempts through one shared external signal.
 * @returns {Promise<{signal: AbortSignal, attempts: number}>}
 */
async function runFailingAttempts(count, signal) {
  let attempts = 0;
  const deadline = new PowerDeadline({ maxAttempts: 4, totalTimeout: 5_000, retryDelay: 1 });
  for (let run = 0; run < count; run += 1) {
    await deadline
      .run(
        async () => {
          attempts += 1;
          throw new Error('fail');
        },
        { signal }
      )
      .catch(() => {});
  }
  return { attempts, deadline };
}

describe('RES-013: abort listeners are detached when an attempt ends', () => {
  it('leaves nothing on a shared external signal after many failing attempts', async () => {
    // **The row's exact figure, reproduced then fixed.** Before the fix this read
    // 80. One shared signal is the realistic shape — a request-scoped signal
    // handed to every operation in a request is the common case, and it is the
    // one that outlives them.
    const shared = new AbortController().signal;
    const { attempts } = await runFailingAttempts(20, shared);

    expect(attempts).toBe(80);
    expect(listenerCount(shared), 'one retained listener per attempt is the whole defect').toBe(0);
  });

  it('does not accumulate across repeated runs on one signal', async () => {
    // A leak that a single run cannot show. Asserting a total of 0 after 20 runs
    // would also pass if the count went 20 → 0 → 40; the intermediate readings are
    // what make it a per-run claim rather than an endpoint one.
    const shared = new AbortController().signal;
    const before = listenerCount(shared);

    await runFailingAttempts(5, shared);
    const afterFive = listenerCount(shared);
    await runFailingAttempts(5, shared);
    const afterTen = listenerCount(shared);

    expect(afterFive).toBe(before);
    expect(afterTen).toBe(before);
  });

  it('detaches on the success path, not only when the operation fails', async () => {
    // The failing-op path is where a `finally` looks obviously necessary. The
    // success path is the common one and the one a regression would reach first,
    // because nothing looks wrong when it is wrong.
    const shared = new AbortController().signal;
    for (let i = 0; i < 10; i += 1) {
      await new PowerDeadline({ maxAttempts: 1, totalTimeout: 1_000 }).run(async () => 'ok', {
        signal: shared,
      });
    }

    expect(listenerCount(shared)).toBe(0);
  });

  it('attaches for the duration of an attempt and releases it after, every time', async () => {
    // **Replaces an earlier draft of this file that asserted the opposite, and
    // the reason it was wrong is the whole point of the row.** That draft claimed
    // a signal handed to `fn` "must still observe a later abort" after the attempt
    // settled. It does not, deliberately — that is what detaching *means*. A
    // combined signal exists only to serve one attempt; keeping it wired to the
    // caller afterwards is precisely the retention being fixed, and nobody is
    // listening to it.
    //
    // What actually matters is the opposite property, and it is the one that
    // fails if someone "fixes" the leak by never attaching: the listener is
    // **live during** the attempt and **gone after** it, on every attempt.
    const external = new AbortController();
    const during = [];

    await new PowerDeadline({ maxAttempts: 2, totalTimeout: 500, retryDelay: 1 })
      .run(
        async () => {
          during.push(listenerCount(external.signal));
          throw new Error('fail');
        },
        { signal: external.signal }
      )
      .catch(() => {});

    expect(during, 'a listener is attached while the attempt runs').toHaveLength(2);
    expect(
      during.every((n) => n > 0),
      'both attempts saw a live listener'
    ).toBe(true);
    expect(listenerCount(external.signal), 'and none survive either attempt').toBe(0);
  });

  it('still propagates a mid-flight abort with its reason', async () => {
    // The regression guard for the combining path itself: the reason is what tells
    // a caller *which* limit fired, and forwarding it is why `onAbort` reads
    // `e.target.reason` rather than calling `controller.abort()` bare.
    const external = new AbortController();
    const reason = new Error('caller cancelled');
    setTimeout(() => external.abort(reason), 5);

    let caught;
    try {
      await new PowerDeadline({ maxAttempts: 1, totalTimeout: 500 }).run(
        async (signal) =>
          new Promise((_, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        { signal: external.signal }
      );
    } catch (e) {
      caught = e;
    }

    expect(caught?.code).toBe('EABORT');
    expect(caught?.reason, 'the originating reason is forwarded').toBe(reason);
  });

  it('calls fn with no signal when there is genuinely nothing to combine', async () => {
    // `combineSignals` documents that `signal` is `undefined` when there is
    // nothing to combine, so `fn` is called without one. **No `totalTimeout`
    // here**, and that qualifier is the point: an earlier draft set one and
    // asserted `undefined`, which failed — correctly — because a deadline creates
    // its own controller and `fn` *should* receive that signal.
    let seen = 'unset';
    const out = await new PowerDeadline({ maxAttempts: 1 }).run(async (signal) => {
      seen = signal;
      return 'ok';
    });

    expect(out).toBe('ok');
    expect(seen, 'fn is called with no signal when none was supplied').toBeUndefined();
  });

  it('hands fn the deadline signal when there is no external one', async () => {
    // The other side of the same branch, and the one worth pinning: a deadline
    // needs `fn` to be cancellable, so the internally-created controller's signal
    // is what reaches the operation. Without this, a `totalTimeout` would reject
    // the promise while leaving in-flight work running — which is the exact leak
    // `deadlineController` was introduced to stop.
    let seen = 'unset';
    await new PowerDeadline({ maxAttempts: 1, totalTimeout: 200 }).run(async (signal) => {
      seen = signal;
      return 'ok';
    });

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen.aborted, 'and the operation completed, so it is not yet aborted').toBe(false);
  });
});

describe('RES-013: an already-aborted signal does not start the work', () => {
  it('never invokes fn when the external signal is already aborted', async () => {
    // **The row's second defect.** `createAbortPromise` returned a rejected
    // promise, so the run *did* reject with `EABORT` — but `candidates[0]` had
    // already been constructed by then, so `fn` ran, its side effects happened,
    // and its result was discarded. Measured before the fix: **1 invocation**.
    // Starting work you are about to abandon is the failure; the rejection was
    // never the problem.
    const external = new AbortController();
    external.abort();
    let calls = 0;

    await expect(
      new PowerDeadline({ maxAttempts: 4, totalTimeout: 500 }).run(
        async () => {
          calls += 1;
          return 'ran anyway';
        },
        { signal: external.signal }
      )
    ).rejects.toThrow();

    expect(calls, 'fn must not be called against a cancelled signal').toBe(0);
  });

  it('rejects with EABORT, not a generic error', async () => {
    // A caller branches on this code to distinguish "you cancelled me" from "the
    // operation failed", so collapsing the two would be a second regression.
    const external = new AbortController();
    external.abort();

    let caught;
    try {
      await new PowerDeadline({ maxAttempts: 4, totalTimeout: 500 }).run(async () => 'x', {
        signal: external.signal,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught?.code).toBe('EABORT');
    expect(caught?.attempts).toBe(1);
  });

  it('does not retry an already-aborted run', async () => {
    // `maxAttempts: 4` is set deliberately. Retrying an operation the caller
    // cancelled would repeat the side effect four times, which is worse than the
    // original bug rather than equal to it.
    const external = new AbortController();
    external.abort();
    let calls = 0;

    await expect(
      new PowerDeadline({ maxAttempts: 4, totalTimeout: 500 }).run(
        async () => {
          calls += 1;
          return 'x';
        },
        { signal: external.signal }
      )
    ).rejects.toThrow();

    expect(calls, 'no attempt was made, so there is nothing to retry').toBe(0);
  });

  it('carries the caller reason through, so the cancellation is attributable', async () => {
    const reason = new Error('user navigated away');
    const external = new AbortController();
    external.abort(reason);

    let caught;
    try {
      await new PowerDeadline({ maxAttempts: 4, totalTimeout: 500 }).run(async () => 'x', {
        signal: external.signal,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught?.reason).toBe(reason);
  });
});
