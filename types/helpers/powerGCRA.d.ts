/**
 */
/**
 * @typedef {object} PowerGCRAOptions
 * @property {number} rate - Sustained rate in operations per `per` unit. Must be > 0.
 * @property {number} [per=1000] - The unit `rate` is measured against, in milliseconds.
 * @property {number} [burst=0] - Extra tolerance above the steady-state rate, in
 *   operations. `0` allows exactly the steady-state spacing; larger values admit
 *   a short spike of that many extra operations.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this limiter in the shared collector, or pass a collector of
 *   your own. Off by default, so the common case allocates nothing.
 * @property {function(): number} [now] - Clock override, for tests and for
 *   compositions that read the clock once. Ignored by a composition that
 *   threads its own reading, because an injected clock always wins.
 * @property {function(number):void} [onError] - Called when the internal clock
 *   misbehaves (time moving backwards), instead of throwing.
 */
/**
 * A GCRA rate limiter.
 *
 * @example
 * const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 10 });
 * if (limiter.tryConsume()) doWork();
 * else setTimeout(doWork, limiter.retryAfter());
 */
export class PowerGCRA {
    /**
     * @param {PowerGCRAOptions} [options] - `rate` is required in practice: the
     *   constructor throws a `TypeError` without it. The parameter stays optional
     *   because that throw is the documented way a missing `rate` is reported, and
     *   `new PowerGCRA()` must stay callable to reach it.
     */
    constructor(options?: PowerGCRAOptions);
    rate: number;
    per: number;
    burst: number;
    /**
     * Clock for this limiter, and whether it was explicitly injected. See
     * `resolveLimiterNow` for why the flag is load-bearing: an injected clock
     * must outrank a value threaded in by a composition.
     * @type {(() => number)}
     */
    /** @type {boolean} */
    /** @type {?number} */
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * Try to consume one operation.
     * @param {number} [n=1] - Number of operations to consume.
     * @returns {boolean} `true` when the request fits inside the current budget.
     */
    /**
     * Report a backwards clock, without ever letting the report break admission.
     *
     * The clamp in {@link tryConsume} already prevents a backwards clock from
     * admitting unbounded traffic, so this is observability, not safety. It is
     * individually guarded because a throwing `onError` would replace a rate-limit
     * decision with a callback error, and the caller would see an exception where
     * the limiter had a perfectly good answer.
     *
     * @param {number} now - The offending clock reading.
     * @returns {void}
     * @private
     */
    /**
     * @param {number} [n=1]
     * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
     *   Per-call clock override.
     * @returns {boolean}
     */
    tryConsume(n?: number, options?: import("../utils/limiterClock.js").LimiterNowOptions): boolean;
    /**
     * Exact milliseconds until `tryConsume(n)` would succeed.
     *
     * Grows with `n`, by `(n - 1) * emissionInterval` beyond the single-operation
     * wait. That is the batch's own span and it has to: a batch is admitted only
     * when the whole span fits inside the tolerance window, so waiting the
     * single-operation wait and then asking for five would be refused. The wait
     * this returns is the exact boundary — not an estimate, and not a value that
     * under-waits.
     *
     * @param {number} [n=1] - Number of operations the next call would consume.
     * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
     *   Per-call clock override.
     * @returns {number} Milliseconds to wait; `0` when the call would succeed now.
     */
    retryAfter(n?: number, options?: import("../utils/limiterClock.js").LimiterNowOptions): number;
    /**
     * Consume, and on refusal report **the exact time** the batch would be admitted.
     *
     * The capability is not missing — {@link PowerGCRA#retryAfter} already computes
     * the exact wait. What is missing is doing both **from one clock reading**:
     * `tryConsume()` followed by `retryAfter()` takes two, and this class's own
     * comments record that two spellings of the same arithmetic have already
     * disagreed in the last bit and admitted a batch `available()` had just called
     * unaffordable. A caller wiring an HTTP 429 needs both answers at once anyway.
     *
     * `runAt` is an **absolute timestamp**, not a delay — an HTTP `Retry-After` and a
     * log line both want the instant, and converting one to the other is where a
     * caller gets it wrong. It is `null` on success because there is nothing to wait
     * for.
     *
     * This mirrors `tryConsume`'s admission path line for line rather than calling
     * it, because calling it would cost the second reading this method exists to
     * avoid. `test/powerGCRA.test.js` asserts the two agree across a spread of
     * configurations, so a future change to either one that the other does not
     * follow fails rather than drifting.
     *
     * @param {number} [n=1] - Number of operations to reserve.
     * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
     *   Per-call clock override.
     * @returns {{ok: true, runAt: null} | {ok: false, runAt: number}} `runAt` is the
     *   absolute time the refused batch would be admitted.
     */
    tryReserve(n?: number, options?: import("../utils/limiterClock.js").LimiterNowOptions): {
        ok: true;
        runAt: null;
    } | {
        ok: false;
        runAt: number;
    };
    /**
     * The largest batch this limiter will admit at any instant, at any wait.
     *
     * {@link PowerGCRA#_covers} saturates here, so an ask above it is not merely
     * refused *now* — no amount of waiting admits it, because the ceiling is set
     * by `burst` and not by the state of the TAT. Measured over `rate` 1-30 ×
     * `burst` 0-10, a batch one past the ceiling was admitted at **no** wait out
     * of 200 000 tried, per configuration.
     *
     * `burst` is not asserted integral (a fractional burst is a legitimate
     * sub-operation tolerance), so the ceiling floors. A fractional `burst` rounds
     * *down* here and up in `_delayTolerance`, which is the safe direction: it
     * never claims capacity that the check will not honour.
     *
     * @returns {number} A whole number of operations, at least 1.
     * @private
     */
    /**
     * Consume, or return the exact wait needed.
     * @param {number} [n=1]
     * @returns {{ok: true} | {ok: false, retryAfter: number}}
     */
    take(n?: number): {
        ok: true;
    } | {
        ok: false;
        retryAfter: number;
    };
    /**
     * How many operations can be consumed at this instant, given the burst
     * ceiling.
     *
     * A batch is admitted behind a single check, so the count at an idle instant
     * is `burst + 1`, not `burst`: with no history every call up to and including
     * the `burst`-th extra one still finds `tat <= now + delayTolerance`. This
     * also has to be right for composition - `PowerRateLimit` pre-checks
     * `available()` and refuses immediately when it is below the ask, so
     * reporting `0` on a fresh limiter would make GCRA refuse everything.
     *
     * @param {import('../utils/limiterClock.js').LimiterNowOptions} [options]
     *   Per-call clock override.
     * @returns {number} A non-negative whole number.
     */
    available(options?: import("../utils/limiterClock.js").LimiterNowOptions): number;
    /**
     * How many operations the budget at `now` covers, given the pre-update TAT.
     *
     * The single source of truth for admission. `tryConsume` compares against
     * `count` and `available()` returns it, so the two cannot disagree — which is
     * the point, because as separate expressions they did: `floor(remaining /
     * emission) + 1` and `remaining >= (n - 1) * emission` are equal in exact
     * arithmetic and *not* in floating point, and the disagreement showed up as a
     * limiter admitting a batch its own `available()` had just refused.
     *
     * The `+ 1` is not slack. The check is made against the *pre-update* TAT, so
     * at an idle instant the very first operation always fits, and an idle
     * `burst: b` limiter covers `b + 1` operations back to back. `PowerRateLimit`
     * depends on that number: it pre-checks `available() < want` and refuses
     * without calling `tryConsume`, so reporting `0` on a fresh limiter would
     * make GCRA refuse everything once composed.
     *
     * @param {number} tat - Pre-update TAT, from {@link PowerGCRA#_tatAt}.
     * @param {number} now - Current clock reading in ms.
     * @returns {number} A non-negative whole number of operations.
     * @private
     */
    /**
     * Milliseconds of tolerance still unspent at `now`, given the pre-update TAT.
     *
     * Extracted so admission, availability and {@link PowerGCRA#retryAfter} all
     * read the same number by the same subtraction. Each of them had its own
     * spelling before, and the three disagreed in the last bit — see
     * {@link PowerGCRA#retryAfter}.
     *
     * @param {number} tat - Pre-update TAT, from {@link PowerGCRA#_tatAt}.
     * @param {number} now - Current clock reading in ms.
     * @returns {number} Milliseconds remaining; negative when the TAT is ahead.
     * @private
     */
    /**
     * The pre-update TAT at `now`, clamped so it never sits in the past.
     *
     * Three methods need this exact pair — `tryConsume`, `retryAfter` and
     * `available` — and the `-Infinity` sentinel is what distinguishes "no
     * history" from "history that a backwards clock put behind us". Inlining it
     * three times is how the batch check came to omit its own span: the clamping
     * was duplicated but the predicate was not.
     *
     * @param {number} now - Current clock reading in ms.
     * @returns {number} The TAT to decide against.
     * @private
     */
    /**
     * Whether the limiter would accept a single operation right now, without
     * consuming it. Same shape as `PowerThrottle.available()` for composition.
     * @returns {boolean}
     */
    get hasCapacity(): boolean;
    /**
     * Clear the accumulated state, as if the limiter were brand new.
     * @returns {void}
     */
    reset(): void;
    /**
     * Serializable snapshot of the limiter's configuration and state.
     *
     * `tat` is `null` - not `-Infinity` - when there is no accumulated history
     * (fresh instance, or after `reset()` / `dispose()`), because `-Infinity` does
     * not survive a JSON round-trip: `JSON.stringify` turns it into `null`
     * anyway, so a snapshot that claimed `number` was only true in memory. A
     * consumer that reads the snapshot back therefore already had to handle
     * `null`; the declared type now says so.
     *
     * @returns {{rate:number, per:number, burst:number, emissionInterval:number, delayTolerance:number, tat:number|null}}
     */
    stats(): {
        rate: number;
        per: number;
        burst: number;
        emissionInterval: number;
        delayTolerance: number;
        tat: number | null;
    };
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        rate: number;
        per: number;
        burst: number;
        emissionInterval: number;
        delayTolerance: number;
        tat: number | null;
    };
    /** @returns {void} */
    dispose(): void;
    /**
     * Alias for {@link PowerGCRA#reset}.
     *
     * `reset()` here *is* a clear — it discards the one piece of stored state, so
     * both words describe the same act. Contrast the limiters that *hold* capacity
     * (`PowerThrottle`, `PowerPermitGate`), where `reset()` refills and `clear()`
     * would read as the opposite.
     *
     * @returns {void}
     */
    clear(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerGCRA;
export type PowerGCRAOptions = {
    /**
     * - Sustained rate in operations per `per` unit. Must be > 0.
     */
    rate: number;
    /**
     * - The unit `rate` is measured against, in milliseconds.
     */
    per?: number | undefined;
    /**
     * - Extra tolerance above the steady-state rate, in
     * operations. `0` allows exactly the steady-state spacing; larger values admit
     * a short spike of that many extra operations.
     */
    burst?: number | undefined;
    /**
     * - Opt in to
     * metrics: `true` registers this limiter in the shared collector, or pass a collector of
     * your own. Off by default, so the common case allocates nothing.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
    /**
     * - Clock override, for tests and for
     * compositions that read the clock once. Ignored by a composition that
     * threads its own reading, because an injected clock always wins.
     */
    now?: (() => number) | undefined;
    /**
     * - Called when the internal clock
     * misbehaves (time moving backwards), instead of throwing.
     */
    onError?: ((arg0: number) => void) | undefined;
};
