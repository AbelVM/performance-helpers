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
    _handler: (items: any[]) => Promise<void> | void;
    _maxSize: number;
    _queue: PowerQueue;
    /** @type {?BatchPending} */
    _pending: import("./jsdoc-types.js").BatchPending | null;
    _scheduler: PowerScheduler;
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
     * @returns {Promise<void>}
     */
    flush(): Promise<void>;
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
    private _runBatch;
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
}
export default PowerBatch;
import { PowerQueue } from './powerQueue.js';
import { PowerScheduler } from './powerScheduler.js';
