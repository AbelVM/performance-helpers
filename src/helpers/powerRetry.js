/**
 * @typedef {import('./jsdoc-types.js').PowerRetryOptions} PowerRetryOptions
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
   * @param {Function} fn Async function to execute.
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
      try {
        const attemptPromise = (async () => fn())();
        if (typeof attemptTimeout === 'number' && attemptTimeout > 0) {
          let timer;
          try {
            return await Promise.race([
              attemptPromise,
              new Promise((_, rej) => {
                timer = setTimeout(() => {
                  const err = new Error('Attempt timed out');
                  err.code = 'ETIMEOUT';
                  err.attempts = attempt;
                  err.attemptTimeout = attemptTimeout;
                  rej(err);
                }, attemptTimeout);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
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
   * @param {Function} fn Async function to execute.
   * @param {PowerRetryOptions} [options] Per-call retry overrides.
   * @returns {Promise<any>} Resolves with `fn` result, rejects with final attempt error.
   */
  async run(fn, options = {}) {
    const merged = Object.assign({}, this._options || {}, options || {});
    return this.constructor.run(fn, merged);
  }
}

export default PowerRetry;
