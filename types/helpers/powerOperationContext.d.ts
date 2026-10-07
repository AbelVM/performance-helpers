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
