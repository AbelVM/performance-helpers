/**
 * PowerBatch
 *
 * Scheduler-driven batching helper that collects items and dispatches them
 * to a provided handler on a microtask/macrotask boundary.
 *
 * @class PowerBatch
 * @public
 */
export class PowerBatch {
    /**
     * @typedef {import('./jsdoc-types.js').PowerBatchOptions} PowerBatchOptions
     * @typedef {import('./jsdoc-types.js').BatchPending} BatchPending
     */
    /**
     * @param {(items:any[])=>Promise<void>|void} handler - Called with the whole
     *   collected array each time the batch flushes. A rejection rejects every
     *   promise handed out by `add()`/`flush()` in that batch.
     * @param {PowerBatchOptions} [options] - `maxSize` defaults to unbounded and
     *   `scheduling` to `'microtask'`.
     */
    constructor(handler: (items: any[]) => Promise<void> | void, options?: import("./jsdoc-types.js").PowerBatchOptions);
    /** @type {?BatchPending} */
    /**
     * Add an item to the current batch. Returns a Promise that resolves
     * when the batch containing this item has been processed. For non-flushed
     * additions this will be resolved after the scheduled run; if adding the
     * item hits `maxSize` the returned promise resolves when the handler completes.
     * @param {any} item
     * @returns {Promise<void>}
     */
    add(item: any): Promise<void>;
    /**
     * Force flush the current queue immediately and return a promise
     * that resolves or rejects with the handler outcome.
     * If the queue is empty and nothing is scheduled, the returned promise
     * resolves immediately.
     * @param {{signal?: AbortSignal}} [options] `signal` abandons this caller's
     *   *wait* for the flush, not the flush itself — queued items still belong to
     *   the callers who passed them to `add()`, so the shared pending promise is
     *   deliberately left to settle.
     * @returns {Promise<void>}
     */
    flush(options?: {
        signal?: AbortSignal;
    }): Promise<void>;
    /**
     * The pending entry for the batch being assembled, created on first use.
     *
     * Extracted because `add()` and `flush()` both needed it, and duplicating the
     * `let resolve, reject` dance meant the uninitialised `undefined` was
     * assignable to the handles at one site and not the other.
     *
     * @returns {BatchPending}
     */
    _ensurePending(): import("./jsdoc-types.js").BatchPending;
    /**
     * Internal: run the queued batch and call the handler.
     * @private
     */
    /**
     * Number of items currently queued (not yet flushed).
     * @returns {number}
     */
    get size(): number;
    /**
     * Clear queued items without invoking handler.
     * Any pending promise for the current batch is rejected.
     * @returns {void}
     */
    /**
     * Alias for {@link PowerBatch#clear}.
     *
     * `clear()` here empties the container, and "reset" is a natural second word
     * for exactly that - so a caller who reaches for `reset()` on this class gets
     * the obvious thing instead of a `TypeError`. No limiter gets this alias: for
     * `PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
     * would read as the opposite, and the two are deliberately not synonyms.
     *
     * @returns {void}
     */
    reset(): void;
    clear(): void;
    /**
     * Release every resource this instance holds.
     *
     * Idempotent, and safe to call while the instance is idle. Exists so the
     * instance works with `using` / `await using` and gives callers an explicit
     * name to call.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using x = new X()` releases the instance
     * deterministically at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerBatch;
import { PowerQueue } from './powerQueue.js';
import { PowerScheduler } from './powerScheduler.js';
