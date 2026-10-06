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
    /** @type {'shared'|'shared-denied'|'local'|'fail-closed'|null} */
    keyFn: ((arg0: any) => string) | null;
    buckets: number;
    /** @type {Array<RateLimiterLike[]|null>} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
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
     * When `sharedState` is configured, the distributed store is consulted
     * first. On a backend error the limiter degrades according to `degrade`:
     * `'local'` falls back to the local legs (approximate but available),
     * `'fail-closed'` refuses the request. The path taken is exposed through
     * `stats().path` and `lastPath`.
     *
     * @param {number} [n=1] - Tokens to consume.
     * @param {PowerRateLimitCallOptions} [options] - Per-call overrides; `atomic`
     *   defaults to the instance setting, `now` supplies the single clock reading
     *   threaded into every leg, and `context` is what `keyFn` is called with.
     * @returns {boolean|Promise<boolean>} `true` only when every composed limiter
     *   allowed it. Returns a promise when `sharedState` is configured and its
     *   adapter is async.
     */
    tryConsume(n?: number, options?: PowerRateLimitCallOptions): boolean | Promise<boolean>;
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
     * **What a leg's `release` actually receives, which is a contract and not an
     * implementation detail.** There are two undo paths in this class and they hand
     * a leg different objects, deliberately:
     *
     * - **This one** passes the caller's `tokenOrN` through unchanged, so a leg
     *   that implements `reserve` receives the **composer's** token — `{ n }` — not
     *   the object the leg itself minted. The token is public API and two tests in
     *   `powerRateLimit.extra.test.js` pin that shape, so it is not changing.
     * - **`_undoCommit`** — the rollback taken when a later leg fails — passes the
     *   **leg's own** token, because it has it in hand and the leg is the only thing
     *   that could have minted it.
     *
     * A leg whose `release` only reads `.n` (as `PowerThrottle`'s does) cannot tell
     * the difference. **A leg that looks its token up in a `Map` it minted it into
     * can, and will miss.** So the requirement on a limiter used here is that its
     * `release` accepts either shape — a `{ n }`-bearing object *or* a plain count —
     * which is exactly what `PowerThrottle.release` already does. Where a leg's
     * `release` throws on an unrecognised token, the fallback below reaches
     * `rollback`/`addTokens` with the count instead, so the credit is not simply
     * lost.
     *
     * @param {object|number} tokenOrN
     * @param {PowerRateLimitCallOptions} [options] - **With `keyFn`, `options.key`
     *   selects the slot to refund** — the same per-call convention `tryConsume` and
     *   `available()` already use. Without it a keyed composer credits **every
     *   built slot**, which is what this parameter exists to stop (RES-039):
     *   `reserve()`/`tryConsume` debit one slot, so a slot-wide refund hands a tenant
     *   an allowance it never spent away, and because `PowerThrottle.release` clamps
     *   at `capacity` the victim ends up *fully* topped up rather than merely
     *   nudged. Reproduced at capacity 5: tenant A spends 4, tenant B spends 1, and
     *   `release(4)` left both at 5.
     *
     *   Omitting `key` is not "refund everything" — it routes to the same shared
     *   slot that `tryConsume` without a key debits, which is the honest degradation
     *   and the one `_slotFor` already documents.
     *
     *   Note this is deliberately **not** solved by putting a `slot` field on the
     *   token: the token is public API, `toEqual({ n: 1 })` is pinned by a test, and
     *   `limitersFor(key)` already exposes the slot. A per-call argument matches the
     *   rest of the class and changes nothing a caller can already observe.
     */
    release(tokenOrN: object | number, options?: PowerRateLimitCallOptions): void;
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
    /**
     * The path taken by the most recent `tryConsume` call, when `sharedState` is
     * configured. `null` before any call, and `null` for an unkeyed composer
     * without `sharedState`.
     *
     * @returns {'shared'|'shared-denied'|'local'|'fail-closed'|null}
     */
    get lastPath(): "shared" | "shared-denied" | "local" | "fail-closed" | null;
    /**
     * Serializable snapshot of the composition's shape and, where there is one
     * answer, its headroom.
     *
     * **`available` is `null` for a keyed composer, and that is the interesting
     * field.** Each key has its own budget and a snapshot has no key to measure, so
     * there is no single number. The obvious alternative -- measure the shared
     * default slot, as `tryConsume` does when no key is given -- would report one
     * arbitrary tenant's allowance as *the composition's*, and that is the number
     * least likely to be believed and most likely to be believed wrongly. `null`
     * is the honest reading, and `toSeries` already preserves it as an explicit
     * absence rather than dropping the key, which is the same treatment
     * `PowerGCRA.stats()` gives an unset `tat`. Use `available({ context })` for a
     * specific key.
     *
     * `builtSlots` is the count of hash slots that have actually been built, which
     * for a keyed composer is the number of tenants the instance is currently
     * holding budgets for. `builtSlots / buckets` is the occupancy; at 1.0 every
     * slot has been touched and further tenants share budgets with existing ones.
     *
     * `path` is the most recent `tryConsume` path when `sharedState` is configured,
     * or `null` otherwise.
     *
     * @returns {{legs:number, atomic:boolean, keyed:boolean, buckets:number, builtSlots:number, available:number|null, path:string|null}}
     */
    stats(): {
        legs: number;
        atomic: boolean;
        keyed: boolean;
        buckets: number;
        builtSlots: number;
        available: number | null;
        path: string | null;
    };
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        legs: number;
        atomic: boolean;
        keyed: boolean;
        buckets: number;
        builtSlots: number;
        available: number | null;
        path: string | null;
    };
    /**
     * Release every resource this instance holds, so it can take part in `using` /
     * `await using` and a DI container's teardown like every other long-lived
     * limiter here.
     *
     * A composer holds no timer and no subscription — its legs refill lazily and
     * compute elapsed time from a stored timestamp whenever they are read — so this
     * is a **state release**, not a cleanup, and there is nothing to cancel.
     *
     * **With `keyFn`, this drops the lazily built per-slot limiter sets**, and that
     * is the part worth having. They are the largest thing a rate limiter in this
     * library holds: `buckets` (default 1024) slots, each a fresh limiter set built
     * from the caller's factories, addressed by a hash of a **client-controlled**
     * key. Filling them with `null` drops the whole graph in one pass, where
     * `reset()` alone would walk every built slot calling `reset()` on each leg and
     * leave every one of them resident. An unkeyed composer has nothing built and
     * falls through to the reset below.
     *
     * **Disposing and then reusing a keyed composer hands every built slot a fresh
     * allowance.** That is the same "eviction is a reset" bypass the constructor
     * refuses to commit to, and it is stated rather than prevented because the two
     * situations are not the same: a slot is never discarded *while the instance is
     * live*, because a tenant evicted while quiet would return to a full budget and
     * rate limiting would be skippable. Here the caller has declared it is finished
     * with the instance, and the alternative — keeping slots resident after teardown
     * so a disposed composer is still indistinguishable from a live one — is the
     * memory a dispose exists to release.
     *
     * The caller's own `limiters` are **not** discarded. They were passed in, so
     * they belong to the caller; the unkeyed path resets them, which is what
     * {@link PowerRateLimit#reset} already does, and leaves the caller's objects
     * usable.
     *
     * A metrics registration is released here too, for the same reason the slots
     * are: the collector holds a closure over this instance, so a disposed
     * composer would be sampled forever — and it still answers `stats()`
     * afterwards, so nothing fails visibly while the series reports a dead object.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using limit = new PowerRateLimit(…)` releases
     * it deterministically at scope exit.
     *
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export namespace PowerRateLimit {
    /**
     * Create a fluent builder for {@link PowerRateLimit}.
     * @returns {PowerRateLimitBuilder}
     */
    function builder(): PowerRateLimitBuilder;
}
/**
 * Fluent builder for {@link PowerRateLimit}. Allows ergonomic construction of
 * composed limiters without manually building the options object.
 *
 * @example
 * const limit = PowerRateLimit.builder()
 *   .add(new PowerThrottle({ capacity: 100, refillRate: 10 }))
 *   .add(new PowerSlidingWindow({ capacity: 1000, windowMs: 60000 }))
 *   .atomic(true)
 *   .build();
 */
