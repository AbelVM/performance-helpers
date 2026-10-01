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
    _now: (() => number);
    /** @type {boolean} */
    _nowExplicit: boolean;
    _lastRefill: number;
    _tokenRemainder: number;
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
    private _refill;
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
