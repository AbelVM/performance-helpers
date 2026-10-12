import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * PISC-003: a per-task `AbortSignal` on `postMessage`.
 *
 * `AbortSignal` is a web standard, so this transfers cleanly across realms — which
 * is the whole reason it is the right mechanism here rather than a pool-specific
 * cancellation token.
 *
 * **The in-flight policy is the decision worth reading.** Piscina terminates the
 * worker. That is the wrong trade for this pool: under `maxTasksPerWorker > 1` a
 * worker carries several in-flight tasks, so terminating it to abandon one kills
 * every other task on that worker — a blast radius far larger than the task being
 * aborted, and one the callers of those other tasks did nothing to earn. It also
 * discards a warm worker and its negotiated protocol state.
 *
 * So the *work* runs to completion and the *waiter* is released now. The response is
 * discarded when it arrives, because the pending entry is already gone. That is the
 * honest reading of what an abort usually means — "stop waiting for this" — and a
 * caller who genuinely needs the work undone has to arrange that in the worker,
 * because no pool can undo a side effect.
 *
 * **`skipQueue` is rejected as part of this row** (the F-2 design question it names).
 * The pool already dispatches immediately when a worker is free; the queue is only
 * used under saturation; and a `skipQueue` that jumped ahead of queued work would be
 * a priority mechanism by another name when `priority` already exists.
 */

/** A worker that never answers, so tasks stay queued or in flight. */
function Busy() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/** A saturated single-worker pool, so a second post is guaranteed to queue. */
function saturated(options = {}) {
  const pool = new PowerPool(Busy, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    maxTasksPerWorker: 1,
    lazy: false,
    idleTimeout: 0,
    ...options,
  });
  // Occupy the single in-flight slot.
  pool.postMessage({ n: 'occupying' });
  return pool;
}

