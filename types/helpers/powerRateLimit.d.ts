/** @typedef {import('../utils/limiterClock.js').LimiterNowOptions} LimiterNowOptions */
/**
 * Declared at module level, not inside the class, for two reasons.
 *
 * A `@typedef` block sitting between the class opening and the constructor's
 * `@param` block is not attached to anything, and TypeScript then inlines the
 * type structurally into the declaration - which for {@link RateLimiterLike} is
 * a dozen members with comment bodies, emitted twice. And a typedef that is
 * *local* is inlined even when it is attached, because the emitter cannot name
 * a type it does not export.
 *
 * @typedef {import('./jsdoc-types.js').PowerRateLimitOptions} PowerRateLimitOptions
 * @typedef {import('./jsdoc-types.js').RateLimiterLike} RateLimiterLike
 */
/**
 * PowerRateLimit
 *
 * Compose multiple rate limiters and provide a unified `tryConsume`/`reserve` API.
 * Returns success only when all underlying limiters allow consumption.
 *
 * @class PowerRateLimit
 * @public
 */
export class PowerRateLimit {
    /**
     * @param {RateLimiterLike[]} limiters - Limiter instances to compose. Each
     *   must provide `tryConsume(n)`; `reserve`, `release`, `addTokens`,
     *   `rollback` and `available` are used when present.
     * @param {PowerRateLimitOptions} [options] - `atomic` attempts all-or-nothing
     *   semantics: either every limiter allows the consumption or none is left
     *   mutated. That requires each to expose `available()` or an undo primitive
     *   (`reserve`/`release`, or `addTokens`). When a safe rollback cannot be
     *   guaranteed the call returns `false`.
     */
    constructor(limiters?: RateLimiterLike[], options?: PowerRateLimitOptions);
    /** @type {RateLimiterLike[]} */
    limiters: RateLimiterLike[];
    atomicDefault: boolean;
    /**
     * Try to consume `n` tokens across all limiters. Returns true only when
     * every underlying limiter allows consumption. This method first performs a
     * best-effort availability pre-check using `available()` when present; if all
     * checks pass it then performs the actual `tryConsume` calls to commit.
     * Note: some limiters' `available()` also advances internal state (e.g.
     * `PowerThrottle` refills tokens, `PowerSlidingWindow` prunes expired
     * timestamps). The pre-check and the commit run synchronously within the
     * same tick, so results stay consistent — but `available()` is not strictly
     * read-only.
     *
     * Note: when a limiter does not implement `available()` this method falls
     * back to calling `tryConsume` directly which may partially mutate state
     * if other limiters subsequently fail. Prefer limiters that implement
     * `available()` for atomic semantics.
     *
     * @param {number} [n=1] - Tokens to consume.
     * @param {PowerRateLimitOptions & LimiterNowOptions} [options] - Per-call
     *   overrides; `atomic` defaults to the instance setting, and `now` supplies
     *   the single clock reading threaded into every leg.
     * @returns {boolean} `true` only when every composed limiter allowed it.
     */
    tryConsume(n?: number, options?: PowerRateLimitOptions & LimiterNowOptions): boolean;
    /**
     * Return the minimum available tokens across all limiters.
     * If any limiter does not expose `available()`, this returns `0`.
     * @returns {number}
     */
    available(options?: {}): number;
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
export type LimiterNowOptions = import("../utils/limiterClock.js").LimiterNowOptions;
/**
 * Declared at module level, not inside the class, for two reasons.
 *
 * A `@typedef` block sitting between the class opening and the constructor's
 * `@param` block is not attached to anything, and TypeScript then inlines the
 * type structurally into the declaration - which for {@link RateLimiterLike} is
 * a dozen members with comment bodies, emitted twice. And a typedef that is
 * *local* is inlined even when it is attached, because the emitter cannot name
 * a type it does not export.
 */
export type PowerRateLimitOptions = import("./jsdoc-types.js").PowerRateLimitOptions;
/**
 * Declared at module level, not inside the class, for two reasons.
 *
 * A `@typedef` block sitting between the class opening and the constructor's
 * `@param` block is not attached to anything, and TypeScript then inlines the
 * type structurally into the declaration - which for {@link RateLimiterLike} is
 * a dozen members with comment bodies, emitted twice. And a typedef that is
 * *local* is inlined even when it is attached, because the emitter cannot name
 * a type it does not export.
 */
export type RateLimiterLike = import("./jsdoc-types.js").RateLimiterLike;
