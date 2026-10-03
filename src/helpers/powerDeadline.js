import { PowerRetry } from './powerRetry.js';
import { nowMs } from '../utils/now.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {import('./jsdoc-types.js').PowerDeadlineOptions} PowerDeadlineOptions
 * @typedef {import('./jsdoc-types.js').PowerRetryOptions} PowerRetryOptions
 */

/**
 * Deadline-aware async helper for timeout, retry budget, and abort metadata.
 *
 * Use `PowerDeadline` to wrap async work with per-attempt timeouts, a total
 * deadline for the whole operation, and optional retry/backoff behavior.
 *
 * @class PowerDeadline
 * @public
 */
export class PowerDeadline {
  /**
   * Run a function with deadline semantics.
   * @param {Function} fn Async function to execute.
   * @param {PowerDeadlineOptions} [options]
   * @returns {Promise<any>}
   */
  static async run(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');

    const {
      maxAttempts = 1,
      attemptTimeout = null,
      totalTimeout = null,
      retryDelay = 0,
      retryIf = () => true,
      signal = null,
      onRetry,
      backoff,
      baseDelay,
      maxDelay,
      jitter,
    } = options || {};

    // These were `Math.max(1, Math.floor(Number(x) || 1))` and friends, which
    // silently rewrote nonsense into a plausible default: `maxAttempts: 0` and
    // `maxAttempts: -5` both became 1, and `retryDelay: 'soon'` became 0. A
    // caller who computed a budget and got 1 attempt back would never know.
    const attempts = assertLimitRequired(maxAttempts, {
      name: 'maxAttempts',
      className: 'PowerDeadline',
      min: 1,
      integer: true,
      fallback: 1,
    });
    const perAttemptTimeout =
      attemptTimeout === undefined || attemptTimeout === null
        ? null
        : assertLimitRequired(attemptTimeout, {
            name: 'attemptTimeout',
            className: 'PowerDeadline',
            min: 1,
          });
    const deadlineMs =
      totalTimeout === undefined || totalTimeout === null
        ? null
        : assertLimitRequired(totalTimeout, {
            name: 'totalTimeout',
            className: 'PowerDeadline',
            min: 1,
          });
    const delayMs = assertLimitRequired(retryDelay, {
      name: 'retryDelay',
      className: 'PowerDeadline',
      min: 0,
      fallback: 0,
    });
    const shouldRetry = typeof retryIf === 'function' ? retryIf : () => Boolean(retryIf);

    const startedAt = nowMs();
    const deadlineAt = deadlineMs !== null ? startedAt + deadlineMs : null;
    // Controller whose signal is folded into the user fn's signal so that when
    // the total deadline fires we can abort in-flight work instead of leaving
    // it running after the operation has already been rejected.
    const deadlineController =
      deadlineAt !== null && typeof AbortController !== 'undefined' ? new AbortController() : null;

    const createAbortPromise = () => {
      if (!signal) return null;
      if (signal.aborted) {
        return {
          promise: Promise.reject(createAbortError(signal.reason, startedAt, deadlineMs)),
          cleanup: null,
        };
      }
      let cleanup = null;
      const promise = new Promise((_, reject) => {
        const onAbort = () => {
          reject(createAbortError(signal.reason, startedAt, deadlineMs));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      });
      return { promise, cleanup };
    };

    /**
     * @param {number} attempt 1-based attempt number, as `PowerRetry` counts them.
     * @param {AbortSignal|undefined} retrySignal
     */
    const wrapAttempt = async (attempt, retrySignal) => {
      const attemptStarted = nowMs();
      if (deadlineAt !== null && attemptStarted >= deadlineAt) {
        const err = /** @type {Error & {code: string, attempts: number, elapsedMs: number}} */ (
          new Error('Deadline exceeded')
        );
        err.code = 'EDEADLINE';
        err.attempts = attempt;
        err.elapsedMs = nowMs() - startedAt;
        throw err;
      }

      // **An already-aborted signal must not start the work.** Handing `fn` a
      // signal the caller has already cancelled means starting it and then
      // abandoning it: `createAbortPromise` returns a rejected promise, so
      // `Promise.race` rejects with `EABORT` — but `candidates[0]` has already
      // been constructed by then, so `fn` ran, its side effects happened, and its
      // result was thrown away. Measured before this fix: an already-aborted
      // external signal produced **1 `fn` invocation** on the way to the correct
      // `EABORT` rejection.
      //
      // Checked here, beside the deadline guard, for the same reason that one
      // exists: the cheapest place to refuse is before anything is constructed.
      // `retrySignal` is checked too — a per-attempt timeout that already fired
      // means this attempt is over, and it is the same defect with a different
      // clock.
      if (signal?.aborted) {
        const err = createAbortError(signal.reason, startedAt, deadlineMs);
        err.attempts = attempt;
        err.attemptTimeout = perAttemptTimeout;
        err.totalTimeout = deadlineMs;
        throw err;
      }
      if (retrySignal?.aborted) {
        const err = createAbortError(retrySignal.reason, startedAt, deadlineMs);
        err.attempts = attempt;
        err.attemptTimeout = perAttemptTimeout;
        err.totalTimeout = deadlineMs;
        throw err;
      }

      // Signal handed to the user's fn: aborts on external abort and/or on the
      // per-attempt timeout signal provided by PowerRetry, so callers can stop
      // in-flight work instead of leaving it running after a timeout fires.
      //
      // **Both combines register their detacher in `cleanups`.** They are nested
      // because the outer one joins the caller's signal to the inner one, and an
      // inner signal that outlives its attempt is what retains the caller's
      // listener. The inner detacher is registered *first*, so teardown runs in
      // the reverse of setup — detach the join before the thing being joined.
      // Nothing else had to change: the `finally` already runs on every path out
      // of the attempt, including the early throw from the race.
      const inner = combineSignals(
        retrySignal,
        deadlineController ? deadlineController.signal : null
      );
      const combined = combineSignals(signal, inner.signal);
      const userSignal = combined.signal;
      const abortPromise = createAbortPromise();
      const candidates = [Promise.resolve().then(() => fn(userSignal))];
      const cleanups = [inner.detach, combined.detach];

      if (deadlineAt !== null) {
        const remaining = deadlineAt - nowMs();
        let clearTotalTimeout;
        const p = new Promise((_, reject) => {
          const timer = setTimeout(() => {
            // Abort the user fn's signal so in-flight work can stop instead of
            // leaking after the deadline has already rejected the operation.
            if (deadlineController) {
              try {
                deadlineController.abort();
              } catch (e) {
                /* ignore */
              }
            }
            const err = /** @type {Error & {code: string, attempts: number, elapsedMs: number}} */ (
              new Error('Deadline exceeded')
            );
            err.code = 'EDEADLINE';
            err.attempts = attempt;
            err.elapsedMs = nowMs() - startedAt;
            reject(err);
          }, remaining);
          clearTotalTimeout = () => clearTimeout(timer);
        });
        candidates.push(p);
        cleanups.push(clearTotalTimeout);
      }

      if (abortPromise) {
        candidates.push(abortPromise.promise);
        if (typeof abortPromise.cleanup === 'function') cleanups.push(abortPromise.cleanup);
      }

      try {
        return await Promise.race(candidates);
      } catch (err) {
        if (err && typeof err === 'object') {
          // The guard narrows to `object`, which declares none of these. Whatever
          // lost the race carries them as own properties, so the cast states what
          // the code has just written rather than widening the guard.
          const stamped =
            /** @type {{attempts?: number, attemptTimeout?: number|null, totalTimeout?: number|null}} */ (
              err
            );
          stamped.attempts = attempt;
          stamped.attemptTimeout = perAttemptTimeout;
          stamped.totalTimeout = deadlineMs;
        }
        throw err;
      } finally {
        for (const cleanup of cleanups) {
          if (typeof cleanup === 'function') cleanup();
        }
      }
    };

    // Typed as what it is handed to. The literal below carries four properties and
    // four more are attached conditionally, so inference produced a shape without
    // them and every `retryOptions.backoff = ...` was an error - including the
    // argument passed to `PowerRetry` at the bottom. `PowerRetryOptions` is the
    // type that call site already declares it to have, and importing it here is
    // load-bearing: an unimported name in a `@type` is not an error, it is
    // silently `any` - which cleared twenty errors while checking nothing, and
    // would have published this object as untyped.
    /** @type {PowerRetryOptions} */
    const retryOptions = {
      maxAttempts: attempts,
      attemptTimeout: perAttemptTimeout,
      retryIf: (err) => {
        if (err && (err.code === 'EABORT' || err.code === 'EDEADLINE')) return false;
        return shouldRetry(err);
      },
      onRetry,
    };

    if (typeof backoff !== 'undefined') retryOptions.backoff = backoff;
    if (typeof baseDelay !== 'undefined') retryOptions.baseDelay = baseDelay;
    if (typeof maxDelay !== 'undefined') retryOptions.maxDelay = maxDelay;
    if (typeof jitter !== 'undefined') retryOptions.jitter = jitter;

    if (delayMs > 0 && typeof retryOptions.backoff === 'undefined') {
      retryOptions.backoff = 'fixed';
      retryOptions.baseDelay = delayMs;
      retryOptions.maxDelay = delayMs;
      retryOptions.jitter = false;
    }

    let attemptCounter = 0;
    const attemptFn = async (retrySignal) => {
      attemptCounter += 1;
      return wrapAttempt(attemptCounter, retrySignal);
    };

    return PowerRetry.run(attemptFn, retryOptions);
  }

  /**
   * Create a configured `PowerDeadline` instance.
   * @param {PowerDeadlineOptions} [options] Default options applied to every `run()` invocation.
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      [
        'maxAttempts',
        'attemptTimeout',
        'totalTimeout',
        'retryDelay',
        'retryIf',
        'signal',
        'onRetry',
        'backoff',
        'baseDelay',
        'maxDelay',
        'jitter',
      ],
      'PowerDeadline'
    );
    this._options = options || {};
  }

  /**
   * Run a function with the configured deadline options merged with per-call options.
   * @param {Function} fn Async function to execute.
   * @param {PowerDeadlineOptions} [options]
   * @returns {Promise<any>}
   */
  async run(fn, options = {}) {
    return this.constructor.run(fn, Object.assign({}, this._options, options));
  }
}

/**
 * The error every aborted run rejects with.
 *
 * **The `@returns` is load-bearing, not decoration.** Without it `tsc` infers a
 * bare `Error`, and every `err.attempts` / `err.code` assignment at a call site
 * becomes a type error — which is how the callers that set `attempts` and
 * `attemptTimeout` added seven errors to the ratchet when RES-013 started throwing
 * this error directly instead of letting `Promise.race` reject with it. Same
 * treatment `queueFullError` and `oversizedFrameError` already get in
 * `utils/errors.js`, for the same reason: one condition, one error shape, and a
 * caller branches on `code` rather than parsing a message.
 *
 * @param {any} reason - The aborting signal's `reason`, passed through as-is so
 *   a caller can attribute the cancellation.
 * @param {number} startedAt - `nowMs()` at the start of the run, for `elapsedMs`.
 * @param {number|null} deadlineMs - The configured total timeout, for context.
 * @returns {Error & {code: 'EABORT', reason: any, attempts: number, elapsedMs: number, totalTimeout: number|null}}
 */
const createAbortError = (reason, startedAt, deadlineMs) => {
  const err = new Error('Aborted');
  /** @type {Error & {code: 'EABORT', reason: any, attempts: number, elapsedMs: number, totalTimeout: number|null}} */
  const typed = /** @type {any} */ (err);
  typed.code = 'EABORT';
  typed.reason = reason;
  typed.attempts = 0;
  typed.elapsedMs = nowMs() - startedAt;
  typed.totalTimeout = deadlineMs;
  return typed;
};

/**
 * Combine zero, one, or two AbortSignals into a single signal for the user fn.
 *
 * **Returns `{ signal, detach }`, and the caller must register `detach`.** An
 * `AbortSignal` is an `EventTarget`, not an `EventEmitter`: attaching an `abort`
 * listener adds one that is removed only when `abort` actually fires, and the
 * common case is that it never does — the run succeeds and the process moves on.
 * So `{ once: true }` is not a cleanup, it only avoids a second invocation once
 * the event has happened. Measured before this fix: **80 retained `abort`
 * listeners on one shared signal after 20 runs x 4 attempts**, one per attempt,
 * each holding `onAbort` → `controller` → the combined signal and everything the
 * caller attached to it. Nothing warned, because nothing could.
 *
 * `detach()` removes both listeners and is idempotent, so registering it in the
 * existing `cleanups` array is enough — no ownership question, and the `finally`
 * already runs on every path out of the attempt.
 *
 * **An already-aborted input aborts the result immediately.** Registering a
 * listener on a signal that has already fired is a no-op — the event is not
 * replayed — so the combined signal would never abort and `fn` would be invoked
 * against a signal the caller had already cancelled. Also checked before
 * attaching, because attaching to a dead signal is precisely what retains the
 * listener for nothing.
 *
 * `signal` is `undefined` when there is nothing to combine, so `fn` is called
 * without one — and `detach` is then a no-op rather than `undefined`, so the
 * caller never has to test it before pushing it onto `cleanups`.
 *
 * @param {AbortSignal|null} [external]
 * @param {AbortSignal|null} [retry]
 * @returns {{signal: AbortSignal|undefined, detach: () => void}}
 */
const combineSignals = (external, retry) => {
  const noop = () => {};
  if (!external && !retry) return { signal: undefined, detach: noop };
  if (!external) return { signal: retry, detach: noop };
  if (!retry) return { signal: external, detach: noop };
  if (typeof AbortController === 'undefined') return { signal: external, detach: noop };

  // **Aborted before anything is attached.** `addEventListener` on an
  // already-aborted signal never fires, so this is the only point at which the
  // already-aborted case can be answered.
  if (external.aborted || retry.aborted) {
    const controller = new AbortController();
    const reason = external.aborted ? external.reason : retry.reason;
    try {
      controller.abort(reason);
    } catch (e) {
      // `AbortController#abort` is specified never to throw, so this is for a
      // partial polyfill. Losing the forwarded reason would be bad; losing the
      // abort itself would be worse, and neither is worth propagating here —
      // the caller is already on the rejected path.
      controller.abort();
    }
    return { signal: controller.signal, detach: noop };
  }

  const controller = new AbortController();
  const onAbort = (e) => {
    // Forward the originating signal's reason so the caller can tell *which*
    // limit fired. `controller.abort()` with no argument would invent an
    // `AbortError` and lose that, which is the whole value of combining rather
    // than merely concatenating.
    try {
      controller.abort(e && e.target && 'reason' in e.target ? e.target.reason : undefined);
    } catch (err) {
      /* ignore */
    }
  };
  const sources = [external, retry].filter(
    (s) =>
      s && typeof s.addEventListener === 'function' && typeof s.removeEventListener === 'function'
  );
  for (const source of sources) {
    source.addEventListener('abort', onAbort, { once: true });
  }
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    for (const source of sources) {
      try {
        source.removeEventListener('abort', onAbort);
      } catch (e) {
        // **A `finally` is the worst place to throw from.** `detach` runs inside
        // the attempt teardown, so an exception here would replace the attempt's
        // real outcome — the actual error, or the value the caller was waiting
        // for — with a message about a broken EventTarget. The leak this method
        // exists to fix is a slow one; losing the error to fix it fast is a bad
        // trade. A source that adds but throws on removal is broken anyway, and
        // the next attempt's `detach` will simply try again.
      }
    }
  };
  return { signal: controller.signal, detach };
};

export default PowerDeadline;
