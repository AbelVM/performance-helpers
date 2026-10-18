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

// ---------------------------------------------------------------------------
// Async-local propagation (S-37). Optional: only available in runtimes that
// ship `node:async_hooks` (Node). In browsers or stripped environments the
// helpers degrade to a synchronous, non-propagating fallback so callers can
// still use them without feature-detecting.
// ---------------------------------------------------------------------------

/** @type {any} */
let _als = null;
let _alsProbed = false;
function _getAls() {
  if (_alsProbed) return _als;
  _alsProbed = true;
  try {
    /** @type {any} */
    const mod = globalThis.process?.getBuiltinModule?.('node:async_hooks');
    if (mod && typeof mod.AsyncLocalStorage === 'function') {
      _als = new mod.AsyncLocalStorage();
    }
  } catch (e) {
    _als = null;
  }
  // ESM/browser path: try a global if present.
  if (
    !_als &&
    typeof globalThis !== 'undefined' &&
    /** @type {any} */ (globalThis).AsyncLocalStorage
  ) {
    try {
      _als = new /** @type {any} */ (globalThis).AsyncLocalStorage();
    } catch (e) {
      _als = null;
    }
  }
  return _als;
}

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
export function runOperationContext(context, fn) {
  if (typeof fn !== 'function') throw new TypeError('runOperationContext requires a function');
  const als = _getAls();
  if (als) return als.run(context, fn);
  return fn();
}

/**
 * Read the operation context bound to the current async execution, if any.
 *
 * @returns {*} The current context, or `undefined` when none is bound (or when
 *   `AsyncLocalStorage` is unavailable).
 */
export function getOperationContext() {
  const als = _getAls();
  if (!als) return undefined;
  return als.getStore();
}

/**
 * Convenience: create an operation context from `options` and run `fn` within it.
 *
 * @param {Object} options - Forwarded to `createOperationContext`.
 * @param {() => any} fn - The function to run.
 * @returns {any} The return value of `fn`.
 */
export function withOperationContext(options, fn) {
  const ctx = createOperationContext(options || {});
  return runOperationContext(ctx, fn);
}
