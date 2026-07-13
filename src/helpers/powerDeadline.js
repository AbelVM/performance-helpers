import { PowerRetry } from './powerRetry.js';
import { nowMs } from '../utils/now.js';

/**
 * @typedef {import('./jsdoc-types.js').PowerDeadlineOptions} PowerDeadlineOptions
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

    const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
    const perAttemptTimeout = Number(attemptTimeout) > 0 ? Number(attemptTimeout) : null;
    const deadlineMs = Number(totalTimeout) > 0 ? Number(totalTimeout) : null;
    const delayMs = Math.max(0, Number(retryDelay) || 0);
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

    const wrapAttempt = async (attempt, retrySignal) => {
      const attemptStarted = nowMs();
      if (deadlineAt !== null && attemptStarted >= deadlineAt) {
        const err = new Error('Deadline exceeded');
        err.code = 'EDEADLINE';
        err.attempts = attempt;
        err.elapsedMs = nowMs() - startedAt;
        throw err;
      }

      // Signal handed to the user's fn: aborts on external abort and/or on the
      // per-attempt timeout signal provided by PowerRetry, so callers can stop
      // in-flight work instead of leaving it running after a timeout fires.
      const userSignal = combineSignals(
        signal,
        combineSignals(retrySignal, deadlineController ? deadlineController.signal : null)
      );
      const abortPromise = createAbortPromise();
      const candidates = [Promise.resolve().then(() => fn(userSignal))];
      const cleanups = [];

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
            const err = new Error('Deadline exceeded');
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
          err.attempts = attempt;
          err.attemptTimeout = perAttemptTimeout;
          err.totalTimeout = deadlineMs;
        }
        throw err;
      } finally {
        for (const cleanup of cleanups) {
          if (typeof cleanup === 'function') cleanup();
        }
      }
    };

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
   * @param {Object} [options] Default options applied to every `run()` invocation.
   */
  constructor(options = {}) {
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

const createAbortError = (reason, startedAt, deadlineMs) => {
  const err = new Error('Aborted');
  err.code = 'EABORT';
  err.reason = reason;
  err.attempts = 0;
  err.elapsedMs = nowMs() - startedAt;
  err.totalTimeout = deadlineMs;
  return err;
};

/**
 * Combine zero, one, or two AbortSignals into a single signal for the user fn.
 * The returned signal aborts if any of the provided signals abort. Returns
 * `undefined` when no signals are supplied (so `fn` is called without one).
 * @param {AbortSignal} [external]
 * @param {AbortSignal} [retry]
 * @returns {AbortSignal|undefined}
 */
const combineSignals = (external, retry) => {
  if (!external && !retry) return undefined;
  if (!external) return retry;
  if (!retry) return external;
  if (typeof AbortController === 'undefined') return external;
  const controller = new AbortController();
  const onAbort = () => {
    try {
      controller.abort();
    } catch (e) {
      /* ignore */
    }
  };
  if (typeof external.addEventListener === 'function') {
    external.addEventListener('abort', onAbort, { once: true });
  }
  if (typeof retry.addEventListener === 'function') {
    retry.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
};

export default PowerDeadline;
