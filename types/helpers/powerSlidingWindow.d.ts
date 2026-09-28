export class PowerSlidingWindow {
    /**
     * @param {PowerSlidingWindowOptions} [options] - `capacity` defaults to 1
     *   and `windowMs` to one second.
     */
    constructor(options?: PowerSlidingWindowOptions);
    capacity: number;
    windowMs: number;
    _timestamps: PowerQueue;
    /**
     * Remove timestamps older than now - windowMs.
     *
     * This helper removes stale timestamps from the internal ring-buffer queue
     * to keep the sliding window accurate. It advances the queue head one item
     * at a time using `PowerQueue.shift()`, which provides O(1) dequeue behavior
     * under sustained load.
     *
     * @private
     * @param {number} now - current timestamp in milliseconds
     * @returns {void}
     */
    private _prune;
    /**
     * Try to consume `n` slots (default 1).
     * @param {number} [n=1]
     * @returns {boolean} True if consumption succeeded; false otherwise.
     */
    tryConsume(n?: number): boolean;
    /**
     * Return how many slots are currently available.
     * @returns {number}
     */
    available(): number;
    /**
     * Reset internal state.
     * @returns {void}
     */
    reset(): void;
}
export type PowerSlidingWindowOptions = import("./jsdoc-types.js").PowerSlidingWindowOptions;
import { PowerQueue } from './powerQueue.js';