describe('PISC-003 per-task AbortSignal', () => {
  it('rejects immediately when the signal is already aborted at post time', async () => {
    // A caller holding an aborted signal has already changed their mind, so queuing
    // the task would be work done on their behalf after they cancelled it.
    const pool = saturated();
    const ac = new AbortController();
    ac.abort();
    await expect(
      pool.postMessage({ n: 1 }, undefined, { awaitResponse: true, signal: ac.signal })
    ).rejects.toThrow();
    expect(pool.queue.length, 'and nothing was queued').toBe(0);
  });

  it('returns false for a fire-and-forget post with an already-aborted signal', () => {
    // `false` rather than a throw, matching every other refusal on this path.
    const pool = saturated();
    const ac = new AbortController();
    ac.abort();
    expect(pool.postMessage({ n: 1 }, undefined, { signal: ac.signal })).toBe(false);
    expect(pool.queue.length).toBe(0);
  });

  it('rejects a queued task at abort time, not at dispatch time', async () => {
    // The caller stopped waiting *now*. The dispatch loop would also reject it, but
    // only when a worker frees up — which under saturation may be a long wait.
    const pool = saturated();
    const ac = new AbortController();
    const pending = pool.postMessage({ n: 2 }, undefined, {
      awaitResponse: true,
      signal: ac.signal,
    });
    expect(pool.queue.length, 'the task is queued').toBe(1);

    let settled = null;
    let at = 0;
    pending.then(
      () => (settled = 'resolved'),
      () => {
        settled = 'rejected';
        at = Date.now();
      }
    );
    const started = Date.now();
    ac.abort();

    await vi.waitFor(() => expect(settled).not.toBeNull());
    expect(settled).toBe('rejected');
    // Asserted on latency, because "eventually rejected" is what the dispatch loop
    // already does and is not what this listener adds.
    expect(at - started, 'settled at abort time, not at dispatch time').toBeLessThan(50);
  });

  it('releases the waiter for an in-flight task but lets the work finish', async () => {
    // The policy decision, asserted on both halves: the caller is released, and the
    // task is still counted as running. A test that asserted only the first half
    // would pass against a policy that terminated the worker.
    const pool = new PowerPool(Busy, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      lazy: false,
      idleTimeout: 0,
    });
    const ac = new AbortController();
    const pending = pool.postMessage({ n: 3 }, undefined, {
      awaitResponse: true,
      signal: ac.signal,
    });
    expect(pool.getStats().activeTasks, 'the task is in flight').toBe(1);

    let settled = null;
    pending.then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected')
    );
    ac.abort();

    await vi.waitFor(() => expect(settled).not.toBeNull());
    expect(settled).toBe('rejected');
    expect(pool.getStats().activeTasks, 'and the work is still running').toBe(1);
  });

  it('discards the late response rather than resolving a settled promise', async () => {
    // The consequence of the in-flight policy: the worker finishes and posts back,
    // but the pending entry is already gone. A pool that kept it would resolve a
    // promise the caller had already abandoned — or worse, a *different* caller's.
    const pool = new PowerPool(Busy, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      lazy: false,
      idleTimeout: 0,
    });
    const ac = new AbortController();
    const pending = pool.postMessage({ n: 4 }, undefined, {
      awaitResponse: true,
      signal: ac.signal,
    });
    let settled = null;
    pending.then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected')
    );
    ac.abort();
    await vi.waitFor(() => expect(settled).toBe('rejected'));

    // The worker answers late, after the abort.
    pool.workers[0].worker.onmessage({ data: { ok: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled, 'still rejected, not resurrected').toBe('rejected');
  });

  it('leaves a post with no signal completely unchanged', () => {
    // The default path must not pay for the feature. Asserted on the queue and the
    // active count, which is what a stray listener or a missed branch would move.
    const pool = saturated();
    pool.postMessage({ n: 5 });
    expect(pool.queue.length).toBe(1);
    expect(pool.getStats().activeTasks).toBe(1);
  });

  it('does not dispatch a fire-and-forget task that was aborted while queued', () => {
    // The case the queued listener does **not** cover. The listener is attached only
    // when `wantResponse && correlationKey`, because there is no promise to settle
    // otherwise — so for a fire-and-forget post the dispatch loop's own check is the
    // only thing standing between an aborted task and a worker.
    //
    // Reverting that check passes every other test in this file, which is how the
    // first draft of the mutation run read 4/6 and looked fine.
    //
    // **Asserted on what the worker was posted, not on a counter.** The first draft
    // asserted `activeTasks === 1` after freeing the worker, and got 0 — because
    // completing the occupying task decrements the counter for a reason that has
    // nothing to do with the aborted item. A recording fake makes the assertion
    // direct: either the aborted payload reached the worker or it did not.
    const posted = [];
    function Recording() {
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.postMessage = (msg) => posted.push(msg);
      this.terminate = () => {};
    }
    const pool = new PowerPool(Recording, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      lazy: false,
      idleTimeout: 0,
    });
    pool.postMessage({ n: 'occupying' });
    expect(posted).toHaveLength(1);

    const ac = new AbortController();
    pool.postMessage({ n: 'do-not-send' }, undefined, { signal: ac.signal });
    expect(pool.queue.length, 'queued').toBe(1);
    ac.abort();

    // Free the worker so the dispatch loop runs.
    pool.workers[0].worker.onmessage({ data: { ok: true } });
    expect(pool.queue.length, 'the aborted item was skipped, not dispatched').toBe(0);
    // The count, not the payload: the pool frames messages before posting, so what
    // the fake receives is a `Uint8Array` and asserting on its shape would pin the
    // codec rather than the behaviour under test.
    expect(posted, 'and the worker never received a second post').toHaveLength(1);
  });

  it('attaches with { once: true } on both paths, so a long-lived signal does not accumulate', () => {
    // A pool that attached without `once` would retain one listener per aborted task
    // for the lifetime of the signal — and a long-lived signal (a server-lifetime
    // `AbortSignal`, or a framework's request scope) is the normal case, so this is a
    // slow leak rather than a theoretical one.
    //
    // Asserted on the *options* passed to `addEventListener` rather than on a
    // listener count, because `AbortSignal` does not expose `listenerCount` in this
    // runtime — the first draft of this test asserted on it and measured `undefined`.
    //
    // **Both paths are exercised.** There are two attachment sites — the queued
    // listener and the in-flight one — and a saturated pool only reaches the first.
    // Asserting on one of them lets the other be mutated freely, which is how the
    // first draft of this test passed against a revert of the in-flight options.
    const calls = [];
    // `AbortSignal.prototype`, not `AbortController.prototype` — the controller has
    // no `addEventListener` of its own, and spying on the wrong one throws rather
    // than failing an assertion, which is how the first draft of this test errored.
    const real = AbortSignal.prototype.addEventListener;
    vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(
      function (type, handler, opts) {
        calls.push({ type, opts });
        return real.call(this, type, handler, opts);
      }
    );

    // Queued path: saturate, then post.
    const queued = saturated();
    const acQueued = new AbortController();
    queued.postMessage({ n: 1 }, undefined, { awaitResponse: true, signal: acQueued.signal });

    // In-flight path: a free worker, so the task dispatches immediately.
    const free = new PowerPool(Busy, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      lazy: false,
      idleTimeout: 0,
    });
    const acFree = new AbortController();
    free.postMessage({ n: 2 }, undefined, { awaitResponse: true, signal: acFree.signal });

    // **Filtered to `abort`, and counted as "at least two" rather than exactly two.**
    // Spying on the prototype catches every attachment in the process, including any
    // the pool or the runtime makes elsewhere — the first draft asserted an exact
    // count of 2 and failed on calls it did not mean to count. What matters is that
    // *every* abort attachment the pool made carries `{ once: true }`, on both paths.
    const abortCalls = calls.filter((c) => c.type === 'abort');
    expect(abortCalls.length, 'one per aborted-capable post, on both paths').toBeGreaterThanOrEqual(
      2
    );
    for (const c of abortCalls) {
      expect(c.opts).toEqual({ once: true });
    }
    vi.restoreAllMocks();
  });
});
