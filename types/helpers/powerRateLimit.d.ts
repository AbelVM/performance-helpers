/** @typedef {import('../utils/limiterClock.js').LimiterNowOptions} LimiterNowOptions */
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
    /**
   * The slice of a limiter's surface that `PowerRateLimit` composes.
   *
   * Declared as an interface rather than `Object` because the composer's whole
   * job is calling these three members; typing the array as `Object[]` made every
   * one of those calls an error and, worse, meant a limiter that only had
   * `tryConsume` would still be accepted.
   *
  /**
   * Options for `PowerRateLimit`.
   *
   * @typedef {Object} PowerRateLimitOptions
   * @property {boolean} [atomic=false] Attempt all-or-nothing semantics across the
   *   composed limiters. Requires each to expose `available()`.
   * Per-call `tryConsume(n, options)` also accepts a `{ now }` number - read
   * **once per composed call** and threaded into every leg (PERF-007). There is
   * deliberately no constructor `now` here: on the limiters `now` is a *function*,
   * and having one name mean a function in one place and a number in another on
   * the same class is a trap. The composer needs no injected clock of its own,
   * because the per-call value covers every use the limiters' injection does.
   */
    /**
     * The slice of a limiter's surface that `PowerRateLimit` composes.
     *
     * Declared as an interface rather than `Object` because the composer's whole
     * job is calling these members; typing the array as `Object[]` made every one
     * of those calls an error and, worse, meant a limiter that only had
     * `tryConsume` would still be accepted.
     *
     * @typedef {Object} RateLimiterLike
     * @property {function(number=, LimiterNowOptions=): (boolean|{ok: boolean, retryAfterMs?: number})} tryConsume -
     *   The optional second argument carries a single `now` for the whole
     *   composition (PERF-007). A limiter that did not inject its own clock
     *   should honour it; one that did must ignore it, or a limiter under test
     *   silently changes clock mid-run. A limiter that takes only `n` is fine -
     *   it simply reads its own clock.
     * @property {function(number=): {n: number}|number|boolean|null} [reserve]
     *   A token to pass to `release` when it reserves a slot, `false` when it
     *   cannot, `null` when it has no reservation concept. `PowerGCRA` returns a
     *   number; `PowerThrottle` returns `{ n }`.
     * @property {function(*):void} [release]
     * @property {function(number):void} [addTokens]
     * @property {function(number):void} [rollback]
     * @property {number|function(LimiterNowOptions=): number} [available] A count, or a method that
     *   returns one. Both `PowerGCRA` and `PowerThrottle` expose `available()` as
     *   a *method* - the first draft of this typedef said `number`, and the
     *   consumer type test caught it by refusing to accept either helper as a
     *   limiter.
     */
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
    constructor(limiters?: {
        /**
         * -
         * The optional second argument carries a single `now` for the whole
         * composition (PERF-007). A limiter that did not inject its own clock
         * should honour it; one that did must ignore it, or a limiter under test
         * silently changes clock mid-run. A limiter that takes only `n` is fine -
         * it simply reads its own clock.
         */
        tryConsume: (arg0: number | undefined, arg1: LimiterNowOptions | undefined) => (boolean | {
            ok: boolean;
            retryAfterMs?: number;
        });
        /**
         * A token to pass to `release` when it reserves a slot, `false` when it
         * cannot, `null` when it has no reservation concept. `PowerGCRA` returns a
         * number; `PowerThrottle` returns `{ n }`.
         */
        reserve?: ((arg0?: number | undefined) => {
            n: number;
        } | number | boolean | null) | undefined;
        release?: ((arg0: any) => void) | undefined;
        addTokens?: ((arg0: number) => void) | undefined;
        rollback?: ((arg0: number) => void) | undefined;
        /**
         * A count, or a method that
         * returns one. Both `PowerGCRA` and `PowerThrottle` expose `available()` as
         * a *method* - the first draft of this typedef said `number`, and the
         * consumer type test caught it by refusing to accept either helper as a
         * limiter.
         */
        available?: number | ((arg0?: LimiterNowOptions | undefined) => number) | undefined;
    }[], options?: {
        /**
         * Attempt all-or-nothing semantics across the
         * composed limiters. Requires each to expose `available()`.
         * Per-call `tryConsume(n, options)` also accepts a `{ now }` number - read
         * **once per composed call** and threaded into every leg (PERF-007). There is
         * deliberately no constructor `now` here: on the limiters `now` is a *function*,
         * and having one name mean a function in one place and a number in another on
         * the same class is a trap. The composer needs no injected clock of its own,
         * because the per-call value covers every use the limiters' injection does.
         */
        atomic?: boolean | undefined;
    });
    /** @type {RateLimiterLike[]} */
    limiters: {
        /**
         * -
         * The optional second argument carries a single `now` for the whole
         * composition (PERF-007). A limiter that did not inject its own clock
         * should honour it; one that did must ignore it, or a limiter under test
         * silently changes clock mid-run. A limiter that takes only `n` is fine -
         * it simply reads its own clock.
         */
        tryConsume: (arg0: number | undefined, arg1: LimiterNowOptions | undefined) => (boolean | {
            ok: boolean;
            retryAfterMs?: number;
        });
        /**
         * A token to pass to `release` when it reserves a slot, `false` when it
         * cannot, `null` when it has no reservation concept. `PowerGCRA` returns a
         * number; `PowerThrottle` returns `{ n }`.
         */
        reserve?: ((arg0?: number | undefined) => {
            n: number;
        } | number | boolean | null) | undefined;
        release?: ((arg0: any) => void) | undefined;
        addTokens?: ((arg0: number) => void) | undefined;
        rollback?: ((arg0: number) => void) | undefined;
        /**
         * A count, or a method that
         * returns one. Both `PowerGCRA` and `PowerThrottle` expose `available()` as
         * a *method* - the first draft of this typedef said `number`, and the
         * consumer type test caught it by refusing to accept either helper as a
         * limiter.
         */
        available?: number | ((arg0?: LimiterNowOptions | undefined) => number) | undefined;
    }[];
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
    tryConsume(n?: number, options?: {
        /**
         * Attempt all-or-nothing semantics across the
         * composed limiters. Requires each to expose `available()`.
         * Per-call `tryConsume(n, options)` also accepts a `{ now }` number - read
         * **once per composed call** and threaded into every leg (PERF-007). There is
         * deliberately no constructor `now` here: on the limiters `now` is a *function*,
         * and having one name mean a function in one place and a number in another on
         * the same class is a trap. The composer needs no injected clock of its own,
         * because the per-call value covers every use the limiters' injection does.
         */
        atomic?: boolean | undefined;
    } & LimiterNowOptions): boolean;
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
