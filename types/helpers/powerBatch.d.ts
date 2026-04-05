/**
 * PowerBatch — microtask-coalescing dispatcher.
 * Collects items added within the same microtask and dispatches them
 * to the provided `handler(items[])`. Useful to batch synchronous
 * work (DB writes, network calls) with minimal latency.
 *
 * @example
 * const batch = new PowerBatch((items) => bulkWrite(items), { maxSize: 100 });
 * batch.add(itemA);
 * batch.add(itemB);
 * // items are coalesced and handler called once in the next microtask
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
     */
    constructor(handler: Function, options?: {
        maxSize?: number | undefined;
    });
    _handler: Function;
    _maxSize: number;
    _queue: any[];
    _scheduled: boolean;
    _pending: {
        promise: Promise<any>;
        resolve: undefined;
        reject: undefined;
    } | null;
    /**
     * Add an item to the current batch. Returns a Promise that resolves
     * when the batch containing this item has been processed. For non-flushed
     * additions this will be resolved after the microtask run; if adding the
     * item hits `maxSize` the returned promise resolves when the handler completes.
     * @param {any} item
     * @returns {Promise<void>}
     */
    add(item: any): Promise<void>;
    /**
     * Force flush the current queue immediately and return a promise
     * that resolves or rejects with the handler outcome.
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
     * @returns {void}
     */
    clear(): void;
}
export default PowerBatch;
