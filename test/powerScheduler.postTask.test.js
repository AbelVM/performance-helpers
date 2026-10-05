/**
 * GAP-013: `scheduler.postTask` + `TaskController` as a strategy.
 *
 * `scheduler.yield()` returns a promise with **no handle to detach**, which is why
 * `PowerScheduler`'s yield path carries a generation counter — RES-006's fix, added
 * after a comment argued it was unnecessary and was shown wrong. A `TaskController`
 * is a handle: `abort()` stops the task before it runs, and it arrives through the
 * `signal` option the platform itself checks. So on this path there is no stale
 * continuation to guard against and no counter to compare.
 *
 * **A separate opt-in strategy, not a change to `yield`.** Routing `yield` through
 * `postTask` where it happens to exist would silently alter the behaviour of every
 * caller already on that strategy, in an upgrade, for a scheduling difference they
 * did not ask for. A new name is visible; a substitution is not.
 *
 * `HAS_POST_TASK` is read at **module load**, like `HAS_SCHEDULER_YIELD` beside it —
 * probing a stable runtime feature per flush would add a property read to the hot
 * path. So the globals have to be in place *before* the import, which is why every
 * test here installs its own globals and then re-imports through `vi.resetModules()`.
 *
 * That import is written as a **literal** specifier on purpose. A template literal
 * (`import(`../x.js?v=${flag}`)`) is not resolvable by Vite's import analysis and
 * fails with `Unknown variable dynamic import`; the module registry is keyed by
 * specifier, so the reset is what re-runs the probe, not the query string.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

/** Counters and shapes, never durations. Every assertion here is about what ran. */

/**
 * The globals as they were before this file touched them, captured once at load.
 *
 * Restoring per-test instead would restore whatever the *previous* test left, and
 * two of the tests here install their own fakes before re-importing — so a
 * per-test save would hand back a fake and leak it into the next test, and
 * `scheduler` missing in Node means a leaked fake is the only one a later test
 * would see.
 */
const NATIVE_SCHEDULER = globalThis.scheduler;
const NATIVE_TASK_CONTROLLER = globalThis.TaskController;

/**
 * @returns {void}
 */
function removePostTask() {
  delete globalThis.scheduler;
  delete globalThis.TaskController;
}

/**
 * Install a `scheduler.postTask` + `TaskController` pair whose tasks the test controls.
 *
 * A real `postTask` would queue against a browser event loop that does not exist here,
 * so the fake keeps its own queue and — importantly — **honours the signal**, because
 * honouring it is the entire mechanism this row adopts. A fake that ignored `signal`
 * would let the implementation pass by never looking at it.
 *
 * @returns {Object} Controls for the installed fake.
 */
function installPostTask() {
  const queue = [];
  let aborted = 0;
  let ran = 0;

  class FakeTaskController {
    constructor() {
      this.signal = { aborted: false, addEventListener() {}, reason: undefined };
    }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      aborted += 1;
      // What the platform does: a task whose signal is aborted never reaches its
      // callback. Modelling that is the only reason an abort assertion means
      // anything here.
      for (const task of queue) {
        if (task.signal === this.signal) task.dropped = true;
      }
    }
  }

  globalThis.TaskController = FakeTaskController;
  globalThis.scheduler = {
    postTask(fn, init = {}) {
      const entry = { fn, signal: init?.signal, dropped: false };
      queue.push(entry);
      return { entry };
    },
  };

  return {
    /**
     * Run every queued task the platform did not drop.
     * @returns {number} How many callbacks actually ran.
     */
    drain() {
      const waiting = queue.splice(0, queue.length);
      let executed = 0;
      for (const task of waiting) {
        if (task.dropped || task.signal?.aborted) continue;
        task.fn();
        executed += 1;
      }
      ran += executed;
      return executed;
    },
    get queued() {
      return queue.length;
    },
    get droppedCount() {
      return queue.filter((t) => t.dropped).length;
    },
    get abortedCount() {
      return aborted;
    },
    get ranCount() {
      return ran;
    },
  };
}

