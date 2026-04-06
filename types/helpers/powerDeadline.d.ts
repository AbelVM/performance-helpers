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
    static run(fn: Function, options?: PowerDeadlineOptions): Promise<any>;
    /**
     * Create a configured `PowerDeadline` instance.
     * @param {Object} [options] Default options applied to every `run()` invocation.
     */
    constructor(options?: Object);
    _options: Object;
    /**
     * Run a function with the configured deadline options merged with per-call options.
     * @param {Function} fn Async function to execute.
     * @param {PowerDeadlineOptions} [options]
     * @returns {Promise<any>}
     */
    run(fn: Function, options?: PowerDeadlineOptions): Promise<any>;
}
export default PowerDeadline;
export type PowerDeadlineOptions = {
    /**
     * Maximum attempts (including the initial try).
     */
    maxAttempts?: number | undefined;
    /**
     * Timeout in milliseconds for each attempt.
     */
    attemptTimeout?: number | undefined;
    /**
     * Total deadline in milliseconds for the entire run.
     */
    totalTimeout?: number | undefined;
    /**
     * Delay in milliseconds before retrying.
     */
    retryDelay?: number | undefined;
    /**
     * Predicate to determine whether to retry after an error.
     */
    retryIf?: ((err: any) => boolean) | undefined;
    /**
     * Optional abort signal to cancel the operation.
     */
    signal?: AbortSignal | undefined;
    /**
     * Callback invoked before a retry delay.
     */
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
};
