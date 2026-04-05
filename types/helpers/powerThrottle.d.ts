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
