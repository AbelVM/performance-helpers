/**
 * @typedef {Object} PowerRetryOptions
 * @property {number} [maxAttempts=3] Maximum attempts (initial try + retries). Must be a positive finite number.
 * @property {'exponential'|'linear'|'fixed'} [backoff='exponential'] Delay strategy between attempts.
 * @property {number} [baseDelay=100] Base delay in milliseconds.
 * @property {number} [maxDelay=10000] Maximum delay in milliseconds.
 * @property {boolean} [jitter=true] Adds jitter to delay calculations.
 * @property {(err:any)=>boolean} [retryIf]
 * @property {(attempt:number, err:any, delay:number)=>void} [onRetry]
 * @property {number} [attemptTimeout] Per-attempt timeout in milliseconds.
 */
/**
 * Retry helper with configurable backoff and jitter.
 *
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
    _options: PowerRetryOptions;
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
export type PowerRetryOptions = {
    /**
     * Maximum attempts (initial try + retries). Must be a positive finite number.
     */
    maxAttempts?: number | undefined;
    /**
     * Delay strategy between attempts.
     */
    backoff?: "exponential" | "linear" | "fixed" | undefined;
    /**
     * Base delay in milliseconds.
     */
    baseDelay?: number | undefined;
    /**
     * Maximum delay in milliseconds.
     */
    maxDelay?: number | undefined;
    /**
     * Adds jitter to delay calculations.
     */
    jitter?: boolean | undefined;
    retryIf?: ((err: any) => boolean) | undefined;
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
    /**
     * Per-attempt timeout in milliseconds.
     */
    attemptTimeout?: number | undefined;
};
