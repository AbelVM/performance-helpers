import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerScheduler } from '../src/helpers/powerScheduler.js';

/**
 * ALG-007: `scheduling: 'yield'` — the third strategy.
 *
 * `scheduler.yield()` is the browser-native way to hand control back to the
 * event loop, and it is prioritised ahead of the rendering and task queues,
 * which is what makes it the right primitive for a scheduler whose job is to run
 * *promptly*. It is a different thing from `requestIdleCallback`, which the
 * same row considered and refused: an idle callback may not run at all, and a
 * scheduler that promises prompt completion cannot host one.
 *
 * The awkward part is cancellation, and it is what these tests cover. A
 * `scheduler.yield()` continuation is already queued the moment it is requested
 * and returns only a promise — **there is no handle to detach**. So `flush()`
 * and `cancel()` cannot un-schedule it; they have to make the continuation
 * *stale*, which is what the generation counter is for. A test that only checked
 * "the flush eventually runs" would pass against an implementation where
 * cancelling did nothing at all.
 */

const hasYield =
  typeof globalThis === 'object' &&
  globalThis.scheduler != null &&
  typeof globalThis.scheduler.yield === 'function';

describe("PowerScheduler scheduling: 'yield'", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an unknown strategy rather than defaulting to microtask', () => {
    // The old line was `scheduling === 'macrotask' ? 'macrotask' : 'microtask'`,
    // so `'macrotask '` with a trailing space, or `'idle'`, silently became
    // microtask - the *fastest* strategy, for a caller who asked for something
    // else. A typo in a performance option should not make the code faster.
    for (const bad of ['idle', 'macrotask ', 'Macrotask', 'setTimeout', '']) {
      expect(() => new PowerScheduler(() => {}, { scheduling: bad }), bad).toThrow(
        '`scheduling` must be one of'
      );
    }
  });

  it('accepts the three known strategies', () => {
    for (const good of ['microtask', 'macrotask', 'yield']) {
      expect(() => new PowerScheduler(() => {}, { scheduling: good }), good).not.toThrow();
    }
    // `undefined` still means the default.
    expect(() => new PowerScheduler(() => {}, {})).not.toThrow();
  });

  it('reports the requested strategy and whether the runtime can honour it', () => {
    // The whole point of the pair: `scheduling: 'yield'` on a runtime without
    // `scheduler.yield()` falls back to a macrotask, and a caller has to be
    // able to see that. Reporting only the request would make the substitution
    // invisible, which is the failure this getter exists to prevent.
    const s = new PowerScheduler(() => {}, { scheduling: 'yield' });
    expect(s.strategy.scheduling).toBe('yield');
    expect(s.strategy.supported).toBe(hasYield);

    const micro = new PowerScheduler(() => {}, { scheduling: 'microtask' });
    expect(micro.strategy).toEqual({ scheduling: 'microtask', supported: true });
  });

  it('flushes exactly once', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.schedule(); // coalesced
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('cancel() prevents a pending yield from running', async () => {
    // The property that distinguishes cancelling from merely racing. Without
    // the generation counter the continuation would fire and flush a scheduler
    // the caller had already cancelled.
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.cancel();
    expect(s.scheduled).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).not.toHaveBeenCalled();
    s.dispose();
  });

  it('cancel() on an already-cancelled scheduler is a no-op', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.cancel();
    s.cancel();
    s.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).not.toHaveBeenCalled();
    s.dispose();
  });

  it('flush() runs immediately and does not double-run when the yield lands', async () => {
    // `flush()` cannot un-schedule the yield either; it bumps the generation so
    // the continuation goes stale. If it did not, the caller would get the
    // flush twice - once eagerly and once from the abandoned continuation.
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('can be rescheduled after a cancel', async () => {
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    s.cancel();
    s.schedule();
    await new Promise((r) => setTimeout(r, 20));
    expect(flush).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('reports a thrown flush through onError rather than an unhandled rejection', async () => {
    const onError = vi.fn();
    const s = new PowerScheduler(
      () => {
        throw new Error('flush failed');
      },
      { scheduling: 'yield', onError }
    );
    s.schedule();
    await new Promise((r) => setTimeout(r, 20));
    expect(onError).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('falls back to a macrotask where scheduler.yield() is unavailable', async () => {
    // Only meaningful where the feature is genuinely absent; on a runtime that
    // has it, `supported` is true and there is nothing to fall back from.
    if (hasYield) {
      const s = new PowerScheduler(() => {}, { scheduling: 'yield' });
      expect(s.strategy.supported).toBe(true);
      s.dispose();
      return;
    }
    const flush = vi.fn();
    const s = new PowerScheduler(flush, { scheduling: 'yield' });
    s.schedule();
    await new Promise((r) => setTimeout(r, 20));
    // The flush still runs promptly. The fallback costs ordering, not liveness,
    // and that is the distinction the getter documents.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(s.strategy.supported).toBe(false);
    s.dispose();
  });
});
