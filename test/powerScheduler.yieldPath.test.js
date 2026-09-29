import { describe, it, expect, vi } from 'vitest';

/**
 * ALG-007: the `scheduling: 'yield'` path itself, with `scheduler.yield()`
 * present.
 *
 * **This file exists because the first version of these tests was inert.**
 * `scheduler.yield()` does not exist in Node, so the sibling
 * `powerScheduler.yield.test.js` exercised the *fallback* for all ten of its
 * cases and the yield branch — the generation counter, the stale check, the
 * whole reason `flush()` and `cancel()` behave the way they do — was never run
 * once. The suite was green and the feature was untested, which is the same
 * signature as the W-TinyLFU window armed before its sketch existed.
 *
 * `HAS_SCHEDULER_YIELD` is read at **module load**, deliberately (probing a
 * stable runtime feature on every flush would add a property read to the hot
 * path). That means the global has to be in place *before* the import, so the
 * module is loaded dynamically below rather than at the top of the file.
 */

/** A `scheduler.yield()` stand-in whose continuations the test controls. */
function installSchedulerYield() {
  const pending = [];
  const fake = {
    yield() {
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
  };
  globalThis.scheduler = fake;
  return {
    /** Resume every pending yield continuation. */
    async flushContinuations() {
      const waiting = pending.splice(0, pending.length);
      for (const resolve of waiting) resolve();
      // Let the `.then` continuations the scheduler attached run.
      await Promise.resolve();
      await Promise.resolve();
      return waiting.length;
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

const originalScheduler = globalThis.scheduler;
const harness = installSchedulerYield();
const { PowerScheduler } = await import('../src/helpers/powerScheduler.js');

describe("PowerScheduler scheduling: 'yield' (with scheduler.yield present)", () => {
  it('proves the harness is exercising the yield path, not the fallback', () => {
    // Without this the file could quietly degrade into the sibling's problem the
    // moment the import is hoisted or the global is set too late.
    const s = new PowerScheduler(() => {}, { scheduling: 'yield' });
    expect(s.strategy).toEqual({ scheduling: 'yield', supported: true });
    s.dispose();
  });

  it('does not run the flush until the yield continuation is resumed', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();

    // The yield is pending, so nothing has run. This is the property that
    // separates a yield from a microtask: the continuation is the queue.
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
    expect(harness.pendingCount).toBe(1);

    await harness.flushContinuations();
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('cancel() makes a pending yield stale, so the flush never runs', async () => {
    // The yield cannot be un-scheduled — it is already queued and returns only
    // a promise. So `cancel()` bumps a generation counter and the continuation
    // goes stale on arrival. Without it, cancelling would be a no-op that
    // happened to look like it worked whenever nothing else was pending.
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.cancel();

    expect(harness.pendingCount).toBe(1); // still queued; cancellation is logical
    await harness.flushContinuations();
    expect(flush).not.toHaveBeenCalled();
    s.dispose();
  });

  it('flush() runs once and the abandoned yield does not run a second time', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.flush();
    expect(flush).toHaveBeenCalledTimes(1);

    // The continuation still arrives; it must find itself stale.
    await harness.flushContinuations();
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('reschedules after a cancel and runs on the next continuation', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.cancel();
    s.schedule();
    await harness.flushContinuations();
    // One run, from the second schedule. The first yield is still in the
    // harness queue if the test did not drain it, so drain first.
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('coalesces repeated schedule() calls into one yield', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.schedule();
    s.schedule();
    // One continuation, not three: `schedule()` is documented as coalescing and
    // a yield strategy must not quietly change that.
    expect(harness.pendingCount).toBe(1);
    await harness.flushContinuations();
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('an abandoned continuation does not produce a second flush', async () => {
    // Two yields are in the harness queue: one abandoned by `flush()`, one
    // live. Resuming both must produce exactly one flush - the live one. If the
    // generation check were missing or wrong, the abandoned continuation would
    // also run, and the caller would get the work twice.
    //
    // An earlier draft of this test asserted the *handle* survived, which was
    // simply wrong: the live continuation is supposed to clear it, because the
    // flush it represents ran.
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.flush(); // bumps the generation, runs immediately, abandons yield #1
    expect(flush).toHaveBeenCalledTimes(1);

    s.schedule(); // yield #2, live
    expect(s._timer).not.toBeNull();

    await harness.flushContinuations(); // both continuations arrive
    // Exactly one more: the abandoned one contributed nothing.
    expect(flush).toHaveBeenCalledTimes(2);
    expect(s.scheduled).toBe(false);
    s.dispose();
  });
});

export { originalScheduler };
