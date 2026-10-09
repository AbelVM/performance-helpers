/**
 * PowerPriorityQueue
 *
 * Binary heap-based priority queue. Higher priority values are dequeued first.
 * When priorities are equal, FIFO order is preserved for stability.
 *
 * @class PowerPriorityQueue
 * @public
 */
export class PowerPriorityQueue {
    /**
     * @typedef {import('./jsdoc-types.js').PowerPriorityQueueOptions} PowerPriorityQueueOptions
     */
    /**
     * @param {number | {initialCapacity?: number}} [initialCapacity]
     */
    constructor(initialCapacity?: number | {
        initialCapacity?: number;
    });
    /**
     * @param {any} item
     */
    push(item: any): number;
    shift(): any;
    /**
     * Remove and return the item that would be delivered **last**.
     *
     * The mirror of `shift()`, and the reason it is here rather than in the
     * caller: a bounded priority queue has to evict something when it is full,
     * and evicting the *best* item — which is what a naive `shift()` in the
     * drop path does — throws away exactly the message the ordering existed to
     * protect. `PowerRealtimeHub`'s `drop-oldest` policy needs this under
     * `messagePriority`, and a caller maintaining their own bounded queue needs
     * it for the same reason.
     *
     * "Worst" is the exact inverse of `_isBetter`: lowest priority, and among
     * equal priorities the one inserted **most recently**, because that is the
     * one `shift()` would reach last. So `popLowest()` is a true mirror of
     * `shift()` — drain from both ends and you consume the queue in order from
     * each side.
     *
     * O(n) rather than O(log n), because finding the minimum of a max-heap is a
     * scan. That is the right trade for an eviction path, which runs only when
     * the queue is already full.
     *
     * @returns {any} The worst item, or `undefined` when empty.
     */
    popLowest(): any;
    peek(): any;
    clear(): void;
    reset(): void;
    get length(): number;
    get size(): number;
    isEmpty(): boolean;
    /** @param {any} candidate @param {any} current */ _isBetter(candidate: any, current: any): boolean;
    /**
     * Restore the heap property upwards from `i`.
     *
     * Extracted from `push()` because `popLowest()` moves an element from the
     * bottom of the heap into an arbitrary slot, and that element can belong
     * above its new parent. Two copies of this loop is two places for the
     * comparison to drift.
     * @param {number} i
     */
    _siftUp(i: number): void;
    /**
     * Restore the heap property downwards from `i`.
     * @param {number} i
     */
    _siftDown(i: number): void;
    /** @param {number} i @param {number} j */ _swap(i: number, j: number): void;
    _grow(): void;
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerPriorityQueue;
