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
    static run(fn: any, options?: {}): Promise<any>;
    /**
     * Run a function with retry/backoff semantics.
     * @param {Function} fn
     * @param {Object} options
     */
    /**
     * Create a configured retry helper.
     * @param {Object} options Default options applied to every `run()` invocation.
     */
    constructor(options?: Object);
    _options: Object;
    /**
     * Instance method that runs `fn` with the configured options merged with
     * any per-call `options` provided.
     * @param {Function} fn
     * @param {Object} [options]
     */
    run(fn: Function, options?: Object): Promise<any>;
}
export default PowerRetry;
export type PowerRetryOptions = {
    maxAttempts?: number | undefined;
    backoff?: "exponential" | "linear" | "fixed" | undefined;
    baseDelay?: number | undefined;
    maxDelay?: number | undefined;
    jitter?: boolean | undefined;
    retryIf?: ((err: any) => boolean) | undefined;
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
    attemptTimeout?: number | undefined;
};
