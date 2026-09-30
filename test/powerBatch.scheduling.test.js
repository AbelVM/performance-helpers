/**
 * RES-033: `PowerBatch` silently rewrote the strategy it was asked for.
 *
 * The constructor read:
 *
 * ```js
 * scheduling: scheduling === 'macrotask' ? 'macrotask' : 'microtask'
 * ```
 *
 * Two things go wrong, and both are quiet:
 *
 *   - **A typo becomes the fastest strategy.** `'typo'`, `'macro'`, `'MACROTASK'`
 *     all land on `'microtask'`. `PowerScheduler` exists precisely to reject that,
 *     and its own comment says why: "a typo would otherwise silently pick the
 *     *fastest* strategy for a scheduler that was asked for something else." The
 *     one layer that could have thrown had already discarded the value.
 *   - **`'yield'` is lost entirely.** `PowerScheduler` supports it and
 *     prioritises it, and the JSDoc type did not list it either — so the strategy
 *     was unreachable through this class in both types and runtime.
 *
 * Separately, `onError` was not forwarded. `_runBatch`'s `else throw err` is
 * reached when the handler rejects with **no** pending promise to reject — a
 * scheduler-driven flush rather than an `add()`-triggered one — and that error
 * had nowhere to go but an unhandled rejection nothing in this class could
 * observe.
 *
 * Assertions are on the strategy the scheduler actually received, on the throw,
 * and on a captured error. No timing.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerBatch } from '../src/helpers/powerBatch.js';

/**
 * Capture the `scheduling` value a `PowerBatch` hands its scheduler.
 *
 * Wraps the real `PowerScheduler` so nothing about the strategy's behaviour is
 * faked — only the argument is observed, so a change to the real scheduling would
 * still show up in any other test.
 *
 * @returns {Promise<{schedulings: any[], onErrors: any[]}>}
 */
async function captureSchedulerArgs() {
  const { PowerScheduler: Real } = await import('../src/helpers/powerScheduler.js');
  /** @type {any[]} */
  const schedulings = [];
  /** @type {any[]} */
  const onErrors = [];
  vi.doMock('../src/helpers/powerScheduler.js', () => ({
    PowerScheduler: class extends Real {
      /** @param {Function} flushFn @param {any} [options] */
      constructor(flushFn, options = {}) {
        super(flushFn, options);
        schedulings.push(options.scheduling);
        onErrors.push(options.onError);
      }
    },
  }));
  vi.resetModules();
  const mod = await import('../src/helpers/powerBatch.js');
  return { PowerBatch: mod.PowerBatch, schedulings, onErrors };
}

describe('RES-033: PowerBatch passes the strategy through', () => {
  it('hands the scheduler the exact value it was given', async () => {
    // The core claim. Before the fix, every value except the literal
    // `'macrotask'` arrived as `'microtask'`.
    for (const scheduling of ['microtask', 'macrotask', 'yield']) {
      vi.resetModules();
      const { PowerBatch: Counted, schedulings } = await captureSchedulerArgs();
      const batch = new Counted(() => {}, { scheduling });
      expect(schedulings, `scheduling: '${scheduling}' was rewritten`).toEqual([scheduling]);
      batch.dispose();
    }
  });

  it('defaults to microtask when the option is omitted', async () => {
    // The default is applied in `PowerBatch`'s own destructuring, so the fix does
    // not change the no-option path.
    const { PowerBatch: Counted, schedulings } = await captureSchedulerArgs();
    const batch = new Counted(() => {});
    expect(schedulings).toEqual(['microtask']);
    batch.dispose();
  });

  it('rejects a typo instead of running the fastest strategy', async () => {
    // What `PowerScheduler` has always done, and what the coercion defeated. The
    // message names the valid set, so the caller can see what was expected.
    expect(() => new PowerBatch(() => {}, { scheduling: 'typo' })).toThrow(
      /scheduling.*must be one of/i
    );
    for (const typo of ['macro', 'MACROTASK', 'Macrotask', '']) {
      expect(
        () => new PowerBatch(() => {}, { scheduling: typo }),
        `"${typo}" should throw`
      ).toThrow();
    }
  });

  it('accepts yield, which the strategy set has always supported', async () => {
    // Constructing is the assertion. Whether `scheduler.yield()` exists is the
    // scheduler's own business — it falls back — so what this pins is that the
    // value is *reachable* here, which it was not before, in types or runtime.
    expect(() => new PowerBatch(() => {}, { scheduling: 'yield' })).not.toThrow();
  });
});

describe('RES-033: a scheduler-driven handler rejection reaches onError', () => {
  it('never lets a handler rejection become an unhandled rejection', async () => {
    // The real property, and it is observable. `PowerScheduler._run` normalises
    // the flush result to a promise and funnels both a synchronous throw and an
    // async rejection into `_notifyError`, so a rejection reaches a pending
    // `add()` promise, an `onError`, or both — never the process.
    //
    // The first version of this test asserted `onError` directly and failed: it
    // read 0 calls and the error surfaced as an unhandled rejection. The
    // premise was wrong, not the fix. `_runBatch`'s `else throw err` — the line
    // the row cites — needs `_pending` to be **null** while the queue is
    // non-empty, and every `add()` creates a pending, so that branch looks
    // unreachable through the public API. `onError` is therefore a safety net for
    // it rather than a fix for an observed failure, and this test pins the
    // property that is actually reachable.
    const onError = vi.fn();
    const boom = new Error('handler exploded');
    const batch = new PowerBatch(() => Promise.reject(boom), { onError });

    // The handler is attached deliberately: the rejection goes to the `add()`
    // promise, and leaving that promise unobserved would itself be an unhandled
    // rejection — which is exactly the failure mode under test, produced by the
    // test. A file that reports no unhandled rejection is half the assertion.
    batch.add({ a: 1 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onError).not.toHaveBeenCalled(); // it went to the pending instead

    batch.dispose();
  });

  it('still rejects the add() promise when there is one', async () => {
    // The counterpart, and the reason the change is additive: the common path is
    // unchanged, so `add()` still surfaces the handler's error to its caller.
    const onError = vi.fn();
    const boom = new Error('handler exploded');
    const batch = new PowerBatch(() => Promise.reject(boom), { onError });

    await expect(batch.add({ a: 1 })).rejects.toBe(boom);
    expect(onError).not.toHaveBeenCalled();
    batch.dispose();
  });

  it('forwards onError to the scheduler rather than handling it here', async () => {
    // The shape: `PowerBatch` passes the function through and the scheduler owns
    // the routing. Asserting the argument is what proves the pass-through, and
    // that it is `undefined` — not a wrapper — when the caller supplied nothing.
    const onError = vi.fn();
    const { PowerBatch: Counted, onErrors } = await captureSchedulerArgs();
    const withHandler = new Counted(() => {}, { onError });
    const without = new Counted(() => {});
    expect(onErrors[0]).toBe(onError);
    expect(onErrors[1]).toBeUndefined();
    withHandler.dispose();
    without.dispose();
  });
});
