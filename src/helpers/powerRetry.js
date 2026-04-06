/**
 * Retry helper with configurable backoff and jitter.
 *
 * @param {Function} fn - Async function to execute on each attempt.
 * @param {Object} [options]
 * @param {number} [options.maxAttempts=3] - Maximum attempts (initial try + retries).
 * @param {'exponential'|'linear'|'fixed'} [options.backoff='exponential']
 * @param {number} [options.baseDelay=100] - Base delay in ms for backoff.
 * @param {number} [options.maxDelay=10000] - Max delay in ms.
 * @param {boolean} [options.jitter=true] - Add jitter to delays.
 * @param {Function} [options.retryIf] - Predicate `(err) => boolean` to decide whether to retry. Defaults to always true.
 * @param {Function} [options.onRetry] - Optional callback `(attempt, err, delay) => void` called before next retry.
 * @param {number} [options.attemptTimeout] - Per-attempt timeout in milliseconds. If set, an attempt that
 *   does not finish within this time will be rejected and counted as a failed attempt.
 * @returns {Promise<any>} Resolves or rejects with the underlying function result/error.
 *
 * @example
 * await PowerRetry(() => fetch('/api'), { maxAttempts: 4 });
 */
/**
 * @typedef {Object} PowerRetryOptions
 * @property {number} [maxAttempts]
 * @property {'exponential'|'linear'|'fixed'} [backoff]
 * @property {number} [baseDelay]
 * @property {number} [maxDelay]
 * @property {boolean} [jitter]
 * @property {(err:any)=>boolean} [retryIf]
 * @property {(attempt:number, err:any, delay:number)=>void} [onRetry]
 * @property {number} [attemptTimeout]
 */
export class PowerRetry {
  /**
   * Run a function with retry/backoff semantics.
   * @param {Function} fn
   * @param {Object} options
   */
  /**
   * Create a configured retry helper.
   * @param {Object} options Default options applied to every `run()` invocation.
   */
  constructor(options = {}) {
    this._options = options || {};
  }
  static async run(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const {
      maxAttempts = 3,
      backoff = 'exponential',
      baseDelay = 100,
      maxDelay = 10000,
      jitter = true,
      attemptTimeout,
      retryIf = () => true,
      onRetry,
    } = options;

    const attempts = Number(maxAttempts) || 1;

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
                timer = setTimeout(() => rej(new Error('Attempt timed out')), attemptTimeout);
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
   * @param {Function} fn
   * @param {Object} [options]
   */
  async run(fn, options = {}) {
    const merged = Object.assign({}, this._options || {}, options || {});
    return this.constructor.run(fn, merged);
  }
}

export default PowerRetry;
