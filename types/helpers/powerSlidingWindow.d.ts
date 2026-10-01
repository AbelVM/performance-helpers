export class PowerSlidingWindow {
    /**
     * @param {PowerSlidingWindowOptions} [options] - `capacity` defaults to 1
     *   and `windowMs` to one second.
     */
    constructor(options?: PowerSlidingWindowOptions);
    capacity: number;
    windowMs: number;
    /**
     * Clock for this limiter, and whether it was explicitly injected. See
     * `resolveLimiterNow` for why the flag is load-bearing: an injected clock
     * must outrank a value threaded in by a composition.
     * @type {(() => number)}
     */
    _now: (() => number);
    /** @type {boolean} */
    _nowExplicit: boolean;
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
     * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options] Per-call
     *   clock override.
     * @returns {boolean} True if consumption succeeded; false otherwise.
     */
    tryConsume(n?: number, options?: import("../utils/limiterClock.js").LimiterNowOptions): boolean;
    /**
     * Return how many slots are currently available.
     * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options] Per-call
     *   clock override.
     * @returns {number}
     */
    available(options?: import("../utils/limiterClock.js").LimiterNowOptions): number;
    /**
     * Drop every recorded timestamp, returning the window to fully available.
     * @returns {void}
     */
    reset(): void;
    /**
     * Alias for {@link PowerSlidingWindow#reset}.
     *
     * This one is a true synonym and not a uniformity gesture: `reset()` here
     * *is* a clear - it empties the timestamp queue. Contrast the limiters, where
     * `reset()` restores a usable state (refilled tokens, re-closed circuit) and
     * `clear()` would read as the exact opposite.
     *
     * @returns {void}
     */
    clear(): void;
    /**
     * Release every resource this instance holds.
     *
     * The window holds a `PowerQueue` of timestamps and a clock reference. Neither
     * is a timer or a subscription, so this clears the recorded history and
     * re-seeds the clock rather than cancelling anything — a half-elapsed window
     * is dropped rather than left to keep admitting what it had already counted.
     *
     * Present so this helper can take part in `using` / `await using` and DI
     * teardown like every other long-lived helper in the library.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using x = new PowerSlidingWindow(…)` releases
     * it deterministically at scope exit.
     *
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export type PowerSlidingWindowOptions = import("./jsdoc-types.js").PowerSlidingWindowOptions;
import { PowerQueue } from './powerQueue.js';