export class PowerRateLimitBuilder {
    /** @type {RateLimiterLike[]} */
    /** @type {PowerRateLimitOptions} */
    /**
     * Add a limiter to the composition.
     * @param {RateLimiterLike} limiter
     * @returns {PowerRateLimitBuilder}
     */
    add(limiter: RateLimiterLike): PowerRateLimitBuilder;
    /**
     * Set the `atomic` option. When true, all-or-nothing semantics are attempted.
     * @param {boolean} value
     * @returns {PowerRateLimitBuilder}
     */
    atomic(value: boolean): PowerRateLimitBuilder;
    /**
     * Set the `keyFn` option for per-key limiting.
     * @param {((ctx: any) => string) | null} value
     * @returns {PowerRateLimitBuilder}
     */
    keyFn(value: ((ctx: any) => string) | null): PowerRateLimitBuilder;
    /**
     * Set the `buckets` option for the per-key slot array size.
     * @param {number} value
     * @returns {PowerRateLimitBuilder}
     */
    buckets(value: number): PowerRateLimitBuilder;
    /**
     * Set the `sharedState` adapter for distributed rate limiting.
     * @param {import('./jsdoc-types.js').PowerSharedStateAdapter | null} value
     * @returns {PowerRateLimitBuilder}
     */
    sharedState(value: import("./jsdoc-types.js").PowerSharedStateAdapter | null): PowerRateLimitBuilder;
    /**
     * Set the `degrade` mode for shared-state backend errors.
     * @param {'local' | 'fail-closed'} value
     * @returns {PowerRateLimitBuilder}
     */
    degrade(value: "local" | "fail-closed"): PowerRateLimitBuilder;
    /**
     * Build the {@link PowerRateLimit} instance.
     * @returns {PowerRateLimit}
     */
    build(): PowerRateLimit;
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
export type SharedStateOutcome = {
    ok: boolean;
    retryAfterMs?: number;
};
export type SharedStatePromise = Promise<SharedStateOutcome>;
