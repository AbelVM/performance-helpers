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
 */
export function PowerRetry(fn: any, options?: {}): Promise<any>;
export default PowerRetry;
export type PowerRetryOptions = {
    maxAttempts?: number | undefined;
    backoff?: "exponential" | "linear" | "fixed" | undefined;
    baseDelay?: number | undefined;
    maxDelay?: number | undefined;
    jitter?: boolean | undefined;
    retryIf?: ((err: any) => boolean) | undefined;
    onRetry?: ((attempt: number, err: any, delay: number) => void) | undefined;
};
