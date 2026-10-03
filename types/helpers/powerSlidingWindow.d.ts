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
     *
     * **The ring buffer is deliberately *not* shrunk here**, even though `clear`
     * and `dispose` both shrink. The distinction is logical against physical:
     * `reset()` puts a live window back to empty, and it may be called on a hot
     * path (clearing a per-tenant window between requests), where reallocating
     * the ring on every call would be worse than holding it. `dispose()` is
     * teardown, where the caller has finished with the instance entirely and
     * anything still allocated is waste. Shrinking on reset would make the cheap
     * case expensive to fix the expensive one.
     *
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
     * is a timer or a subscription, so this clears the recorded history rather than
     * cancelling anything — a half-elapsed window is dropped rather than left to
     * keep admitting what it had already counted.
     *
     * Present so this helper can take part in `using` / `await using` and DI
     * teardown like every other long-lived helper in the library.
     *
     * **`clear()` then `shrink()`, and both matter.** `clear()` is O(1) where the
     * drain this used to do — `while (length > 0) shift()` — is O(n) in the number
     * of timestamps, so a window holding a full `capacity` of entries paid for
     * every one of them on teardown. `shrink()` is the half that was missing
     * entirely: without it the ring stayed allocated at its grown capacity for the
     * life of the instance, which defeats the point of a dispose. Measured with
     * `capacity: 8192` and 5000 recorded timestamps, `dispose()` left **8192 slots
     * retained**; it now returns the queue to
     * `POWER_QUEUE_INITIAL_CAPACITY`.
     *
     * The **clock is not re-seeded**, contrary to what this comment used to say.
     * `_now` is the caller's injected clock and `_nowExplicit` records that it was
     * injected, so replacing either would discard caller configuration rather than
     * release a resource. There is no accumulated clock state here to clear.
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