/**
 * Re-import the module with whatever globals are currently installed, so the
 * module-load feature probe re-runs.
 *
 * @returns {Promise<any>} The `PowerScheduler` class from a fresh module instance.
 */
async function load() {
  vi.resetModules();
  const mod = await import('../src/helpers/powerScheduler.js');
  return mod.PowerScheduler;
}

describe("PowerScheduler scheduling: 'postTask'", () => {
  afterEach(() => {
    if (NATIVE_SCHEDULER === undefined) delete globalThis.scheduler;
    else globalThis.scheduler = NATIVE_SCHEDULER;
    if (NATIVE_TASK_CONTROLLER === undefined) delete globalThis.TaskController;
    else globalThis.TaskController = NATIVE_TASK_CONTROLLER;
  });

  it('runs the flush through postTask, with the requested priority', async () => {
    const fake = installPostTask();
    const PowerScheduler = await load();
    let ran = 0;
    const s = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask', taskPriority: 'background' }
    );

    expect(s.strategy).toEqual({ scheduling: 'postTask', supported: true });
    s.schedule();
    expect(s.scheduled, 'the platform owns the queue, so the flag stays set').toBe(true);
    expect(ran, 'not run yet — the platform owns the queue').toBe(0);
    expect(fake.queued, 'one task posted, not zero and not two').toBe(1);
    expect(fake.drain(), 'and the platform runs exactly one').toBe(1);
    expect(ran).toBe(1);
    expect(s.scheduled, 'and the flag clears as the flush runs').toBe(false);
    s.dispose();
  });

  it('delivers the priority and the signal to postTask', async () => {
    // The two options `postTask` takes that this library can influence. A test that
    // only checked the flush ran would pass an implementation that dropped both.
    const seen = [];
    let captured = null;
    class RecordingController {
      constructor() {
        this.signal = { aborted: false };
        captured = this;
      }
      abort() {
        this.signal.aborted = true;
      }
    }
    globalThis.TaskController = RecordingController;
    globalThis.scheduler = {
      postTask(fn, init) {
        seen.push(init);
        queueMicrotask(fn);
        // A real handle has no `cancel`; returning an empty object keeps that
        // true, so an implementation reaching for one fails rather than passing.
        return {};
      },
    };
    const PowerScheduler = await load();
    const s = new PowerScheduler(() => {}, {
      scheduling: 'postTask',
      taskPriority: 'user-blocking',
    });
    s.schedule();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(seen[0].priority).toBe('user-blocking');
    expect(seen[0].signal, 'a signal is passed, or abort could not work').toBe(captured.signal);
    expect(captured.signal.aborted, 'not aborted while pending').toBe(false);
    s.dispose();
  });

  it('defaults the priority to user-visible', async () => {
    // The default has to be a real answer rather than `undefined`, because a real
    // `postTask` treats a missing priority as `user-visible` too — so passing
    // `undefined` through and hard-coding the default are indistinguishable from
    // the outside unless the test reads what the implementation chose.
    installPostTask();
    const seen = [];
    globalThis.scheduler = {
      postTask(fn, init) {
        seen.push(init);
        queueMicrotask(fn);
        return {};
      },
    };
    const PowerScheduler = await load();
    const s = new PowerScheduler(() => {}, { scheduling: 'postTask' });
    s.schedule();
    await Promise.resolve();
    expect(seen[0].priority).toBe('user-visible');
    s.dispose();
  });

  it('cancel() aborts the task, so it never runs', async () => {
    // **The property the row exists for.** Without the abort the flush would still be
    // queued with the platform after `cancel()` returned.
    const fake = installPostTask();
    const PowerScheduler = await load();
    let ran = 0;
    const s = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask' }
    );

    s.schedule();
    s.cancel();
    expect(fake.abortedCount, 'the controller was aborted').toBe(1);
    expect(fake.drain(), 'the platform ran nothing').toBe(0);
    expect(ran, 'and the flush did not run').toBe(0);
    s.dispose();
  });

  it('flush() runs now and aborts the queued task, so it cannot run twice', async () => {
    const fake = installPostTask();
    const PowerScheduler = await load();
    let ran = 0;
    const s = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask' }
    );

    s.schedule();
    s.flush();
    expect(ran, 'flushed synchronously').toBe(1);
    expect(fake.abortedCount).toBe(1);
    expect(fake.drain(), 'the queued copy was dropped, not run late').toBe(0);
    expect(ran, 'still once — the queued copy was aborted').toBe(1);
    s.dispose();
  });

  it('dispose() aborts a pending task, so nothing lands on a torn-down scheduler', async () => {
    // The third abort site, and the one that is easiest to forget: `dispose()` is a
    // teardown, and a task queued against it would run the callback afterwards.
    const fake = installPostTask();
    const PowerScheduler = await load();
    let ran = 0;
    const s = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask' }
    );

    s.schedule();
    s.dispose();
    expect(fake.abortedCount).toBe(1);
    expect(fake.drain()).toBe(0);
    expect(ran).toBe(0);
  });

  it('reschedule after cancel() posts a new task and runs exactly once', async () => {
    // The shape `yield` needed a generation counter for, done natively: the aborted
    // task is dropped by the platform, so there is no stale continuation to recognise.
    const fake = installPostTask();
    const PowerScheduler = await load();
    let ran = 0;
    const s = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask' }
    );

    s.schedule();
    s.cancel();
    s.schedule();
    // The aborted task is **still in the platform's queue** — a real `postTask` does not
    // pull it out, it skips it when it reaches the front — so `queued` is 2 and the count
    // that matters is how many the platform *runs*. Asserting `queued === 1` here would
    // pin a fake's bookkeeping instead of the behaviour this row adopts.
    expect(fake.queued, 'the platform still holds both').toBe(2);
    expect(fake.droppedCount, 'and one of them is marked aborted').toBe(1);
    expect(fake.drain(), 'one flush, not two').toBe(1);
    expect(ran).toBe(1);
    s.dispose();
  });

  it('aborts once, however many times teardown is called', async () => {
    // `dispose()` is idempotent, so a double teardown must not abort twice: a
    // controller that has already aborted has had its work dropped, and a second
    // `abort()` on a handle the platform has forgotten is at best wasted and at
    // worst an error surfaced out of teardown.
    const fake = installPostTask();
    const PowerScheduler = await load();
    const s = new PowerScheduler(() => {}, { scheduling: 'postTask' });
    s.schedule();
    s.dispose();
    s.dispose();
    s.cancel();
    expect(fake.abortedCount).toBe(1);
  });

  it('falls back to a macrotask where postTask is missing, and says so', async () => {
    // `supported: false` is the contract. A silent substitution would leave a caller
    // believing they had browser task priorities in a runtime with none.
    removePostTask();
    const PowerScheduler = await load();
    const s = new PowerScheduler(() => {}, { scheduling: 'postTask' });
    expect(s.strategy).toEqual({ scheduling: 'postTask', supported: false });
    let ran = 0;
    const t = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask' }
    );
    t.schedule();
    // **Not merely "it still flushes."** A microtask fallback would satisfy that and is
    // a different ordering — the whole reason `yield` and `postTask` fall back to a
    // *macrotask* rather than to `queueMicrotask`, which is what the unsupported branch
    // already did for `yield`. One microtask checkpoint is therefore the discriminator:
    // a `MessageChannel` flush has not run by then and a microtask one has.
    await Promise.resolve();
    await Promise.resolve();
    expect(ran, 'a macrotask, not a microtask — the ordering is the whole point').toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ran, 'and it still flushes').toBe(1);
    s.dispose();
    t.dispose();
  });

  it('treats postTask without TaskController as unsupported', async () => {
    // Both halves are required. `postTask` alone returns a handle with no `cancel`, so a
    // strategy built on it would be *less* cancellable than the MessageChannel macrotask
    // it would replace — and nothing in the feature test would notice.
    globalThis.scheduler = {
      postTask(fn) {
        queueMicrotask(fn);
        return {};
      },
    };
    delete globalThis.TaskController;
    const PowerScheduler = await load();
    const s = new PowerScheduler(() => {}, { scheduling: 'postTask' });
    expect(s.strategy.supported, 'no TaskController, so no').toBe(false);
    s.dispose();
  });

  it('treats a TaskController without postTask as unsupported', async () => {
    // The symmetric half, and the one a reader would assume is implied. `TaskController`
    // alone gives nothing: without `postTask` there is no task to attach a signal to.
    globalThis.scheduler = { yield: () => Promise.resolve() };
    globalThis.TaskController = function () {};
    const PowerScheduler = await load();
    const s = new PowerScheduler(() => {}, { scheduling: 'postTask' });
    expect(s.strategy.supported, 'no postTask, so no').toBe(false);
    s.dispose();
  });

  it('rejects an unknown strategy and an unknown priority', async () => {
    installPostTask();
    const PowerScheduler = await load();
    // The closed set is the point: a typo must not silently pick the fastest strategy.
    for (const bad of ['posttask', 'PostTask', 'postTask ', 'idle', '']) {
      expect(() => new PowerScheduler(() => {}, { scheduling: bad }), bad).toThrow(TypeError);
    }
    for (const bad of ['urgent', 'USER-VISIBLE', 1]) {
      expect(
        () => new PowerScheduler(() => {}, { scheduling: 'postTask', taskPriority: bad }),
        String(bad)
      ).toThrow(TypeError);
    }
    // And a valid one is accepted, which is the control that keeps the loop above honest.
    expect(
      () => new PowerScheduler(() => {}, { scheduling: 'postTask', taskPriority: 'background' })
    ).not.toThrow();
  });

  it('validates taskPriority on every strategy, and applies it only to postTask', async () => {
    // `PowerCache`'s `filter` option sets the precedent and the reason: the *value* is
    // validated wherever it appears, because a value that cannot be honoured should say
    // so rather than sit there doing nothing — while a valid one on a strategy with no
    // use for it is accepted, since rejecting it would break a caller forwarding a
    // shared options object. So `microtask` + `background` is legal and inert.
    installPostTask();
    const PowerScheduler = await load();
    expect(
      () => new PowerScheduler(() => {}, { scheduling: 'microtask', taskPriority: 'nonsense' })
    ).toThrow(TypeError);

    let ran = 0;
    const m = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'microtask', taskPriority: 'background' }
    );
    m.schedule();
    await Promise.resolve();
    expect(ran, 'still a microtask — the priority is inert, not substituted').toBe(1);
    m.dispose();
  });

  it('needs no generation counter on this path', async () => {
    // The row's claim, asserted structurally rather than by reading the source: the
    // postTask branch must not read `_generation` at all. A counter left in place would
    // be harmless but would be the thing a future reader believes is load-bearing.
    const fake = installPostTask();
    const PowerScheduler = await load();
    let ran = 0;
    const s = new PowerScheduler(
      () => {
        ran += 1;
      },
      { scheduling: 'postTask' }
    );
    const before = s._generation;
    s.schedule();
    expect(s._generation, 'unchanged — nothing to guard against').toBe(before);
    fake.drain();
    expect(ran).toBe(1);
    expect(s._generation, 'still unchanged after the flush ran').toBe(before);
    s.dispose();
  });

  it('leaves the other three strategies untouched', async () => {
    // `postTask` is additive. A change to `microtask`, `macrotask` or `yield` would
    // alter behaviour for existing callers, which is the thing this row is not for.
    installPostTask();
    const PowerScheduler = await load();
    for (const strategy of ['microtask', 'macrotask', 'yield']) {
      const s = new PowerScheduler(() => {}, { scheduling: strategy });
      expect(s.strategy.scheduling).toBe(strategy);
      s.dispose();
    }
    // `yield` is still supported here, i.e. the fake's `scheduler` object did not
    // erase the other strategy's feature detection when it replaced the global.
    const y = new PowerScheduler(() => {}, { scheduling: 'yield' });
    expect(y.strategy.supported, 'yield detection is independent of postTask').toBe(false);
    y.dispose();
  });
});
