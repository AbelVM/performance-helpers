/**
 * RES-006: an abandoned `scheduler.yield()` continuation ran the *next* flush.
 *
 * The yield strategy has no cancellable handle — `scheduler.yield()` returns a
 * promise that resolves when the continuation is resumed, and it is already
 * queued by the time anyone could detach it. So a continuation left over from a
 * previous `schedule()` has to be able to tell that it has been superseded.
 *
 * The code carried a comment saying it could not, on this reasoning: "`_run()`
 * opens with `if (!this._scheduled) return`, and both `flush()` and `cancel()`
 * clear `_scheduled` before returning, so an abandoned continuation finds the
 * schedule already closed and does nothing", and it called a generation counter
 * an "equivalent mutant" because removing it left all seven yield-path tests
 * green.
 *
 * The reasoning is wrong in one clause: **`flush()` does not clear `_scheduled` —
 * `_run()` does, as a side effect of *running*.** So after
 * `schedule(); flush(); schedule()` the flag is true again, and the abandoned
 * continuation finds a live schedule. Measured with a controllable
 * `scheduler.yield`:
 *
 *     schedule(); flush(); schedule()      -> 1 flush, 2 continuations queued
 *     resume the ABANDONED continuation   -> 2 flushes, `_timer` null
 *
 * The newer schedule was flushed early, and its timer handle clobbered on the way
 * past. The seven tests were green throughout because none of them resumed an
 * abandoned continuation.
 *
 * The fix is one integer. The instrument here is a **flush count and a handle
 * shape**, not a duration: the ordering is driven by resolving promises by hand,
 * so nothing here depends on how long anything took.
 */
import { describe, it, expect, afterEach } from 'vitest';

/** @type {Array<() => void>} */
const cleanups = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  delete (/** @type {any} */ (globalThis).scheduler);
});

/**
 * Import a fresh `PowerScheduler` with a controllable `scheduler.yield`.
 *
 * The stub must be installed **before** the import: `HAS_SCHEDULER_YIELD` is
 * evaluated once at module load, so a stub installed afterwards is ignored and
 * the yield path silently falls back to a macrotask. The first version of this
 * test did that and every assertion below passed for the wrong reason.
 *
 * @returns {Promise<{PowerScheduler: any, yields: Array<() => void>}>}
 */
async function withYield() {
  /** @type {Array<() => void>} */
  const yields = [];
  /** @type {any} */ (globalThis).scheduler = {
    yield: () => new Promise((resolve) => yields.push(resolve)),
  };
  cleanups.push(() => {
    delete (/** @type {any} */ (globalThis).scheduler);
  });
  const mod = await import('../src/helpers/powerScheduler.js?yield-gen');
  return { PowerScheduler: mod.PowerScheduler, yields };
}

describe('RES-006: a superseded yield continuation is inert', () => {
  it('does not flush the next schedule early', async () => {
    // The defect. The second flush happens when the *first*, abandoned
    // continuation is resumed — so the newer schedule ran at the wrong time, by
    // one whole scheduling window.
    const { PowerScheduler, yields } = await withYield();
    let flushes = 0;
    const scheduler = new PowerScheduler(
      () => {
        flushes += 1;
      },
      { scheduling: 'yield' }
    );
    cleanups.push(() => scheduler.dispose());

    scheduler.schedule();
    scheduler.flush();
    scheduler.schedule();
    expect(flushes).toBe(1);
    expect(yields.length).toBe(2);

    yields[0](); // resume the abandoned one
    await Promise.resolve();
    await Promise.resolve();

    // Still one. The second schedule is untouched.
    expect(flushes).toBe(1);
  });

  it('does not clobber the newer timer handle', async () => {
    // The second half of the same bug, and the reason a flush count alone is
    // not enough. The abandoned continuation nulled `_timer` on its way to the
    // early `_run()`, so the *live* handle was destroyed and nothing could
    // cancel it afterwards.
    const { PowerScheduler, yields } = await withYield();
    const scheduler = new PowerScheduler(() => {}, { scheduling: 'yield' });
    cleanups.push(() => scheduler.dispose());

    scheduler.schedule();
    scheduler.flush();
    scheduler.schedule();
    expect(scheduler._timer).not.toBeNull();

    yields[0]();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler._timer).not.toBeNull();
  });

  it('still flushes the continuation that is current', async () => {
    // The counterpart, and the reason the guard is on the generation rather than
    // a blanket "never run". A guard that skipped every continuation would pass
    // both tests above and break the scheduler.
    const { PowerScheduler, yields } = await withYield();
    let flushes = 0;
    const scheduler = new PowerScheduler(
      () => {
        flushes += 1;
      },
      { scheduling: 'yield' }
    );
    cleanups.push(() => scheduler.dispose());

    scheduler.schedule();
    expect(flushes).toBe(0);

    yields[0](); // the only continuation
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toBe(1);
  });

  it('flush() then schedule() delivers exactly one flush, at the right time', async () => {
    // The whole sequence the row names, end to end. After the fix the second
    // schedule is delivered by *its own* continuation and not before.
    const { PowerScheduler, yields } = await withYield();
    let flushes = 0;
    const scheduler = new PowerScheduler(
      () => {
        flushes += 1;
      },
      { scheduling: 'yield' }
    );
    cleanups.push(() => scheduler.dispose());

    scheduler.schedule(); // continuation 1
    scheduler.flush(); // runs it; the continuation stays queued
    expect(flushes).toBe(1);

    scheduler.schedule(); // continuation 2

    // Resuming continuation 1 must do nothing at all.
    yields[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushes).toBe(1);

    // Continuation 2 delivers it.
    yields[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushes).toBe(2);
  });

  it('reports the yield strategy as supported, or none of this applies', async () => {
    // The guard on the guard. If a future change made the stub not take effect,
    // every assertion above would pass while exercising the macrotask
    // fallback.
    const { PowerScheduler } = await withYield();
    const scheduler = new PowerScheduler(() => {}, { scheduling: 'yield' });
    cleanups.push(() => scheduler.dispose());
    expect(scheduler.strategy).toEqual({ scheduling: 'yield', supported: true });
  });
});
