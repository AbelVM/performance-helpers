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
     * @typedef {Object} PowerBatchOptions
     * @property {number} [maxSize]
     */
    /**
     * @param {Function} handler - Function called with an array of collected items.
     * @param {Object} [options]
     * @param {number} [options.maxSize=Infinity] - When reached, flush immediately.
     * @param {'microtask'|'macrotask'} [options.scheduling='microtask'] - How the batch is scheduled.
     */
    constructor(handler: Function, options?: {
        maxSize?: number | undefined;
        scheduling?: "microtask" | "macrotask" | undefined;
    });
    _handler: Function;
    _maxSize: number;
    _queue: PowerQueue;
    _pending: {
        promise: Promise<any>;
        resolve: undefined;
        reject: undefined;
    } | {
        promise: Promise<any>;
        resolve: undefined;
        reject: undefined;
    } | null;
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
}
export default PowerBatch;
import { PowerQueue } from './powerQueue.js';
import { PowerScheduler } from './powerScheduler.js';
