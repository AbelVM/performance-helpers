export class PowerThrottle {
    /**
     * @param {Object} [options]
     * @param {number} [options.capacity=1]
     * @param {number} [options.tokens]
     * @param {number} [options.refillRate=0]
     * @param {number} [options.refillInterval=1000]
     */
    constructor(options?: {
        capacity?: number | undefined;
        tokens?: number | undefined;
        refillRate?: number | undefined;
        refillInterval?: number | undefined;
    });
    capacity: number;
    tokens: number;
    refillRate: number;
    refillInterval: number;
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
    tryConsume(n?: number): boolean;
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
     * @returns {{n:number}|null}
     * @example
     * const token = throttle.reserve(1);
     * if (token) {
     *   // use reserved slot
     *   throttle.release(token);
     * }
     */
    reserve(n?: number): {
        n: number;
    } | null;
    /**
     * Release a prior reservation token or add tokens back.
     * Accepts either a token returned from `reserve()` or a numeric count.
     * @param {object|number} tokenOrN
     * @returns {void}
     * @example
     * const token = throttle.reserve(2);
     * if (token) throttle.release(token);
     * throttle.release(1); // add one token back directly
     */
    release(tokenOrN: object | number): void;
    rollback(nOrToken: any): void;
    /**
     * Current available tokens (performs a refill before reporting).
     * @returns {number}
     */
    available(): number;
    /**
     * Reset the bucket to a given token count (or full when omitted).
     * @param {number} [count]
     * @returns {void}
     */
    reset(count?: number): void;
}
export type PowerThrottleOptions = {
    capacity?: number | undefined;
    tokens?: number | undefined;
    refillRate?: number | undefined;
    refillInterval?: number | undefined;
};
