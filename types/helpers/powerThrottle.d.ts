export class PowerThrottle {
    /**
     * See {@link PowerThrottleOptions} for the accepted fields; every default is
     * stated there, because a bare `@param {Object} [options]` here is what let
     * the published type and the destructuring drift apart in the first place.
     *
     * @param {PowerThrottleOptions} [options]
     */
    constructor(options?: PowerThrottleOptions);
    capacity: number;
    tokens: number;
    refillRate: number;
    /**
     * Clock for this limiter, and whether it was explicitly injected. See
     * `resolveLimiterNow` for why the flag is load-bearing: an injected clock
     * must outrank a value threaded in by a composition.
     * @type {(() => number)}
     */
    /** @type {boolean} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * Internal: advance tokens based on elapsed time.
     * This method computes the number of tokens to add based on the elapsed
     * milliseconds since the last refill and the configured `refillRate`.
     * It accumulates fractional tokens between invocations to preserve precision.
     *
     * @private
     * @param {number} now - current timestamp in milliseconds
     * @returns {void}
     */
    /**
     * Try to consume `n` tokens.
     * @param {number} [n=1]
     * @param {LimiterNowOptions} [options] Per-call clock override.
     * @returns {boolean} `true` when tokens were consumed; `false` otherwise.
     */
    tryConsume(n?: number, options?: LimiterNowOptions): boolean;
    /**
     * Add tokens to the bucket (forceful, useful for tests).
     * @param {number} n
     * @returns {void}
     */
    addTokens(n: number): void;
    /**
     * Reserve `n` tokens without committing them permanently. If successful,
     * returns a token object such as `{ n: 1 }` that may later be passed to
     * `release()` or `rollback()` to return the reserved tokens.
     *
     * Returns `null` when the reservation fails due to insufficient tokens.
     * @param {number} [n=1]
     * @param {LimiterNowOptions} [options] Per-call clock override.
     * @returns {PowerThrottleToken|null}
     * @example
     * const token = throttle.reserve(1);
     * if (token) {
     *   // use reserved slot
     *   throttle.release(token);
     * }
     */
    reserve(n?: number, options?: LimiterNowOptions): PowerThrottleToken | null;
    /**
     * Release a prior reservation token or add tokens back.
     * Accepts either a token returned from `reserve()` or a numeric count.
     * @param {PowerThrottleToken|number} tokenOrN
     * @returns {void}
     * @example
     * const token = throttle.reserve(2);
     * if (token) throttle.release(token);
     * throttle.release(1); // add one token back directly
     */
    release(tokenOrN: PowerThrottleToken | number): void;
    /**
     * Alias of {@link PowerThrottle#release}.
     * @param {PowerThrottleToken|number} nOrToken
     * @returns {void}
     */
    rollback(nOrToken: PowerThrottleToken | number): void;
    /**
     * Current available tokens (performs a refill before reporting).
     * @param {LimiterNowOptions} [options] Per-call clock override.
     * @returns {number}
     */
    available(options?: LimiterNowOptions): number;
    /**
     * Reset the bucket to a given token count (or full when omitted).
     * @param {number} [count]
     * @returns {void}
     */
    reset(count?: number): void;
    /**
     * Serializable snapshot of the bucket's configuration and current state.
     *
     * **It refills first, which is the whole reason this is not a field read.**
     * `this.tokens` is only ever correct as of the last read: nothing advances it
     * between calls, so a snapshot taken a minute after the last `tryConsume`
     * would report an exhausted bucket that has in fact refilled to capacity. That
     * is the wrong direction to be wrong in — a dashboard showing "0 tokens
     * available" for a bucket that will admit a request is a page that sends
     * someone to debug a limiter that is working — so this asks the bucket what it
     * holds now, the same question `available()` asks.
     *
     * Reported as configuration plus one state field rather than as allow/refuse
     * counters, and that follows `PowerGCRA.stats()` deliberately: a counter would
     * mean incrementing a field on `tryConsume`, the hot synchronous path, for
     * something that is off by default. The bucket's own state is the measurement;
     * how many requests arrived is the caller's to count.
     *
     * @returns {{capacity:number, tokens:number, refillRate:number}}
     */
    stats(): {
        capacity: number;
        tokens: number;
        refillRate: number;
    };
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        capacity: number;
        tokens: number;
        refillRate: number;
    };
    /**
     * Release every resource this instance holds.
     *
     * A throttle holds no timer and no subscription — it refills lazily, computing
     * the elapsed time from `_lastRefill` whenever it is read. So there is nothing
     * to tear down, and this is a **state reset**, not a cleanup: a half-spent
     * bucket is dropped and `_lastRefill` re-seeds, so a disposed-then-reused
     * throttle does not immediately admit a request the previous instance
     * "spent".
     *
     * It exists because `PowerThrottle` is a helper a caller holds for the
     * process lifetime, and without `dispose()` it cannot take part in `using` /
     * `await using` or a DI container's teardown — the one shape every other
     * long-lived helper here supports.
     *
     * A metrics registration is one of the things it releases. The collector holds
     * a closure over this instance, so an observability-enabled throttle that is
     * disposed without unregistering is sampled forever — and a throttle still
     * answers `stats()` afterwards, so nothing fails visibly while the series
     * quietly reports a dead object. Safe to call on a throttle that never
     * attached: `detach(null)` returns `false`.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using x = new PowerThrottle(…)` releases it
     * deterministically at scope exit.
     *
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export type PowerThrottleOptions = import("./jsdoc-types.js").PowerThrottleOptions;
export type PowerThrottleToken = import("./jsdoc-types.js").PowerThrottleToken;
export type LimiterNowOptions = import("../utils/limiterClock.js").LimiterNowOptions;
