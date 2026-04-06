/**
 * PowerRateLimit — compose multiple limiters (tryConsume succeeds only when all
 * underlying limiters allow consumption).
 *
 * Example:
 * const limit = new PowerRateLimit([
 *   new PowerThrottle({ capacity: 100, refillRate: 10 }),
 *   new PowerSlidingWindow({ capacity: 1000, windowMs: 60000 }),
 * ]);
 * if (limit.tryConsume()) {
 *   // perform work
 * }
 *
 * The composed limiter supports both `tryConsume(n)` and `reserve(n)`/
 * `release(tokenOrN)` workflows when underlying limiters expose those
 * methods. When `atomic: true` is configured, it will attempt to preserve
 * all-or-nothing semantics across the set of limiters.
 */
export class PowerRateLimit {
    /**
     * @param {Array<Object>} limiters - Array of limiter instances implementing
     *   `tryConsume(n)` and preferably `available()`.
     * @param {Object} [options]
     * @param {boolean} [options.atomic=false] - When `true` attempt to provide
     *   atomic semantics: either all limiters allow consumption or none will be
     *   left mutated. This requires underlying limiters to expose `available()`
     *   or an undo primitive (e.g. `reserve`/`release` or `addTokens`). If a
     *   safe rollback cannot be guaranteed the call will return `false`.
     */
    constructor(limiters?: Array<Object>, options?: {
        atomic?: boolean | undefined;
    });
    limiters: Object[];
    atomicDefault: boolean;
    /**
     * Try to consume `n` tokens across all limiters. Returns true only when
     * every underlying limiter allows consumption. This method first performs
     * a non-mutating availability check when `available()` is present; if all
     * checks pass it then performs the actual `tryConsume` calls to commit.
     *
     * Note: when a limiter does not implement `available()` this method falls
     * back to calling `tryConsume` directly which may partially mutate state
     * if other limiters subsequently fail. Prefer limiters that implement
     * `available()` for atomic semantics.
     *
     * @param {number} [n=1]
     * @returns {boolean}
     */
    tryConsume(n?: number, options?: {}): boolean;
    /**
     * Return the minimum available tokens across all limiters.
     * If any limiter does not expose `available()`, this returns `0`.
     * @returns {number}
     */
    available(): number;
    /**
     * Reserve `n` tokens across all limiters and return a token to undo later.
     * Returns `null` when reservation fails.
     * The returned token is a simple marker object such as `{ n: 1 }`, and it can
     * be consumed by `release(token)` or `rollback(token)` to restore the limiters.
     * @param {number} [n=1]
     * @returns {{n:number}|null}
     */
    reserve(n?: number): {
        n: number;
    } | null;
    /**
     * Release a prior reservation token or numeric count back to the limiters.
     * This accepts the same token object produced by `reserve()` or a numeric
     * count to return tokens directly.
     * @param {object|number} tokenOrN
     */
    release(tokenOrN: object | number): void;
    rollback(nOrToken: any): void;
    _undoCommit(entry: any, want: any): Promise<any>;
    /**
     * Reset all underlying limiters where supported.
     */
    reset(): void;
}
export default PowerRateLimit;
