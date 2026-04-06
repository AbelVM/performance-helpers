export class PowerSlidingWindow {
    /**
     * @param {Object} [options]
     * @param {number} [options.capacity=1] Max events allowed in window.
     * @param {number} [options.windowMs=1000] Window size in milliseconds.
     */
    /**
     * @typedef {Object} PowerSlidingWindowOptions
     * @property {number} [capacity]
     * @property {number} [windowMs]
     */
    constructor(options?: {});
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
import { PowerQueue } from './powerQueue.js';
