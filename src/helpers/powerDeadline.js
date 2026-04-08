import { PowerRetry } from './powerRetry.js';

/**
 * @typedef {Object} PowerDeadlineOptions
 * @property {number} [maxAttempts] Maximum attempts (including the initial try).
 * @property {number} [attemptTimeout] Timeout in milliseconds for each attempt.
 * @property {number} [totalTimeout] Total deadline in milliseconds for the entire run.
 * @property {number} [retryDelay] Delay in milliseconds before retrying.
 * @property {(err:any)=>boolean} [retryIf] Predicate to determine whether to retry after an error.
 * @property {AbortSignal} [signal] Optional abort signal to cancel the operation.
 * @property {(attempt:number, err:any, delay:number)=>void} [onRetry] Callback invoked before a retry delay.
 */

/**
 * Deadline-aware async helper for timeout, retry budget, and abort metadata.
 *
 * Use `PowerDeadline` to wrap async work with per-attempt timeouts, a total
 * deadline for the whole operation, and optional retry/backoff behavior.
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

    const startedAt = Date.now();
    const deadlineAt = deadlineMs !== null ? startedAt + deadlineMs : null;

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

    const wrapAttempt = async (attempt) => {
      const attemptStarted = Date.now();
      if (deadlineAt !== null && attemptStarted >= deadlineAt) {
        const err = new Error('Deadline exceeded');
        err.code = 'EDEADLINE';
        err.attempts = attempt;
        err.elapsedMs = Date.now() - startedAt;
        throw err;
      }

      const abortPromise = createAbortPromise();
      const candidates = [Promise.resolve().then(() => fn())];
      const cleanups = [];

      if (deadlineAt !== null) {
        const remaining = deadlineAt - Date.now();
        let clearTotalTimeout;
        const p = new Promise((_, reject) => {
          const timer = setTimeout(() => {
            const err = new Error('Deadline exceeded');
            err.code = 'EDEADLINE';
            err.attempts = attempt;
            err.elapsedMs = Date.now() - startedAt;
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
    const attemptFn = async () => {
      attemptCounter += 1;
      return wrapAttempt(attemptCounter);
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
  err.elapsedMs = Date.now() - startedAt;
  err.totalTimeout = deadlineMs;
  return err;
};

export default PowerDeadline;
