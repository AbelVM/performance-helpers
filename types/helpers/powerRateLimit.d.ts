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
 * @typedef {import('./jsdoc-types.js').PowerRateLimitCallOptions} PowerRateLimitCallOptions
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
    keyFn: ((arg0: any) => string) | null;
    buckets: number;
    /** @type {Array<RateLimiterLike[]|null>} */
    _slots: Array<RateLimiterLike[] | null>;
    /**
     * The limiter set for `key`, building it on first use.
     *
     * FNV-1a over the string form of the key. Measured over 100 000 keys into
     * 1024 slots: every slot used, min 59 / max 136 against an expected 98, so
     * max/mean 1.39x with no hot spot. No avalanche step is needed at this size,
     * and adding one would cost per request to solve a problem this does not have.
     *
     * @param {string} key
     * @returns {RateLimiterLike[]} The slot's limiters, empty if the key is unusable.
     * @private
     */
    private _slotFor;
    /**
     * The per-key limiter set for `key`, for a caller that wants to inspect or
     * drive one key directly (a `retryAfter` in a `Retry-After` header, say).
     *
     * @param {string} key
     * @returns {RateLimiterLike[]|null} `null` when no `keyFn` is configured.
     */
    limitersFor(key: string): RateLimiterLike[] | null;
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
     * @param {PowerRateLimitCallOptions} [options] - Per-call overrides; `atomic`
     *   defaults to the instance setting, `now` supplies the single clock reading
     *   threaded into every leg, and `context` is what `keyFn` is called with.
     * @returns {boolean} `true` only when every composed limiter allowed it.
     */
    tryConsume(n?: number, options?: PowerRateLimitCallOptions): boolean;
    /**
     * The consume path, parameterised on the leg set.
     *
     * Split out of {@link PowerRateLimit#tryConsume} so the keyed and unkeyed
     * routes share **one** implementation. Duplicating the atomic pre-check, the
     * commit loop and the rollback bookkeeping would be the likeliest way to end
     * up with per-key consumption that does not roll back when a leg fails — the
     * exact defect the unkeyed path was fixed for.
     *
     * @param {RateLimiterLike[]} legs - The limiters to consult: the instance's own,
     *   or one hashed slot's.
     * @param {number} n - The count, already validated.
     * @param {PowerRateLimitCallOptions} options
     * @returns {boolean}
     * @private
     */
    private _consumeIn;
    /**
     * Return the minimum available tokens across all limiters.
     * If any limiter does not expose `available()`, this returns `0`.
     * With `keyFn`, `options.context` selects the key whose slot is measured —
     * without it the result is the shared default slot's.
     * @param {PowerRateLimitCallOptions} [options]
     * @returns {number}
     */
    available(options?: PowerRateLimitCallOptions): number;
    /**
     * Reserve `n` tokens across all limiters and return a token to undo later.
     * Returns `null` when reservation fails.
     * The returned token is a simple marker object such as `{ n: 1 }`, and it can
     * be consumed by `release(token)` or `rollback(token)` to restore the limiters.
     * @param {number} [n=1]
     * @param {PowerRateLimitCallOptions} [options] - Per-call overrides; `context`
     *   selects the `keyFn` slot, so a reservation is made against the same
     *   budget the caller's own `tryConsume` will spend.
     * @returns {{n:number}|null}
     */
    reserve(n?: number, options?: PowerRateLimitCallOptions): {
        n: number;
    } | null;
    /**
     * Release a prior reservation token or numeric count back to the limiters.
     * This accepts the same token object produced by `reserve()` or a numeric
     * count to return tokens directly.
     *
     * Deliberately still coercing rather than calling `assertCount`, because this
     * is the *return* path and not the admission path. A count that cannot be
     * read returns nothing, which is the safe direction: admitting a request you
     * cannot price is how a limiter is bypassed, whereas returning nothing merely
     * over-charges the caller.
     *
     * @param {object|number} tokenOrN
     */
    release(tokenOrN: object | number): void;
    /**
     * @param {number|{n?: number}} [nOrToken] Same argument shape as `release`.
     * @returns {Promise<void>|void}
     */
    rollback(nOrToken?: number | {
        n?: number;
    }): Promise<void> | void;
    /**
     * Every limiter that is currently real: the instance's own legs, or every
     * built slot's legs when `keyFn` is configured.
     *
     * @returns {RateLimiterLike[]}
     * @private
     */
    private _liveLimiters;
    /**
     * @param {{l: RateLimiterLike, method: string, token?: *}} entry
     * @param {number} want
     * @returns {Promise<void>}
     */
    _undoCommit(entry: {
        l: RateLimiterLike;
        method: string;
        token?: any;
    }, want: number): Promise<void>;
    /**
     * Reset all underlying limiters where supported.
     *
     * With `keyFn`, every **built** slot is reset rather than the factory list:
     * the factories are not limiters and resetting them would rebuild nothing.
     * Built slots stay built, because discarding them would hand every tenant a
     * fresh allowance — the eviction-is-a-reset bypass this design exists to avoid.
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
export type PowerRateLimitCallOptions = import("./jsdoc-types.js").PowerRateLimitCallOptions;
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
