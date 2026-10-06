/**
 * PowerQueue
 *
 * Lightweight resizable ring-buffer queue with O(1) enqueue/dequeue.
 * Designed as a small, dependency-free helper for high-throughput queues.
 *
 * @class PowerQueue
 * @public
 * @example
 * const q = new PowerQueue(8);
 * q.push(1);
 * q.push(2);
 * q.shift(); // 1
 */
export class PowerQueue {
    /**
     * @typedef {import('./jsdoc-types.js').PowerQueueOptions} PowerQueueOptions
     */
    /**
     * Create a PowerQueue.
     * @param {number} [initialCapacity=16] Initial capacity (rounded up to power-of-two).
     */
    constructor(initialCapacity?: number);
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
    /**
     * Alias for {@link PowerQueue#clear}.
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
     * Release memory held by a burst, by reallocating the buffer smaller.
     *
     * The buffer only ever grows: `_grow()` doubles it and nothing halves it, so a
     * queue that took 5 000 items once keeps an 8 192-slot buffer for the rest of
     * its life. `clear()` empties the slots but does not release them, and that is
     * the right behaviour for a container whose purpose is bounding memory.
     * Measured: 5 000 pushes, then drained or cleared, leaves `capacity` at 8 192
     * with `length` 0.
     *
     * **Explicit rather than automatic, and the reason is the hot path.** The
     * obvious alternative is to shrink inside `shift()` whenever
     * `size < capacity / 2`, which costs a comparison and a branch on every
     * dequeue forever to reclaim memory only after a burst. A caller that has just
     * finished a burst knows when to pay; the dequeue path does not.
     *
     * `minimum` is the capacity to keep — a floor for a queue that is expected to
     * refill to a known size, so a burst followed by steady traffic does not
     * reallocate on every cycle. It is rounded **up** to a power of two like the
     * constructor, and never below 2, which is the same floor the constructor
     * applies. Passing anything smaller than the current length is a no-op: the
     * buffer cannot hold what is in it.
     *
     * @param {number} [minimum=POWER_QUEUE_INITIAL_CAPACITY] Capacity to keep.
     * @returns {number} The capacity after the call.
     */
    shrink(minimum?: number): number;
    /**
     * Enqueue `count` copies of `item` without building an intermediate array.
     *
     * Exists for the one caller that wanted it: filling a window with `n` equal
     * timestamps used to be `new Array(n)`, a loop to populate the holes, and then
     * `pushMany` to walk the result — a temporary allocation and a second pass on
     * a path that runs per `tryConsume(n)` with `n > 1`.
     *
     * @param {any} item The value to enqueue `count` times.
     * @param {number} count How many copies.
     * @returns {number} New queue length after the pushes.
     */
    fill(item: any, count?: number): number;
    /**
     * Internal buffer capacity (always a power-of-two).
     * @returns {number}
     */
    get capacity(): number;
    /**
     * Whether the queue is empty.
     * @returns {boolean}
     */
    get isEmpty(): boolean;
    /**
     * Return an iterator of values (alias of the default iterator).
     * @returns {Iterator<any>}
     */
    values(): Iterator<any>;
    /**
     * Return an iterator of keys (zero-based indexes from the head).
     * @returns {Iterator<number>}
     */
    keys(): Iterator<number>;
    /**
     * Non-destructive entries iterator that yields [index, value] pairs where
     * index is the zero-based position in the queue (0 is the head).
     * @returns {Iterator<[number, any]>}
     */
    entries(): Iterator<[number, any]>;
    /**
     * Consuming drain iterator: yields items in FIFO order and removes them
     * from the queue as they are iterated.
     * Useful for streaming/processing and emptying the queue without manual loops.
     * @returns {IterableIterator<any>}
     */
    drain(): IterableIterator<any>;
    /**
     * Return a shallow array snapshot of the queue contents in FIFO order.
     * This is a convenience helper that does not consume the queue.
     * @returns {Array<any>}
     */
    toArray(): Array<any>;
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
    /**
     * Enqueue multiple items in one call. Optimized to resize buffer once and
     * copy items in contiguous blocks when possible.
     * @param {Array<any>} items
     * @returns {number} New queue length after all pushes.
     */
    pushMany(items: Array<any>): number;
    /**
     * Number of items currently queued.
     * @returns {number}
     */
    get length(): number;
    /**
     * Sum of `weight` across all queued items, where each item's weight is its
     * numeric `weight` property or `1` when absent. With weight-less items this
     * is identical to `length`, which is what keeps the default path at zero extra
     * cost in reasoning.
     * @returns {number}
     */
    get totalWeight(): number;
    /**
     * Remove the item at logical index `index` (0 = head) and shift subsequent
     * items forward to fill the gap. Returns the removed item, or `undefined` if
     * the index is out of range.
     *
     * This is O(n) in the number of items after the removed index, which is the
     * same cost as `shift()` when the head is removed and acceptable for the
     * bounded queues this helper is designed for.
     *
     * @param {number} index - Logical index from the head (0-based).
     * @returns {any|undefined}
     */
    removeAt(index: number): any | undefined;
    /**
     * Remove and return the item with the highest priority according to
     * `priorityFn`. When multiple items share the same priority, the one closest
     * to the head (lowest logical index) is returned, preserving FIFO order among
     * equal-priority items.
     *
     * Returns `undefined` when the queue is empty.
     *
     * @param {(item: any) => number} priorityFn - Function that returns a numeric
     *   priority for an item. Higher numbers win.
     * @returns {any|undefined}
     */
    shiftHighestPriority(priorityFn: (item: any) => number): any | undefined;
    /**
     * Prepend multiple items to the head of the queue.
     * The first element of `items` will become the next value returned by `shift()`.
     * @param {Array<any>} items
     * @returns {number} New queue length after all unshifts.
     */
    unshiftMany(items: Array<any>): number;
    /**
     * Iterator (non-destructive) yielding items in FIFO order.
     * Allows `for...of` and spread (`[...queue]`) without consuming the queue.
     * @returns {Iterator<any>}
     */
    [Symbol.iterator](): Iterator<any>;
}
