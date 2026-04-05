/**
 * Lightweight resizable ring-buffer queue with O(1) enqueue/dequeue.
 * Designed as a small, dependency-free helper for high-throughput queues.
 *
 * @example
 * const q = new PowerQueue(8);
 * q.push(1);
 * q.push(2);
 * q.shift(); // 1
 */
export class PowerQueue {
    /**
     * @typedef {Object} PowerQueueOptions
     * @property {number} [initialCapacity]
     */
    /**
     * Create a PowerQueue.
     * @param {number} [initialCapacity=16] Initial capacity (rounded up to power-of-two).
     */
    constructor(initialCapacity?: number);
    _capacity: number;
    _mask: number;
    _buffer: any[];
    _head: number;
    _tail: number;
    _size: number;
    /**
     * Enqueue an item at the tail.
     * @param {any} item Item to enqueue.
     * @returns {number} New queue length after push.
     */
    push(item: any): number;
    /**
     * Dequeue and return the head item.
     * @returns {any|undefined} The dequeued item or `undefined` when empty.
     */
    shift(): any | undefined;
    /**
     * Peek at the head item without removing it.
     * @returns {any|undefined} The head item or `undefined` when empty.
     */
    peek(): any | undefined;
    /**
     * Remove all items from the queue.
     * @returns {void}
     */
    clear(): void;
    get length(): number;
    get capacity(): number;
    get isEmpty(): boolean;
    /**
     * Internal: double internal buffer capacity and reindex elements.
     *
     * This private helper allocates a new backing array with double the
     * previous capacity, copies items in logical order starting from `this._head`,
     * and resets internal indices so the queue remains contiguous.
     *
     * @private
     * @returns {void}
     */
    private _grow;
    /**
     * Enqueue multiple items in one call. Optimized to resize buffer once and
     * copy items in contiguous blocks when possible.
     * @param {Array<any>} items
     * @returns {number} New queue length after all pushes.
     */
    pushMany(items: Array<any>): number;
    /**
     * Prepend multiple items to the head of the queue.
     * The first element of `items` will become the next value returned by `shift()`.
     * @param {Array<any>} items
     * @returns {number} New queue length after all unshifts.
     */
    unshiftMany(items: Array<any>): number;
}
