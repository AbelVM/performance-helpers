export class PowerSlidingWindow {
    /**
     * @param {Object} [options]
     * @param {number} [options.capacity=1] Max events allowed in window.
     * @param {number} [options.windowMs=1000] Window size in milliseconds.
     */
    constructor(options?: {
        capacity?: number | undefined;
        windowMs?: number | undefined;
    });
    capacity: number;
    windowMs: number;
    _timestamps: any[];
    /**
     * Remove timestamps older than now - windowMs.
     *
     * This helper removes stale timestamps from the internal array to keep the
     * sliding window accurate. It advances the head by counting how many
     * timestamps are older than the threshold and splices them out in a single
     * operation to minimize per-call allocations.
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
