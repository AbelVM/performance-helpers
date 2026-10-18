/**
 * Create explicit coordination data for one operation.
 *
 * The object is intentionally plain: helpers can consume the fields they
 * understand without importing a shared supervisor or context singleton.
 *
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.deadlineAt] Absolute deadline in milliseconds.
 * @param {number} [options.deadlineMs] Relative deadline from this call.
 * @param {Object} [options.retryBudget] Shared retry budget.
 * @param {string} [options.correlationId]
 * @param {number} [options.priority=0]
 * @returns {{signal?: AbortSignal, deadlineAt?: number, retryBudget?: Object, correlationId?: string, priority: number}}
 */
export function createOperationContext(options?: {
    signal?: AbortSignal | undefined;
    deadlineAt?: number | undefined;
    deadlineMs?: number | undefined;
    retryBudget?: Object | undefined;
    correlationId?: string | undefined;
    priority?: number | undefined;
}): {
    signal?: AbortSignal;
    deadlineAt?: number;
    retryBudget?: Object;
    correlationId?: string;
    priority: number;
};
/**
 * Run `fn` with `context` as the current operation context for the duration of
 * the (possibly async) call. Nested calls shadow the outer context.
 *
 * Falls back to running `fn` directly when `AsyncLocalStorage` is unavailable;
 * in that case `getOperationContext()` returns `undefined` outside the call.
 *
 * @param {*} context - An operation context (typically from `createOperationContext`).
 * @param {() => any} fn - The function to run. May be async.
 * @returns {any} The return value of `fn`.
 */
export function runOperationContext(context: any, fn: () => any): any;
/**
 * Read the operation context bound to the current async execution, if any.
 *
 * @returns {*} The current context, or `undefined` when none is bound (or when
 *   `AsyncLocalStorage` is unavailable).
 */
export function getOperationContext(): any;
/**
 * Convenience: create an operation context from `options` and run `fn` within it.
 *
 * @param {Object} options - Forwarded to `createOperationContext`.
 * @param {() => any} fn - The function to run.
 * @returns {any} The return value of `fn`.
 */
export function withOperationContext(options: Object, fn: () => any): any;
