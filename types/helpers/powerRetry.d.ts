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
     * Execute a function with retry/backoff semantics.
     * @param {Function} fn Async function to execute.
     * @param {PowerRetryOptions} [options] Retry behavior overrides for this invocation.
     * @returns {Promise<any>} Resolves with `fn` result, rejects with final attempt error.
     * @throws {TypeError} When `fn` is not callable or `maxAttempts` is not a positive finite number.
     */
    static run(fn: Function, options?: PowerRetryOptions): Promise<any>;
    /**
     * Run a function with retry/backoff semantics.
     * Create a configured retry helper.
     * @param {PowerRetryOptions} [options] Default options applied to every `run()` invocation.
     */
    constructor(options?: PowerRetryOptions);
    _options: import("./jsdoc-types.js").PowerRetryOptions;
    /**
     * Instance method that runs `fn` with the configured options merged with
     * any per-call `options` provided.
     * @param {Function} fn Async function to execute.
     * @param {PowerRetryOptions} [options] Per-call retry overrides.
     * @returns {Promise<any>} Resolves with `fn` result, rejects with final attempt error.
     */
    run(fn: Function, options?: PowerRetryOptions): Promise<any>;
}
export default PowerRetry;
export type PowerRetryOptions = import("./jsdoc-types.js").PowerRetryOptions;
