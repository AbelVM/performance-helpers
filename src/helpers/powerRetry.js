/**
 * @typedef {import('./jsdoc-types.js').PowerRetryOptions} PowerRetryOptions
 * @typedef {import('./jsdoc-types.js').RetryTimeoutError} RetryTimeoutError
 */

import { DEFAULT_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_MAX_DELAY_MS } from './constants.js';

/**
 * Retry helper with configurable backoff and jitter.
 *
 * @class PowerRetry
 * @example
 * const retry = new PowerRetry({ maxAttempts: 4, baseDelay: 50 });
 * const data = await retry.run(() => fetch('/api/data'));
 */
export class PowerRetry {
  /**
   * Run a function with retry/backoff semantics.
   * Create a configured retry helper.
   * @param {PowerRetryOptions} [options] Default options applied to every `run()` invocation.
   */
  constructor(options = {}) {
    this._options = options || {};
  }

  /**
   * Execute a function with retry/backoff semantics.
   * @param {((signal?: AbortSignal) => Promise<any>|any)} fn Function to execute.
   *   It receives the `AbortSignal` for the attempt when `attemptTimeout` is
   *   set, and `undefined` otherwise.
   * @param {PowerRetryOptions} [options] Retry behavior overrides for this invocation.
   * @returns {Promise<any>} Resolves with `fn` result, rejects with final attempt error.
   * @throws {TypeError} When `fn` is not callable or `maxAttempts` is not a positive finite number.
   */
  static async run(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const {
      maxAttempts = 3,
      backoff = 'exponential',
      baseDelay = DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelay = DEFAULT_RETRY_MAX_DELAY_MS,
      jitter = true,
      attemptTimeout,
      retryIf = () => true,
      onRetry,
    } = options;

    const parsedAttempts = Number(maxAttempts);
    if (!Number.isFinite(parsedAttempts) || parsedAttempts <= 0) {
      throw new TypeError('maxAttempts must be a positive finite number');
    }
    const attempts = Math.floor(parsedAttempts);

    /**
     * Delay before attempt `attempt + 1`, capped at `maxDelay` and halved-to-
     * full by `jitter`.
     *
     * @param {number} attempt - 1-based number of the attempt that just failed.
     * @returns {number} Milliseconds to wait.
     */
    const calcDelay = (attempt) => {
      let d;
      if (backoff === 'linear') d = baseDelay * attempt;
      else if (backoff === 'fixed') d = baseDelay;
      else d = baseDelay * Math.pow(2, attempt - 1); // exponential
      if (d > maxDelay) d = maxDelay;
      if (jitter) d = Math.round(d * (0.5 + Math.random() * 0.5));
      return d;
    };

    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // When a per-attempt timeout is configured, create an AbortController and
      // hand its signal to `fn` so callers can stop in-flight work on timeout
      // (mirrors the `fetch(url, { signal })` contract). The signal is aborted
      // only if the attempt actually times out; successful attempts leave it
      // untouched so `fn` can finish cleanly.
      /** @type {?AbortController} */
      let controller = null;
      /** @type {AbortSignal|undefined} */
      let signal = undefined;
      // Captured with the controller rather than read back from
      // `attemptTimeout` further down: it is narrowed to `number` here, and
      // that narrowing does not survive into the timer callback.
      let timeoutMs = 0;
      if (
        typeof attemptTimeout === 'number' &&
        attemptTimeout > 0 &&
        typeof AbortController !== 'undefined'
      ) {
        controller = new AbortController();
        signal = controller.signal;
        timeoutMs = attemptTimeout;
      }
      try {
        const attemptPromise = (async () => fn(signal))();
        if (controller) {
          /** @type {?(ReturnType<typeof setTimeout>)} */
          let timer = null;
          let timedOut = false;
          try {
            return await Promise.race([
              attemptPromise,
              new Promise((_, rej) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  const err = Object.assign(new Error('Attempt timed out'), {
                    code: /** @type {const} */ ('ETIMEOUT'),
                    attempts: attempt,
                    attemptTimeout: timeoutMs,
                  });
                  rej(err);
                }, timeoutMs);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            if (timedOut && controller) {
              try {
                controller.abort();
              } catch (e) {
                /* ignore abort errors */
              }
            }
          }
        }
        return await attemptPromise;
      } catch (err) {
        lastErr = err;
        const should = typeof retryIf === 'function' ? retryIf(err) : Boolean(retryIf);
        if (!should || attempt === attempts) break;
        const delay = calcDelay(attempt);
        try {
          if (typeof onRetry === 'function') onRetry(attempt, err, delay);
        } catch (e) {
          // swallow errors from onRetry
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /**
   * Instance method that runs `fn` with the configured options merged with
   * any per-call `options` provided.
   * @param {((signal?: AbortSignal) => Promise<any>|any)} fn Function to execute.
   * @param {PowerRetryOptions} [options] Per-call retry overrides.
   * @returns {Promise<any>} Resolves with `fn` result, rejects with final attempt error.
   */
  async run(fn, options = {}) {
    const merged = Object.assign({}, this._options || {}, options || {});
    // `this.constructor` is typed `Function`, which has no `run`. The subclass
    // shape is fixed - nothing in the package or its tests subclasses
    // PowerRetry, and both `run`s are on this class - so the annotation records
    // that invariant instead of casting the call's result.
    const ctor = /** @type {typeof PowerRetry} */ (this.constructor);
    return ctor.run(fn, merged);
  }
}

export default PowerRetry;
