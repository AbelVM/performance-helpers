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
    refillInterval: number;
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
     * @returns {boolean} `true` when tokens were consumed; `false` otherwise.
     */
    tryConsume(n?: number, options?: {}): boolean;
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
     * @returns {PowerThrottleToken|null}
     * @example
     * const token = throttle.reserve(1);
     * if (token) {
     *   // use reserved slot
     *   throttle.release(token);
     * }
     */
    reserve(n?: number, options?: {}): PowerThrottleToken | null;
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
     * @returns {number}
     */
    available(options?: {}): number;
    /**
     * Reset the bucket to a given token count (or full when omitted).
     * @param {number} [count]
     * @returns {void}
     */
    reset(count?: number): void;
}
export type PowerThrottleOptions = import("./jsdoc-types.js").PowerThrottleOptions;
export type PowerThrottleToken = import("./jsdoc-types.js").PowerThrottleToken;
