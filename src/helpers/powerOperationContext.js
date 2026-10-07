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
export function createOperationContext(options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('operation context options must be an object');
  }
  const { signal, deadlineAt, deadlineMs, retryBudget, correlationId, priority = 0 } = options;
  if (signal !== undefined && (signal === null || typeof signal !== 'object')) {
    throw new TypeError('operation context signal must be an AbortSignal');
  }
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt < 0)) {
    throw new RangeError('operation context deadlineAt must be finite and >= 0');
  }
  if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
    throw new RangeError('operation context deadlineMs must be finite and >= 0');
  }
  if (deadlineAt !== undefined && deadlineMs !== undefined) {
    throw new TypeError('operation context accepts deadlineAt or deadlineMs, not both');
  }
  if (correlationId !== undefined && typeof correlationId !== 'string') {
    throw new TypeError('operation context correlationId must be a string');
  }
  if (!Number.isFinite(priority)) throw new TypeError('operation context priority must be finite');
  /** @type {{priority:number, signal?:AbortSignal, deadlineAt?:number, retryBudget?:*, correlationId?:string}} */
  const context = { priority };
  if (signal !== undefined) context.signal = signal;
  if (deadlineAt !== undefined) context.deadlineAt = deadlineAt;
  if (deadlineMs !== undefined) context.deadlineAt = Date.now() + deadlineMs;
  if (retryBudget !== undefined) context.retryBudget = retryBudget;
  if (correlationId !== undefined) context.correlationId = correlationId;
  return Object.freeze(context);
}
