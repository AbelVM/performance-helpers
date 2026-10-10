/**
 * APDEX (Application Performance Index) scoring over three integer counters.
 *
 * APDEX compresses a latency stream into one number in `[0, 1]`:
 *
 * ```
 * score = (satisfied + tolerating / 2) / total
 * ```
 *
 * where a sample is **satisfied** at or below `target` (T), **tolerating**
 * between `target` and `tolerance` (F), and **frustrated** above it. The
 * convention is `F = 4T`, which is a convention and not a law — pass
 * `tolerance` explicitly when your SLO says otherwise.
 *
 * ## Why this is not derived from `PowerHistogram`
 *
 * The obvious implementation is two rank queries over a sketch we already ship:
 * `PowerHistogram` answers `percentile(q)` (a value at a rank), and
 * `countAtOrBelow()` is its inverse (a rank at a value), so a score is two
 * calls and a division with no new state at all. It was built and measured, and
 * it is wrong in the case that matters.
 *
 * DDSketch bounds the *value* of a quantile to a relative error of `alpha`. It
 * says nothing about the *rank* of a given value, and APDEX is a ratio of ranks
 * taken at a threshold. Every sample in the bucket the threshold lands in is
 * split by linear interpolation in log space, which is right when the mass is
 * spread across that bucket and arbitrary when it is not.
 *
 * `bench/claims.js apdex` scores the two against each other. Over a lognormal,
 * a bimodal and a pareto distribution the derived score is within **0.057 APDEX
 * points** of the exact one — below the resolution APDEX is quoted at. Put 90%
 * of the mass just below the threshold and 10% just above, both inside one
 * bucket, and the derived score reads **0.625 where the truth is 0.950**: a
 * 324-point error, because a single bucket cannot be split 90/10 by an
 * interpolation that assumes the mass is even in log space. The error is not
 * even monotonic in `alpha` — it depends on where the threshold happens to fall
 * inside the bucket — so a finer sketch is not a safer one.
 *
 * A service operating at its own SLO boundary is exactly that distribution,
 * which makes the derived score worst precisely where it is being watched. So
 * this helper keeps three integers instead: exact, O(1) in memory, and measured
 * at over fifteen times less per-sample cost than the sketch path.
 *
 * ## What a failed request is
 *
 * Standard APDEX scores *completed* requests. A request that threw, or was
 * aborted, or timed out is not a latency and has no place in the formula —
 * count it in your error rate instead. The one exception worth reaching for is
 * a timeout you have already decided to treat as "as slow as possible":
 * `record(Infinity)` lands in **frustrated**, which is the class it belongs to.
 *
 * ## What this cannot answer
 *
 * APDEX is a score, not a distribution. It cannot tell you the p99, and it
 * cannot tell you whether the tail moved or the whole curve shifted. If you
 * want both, record into a `PowerHistogram` as well — they answer different
 * questions and neither substitutes for the other.
 *
 * @class PowerApdex
 * @public
 * @example
 * const apdex = new PowerApdex({ target: 100 });
 *
 * const started = nowMs();
 * await handle(request);
 * apdex.record(nowMs() - started);
 *
 * apdex.score();      // 0..1
 * apdex.stats();      // { target, tolerance, satisfied, tolerating, ... }
 */
/**
 * @typedef {Object} PowerApdexOptions
 * @property {number} target - The SLO in the same unit `record()` takes
 *   (milliseconds by convention). Required: there is no default, because a
 *   guessed threshold would score against the wrong line and still look like a
 *   real number.
 * @property {number} [tolerance=4 * target] The upper bound of the tolerating
 *   class. Must be `>= target`; a smaller value would make the tolerating class
 *   empty and the arithmetic negative.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */
export class PowerApdex {
    /**
     * @param {PowerApdexOptions} [options] - `target` is required in practice: the
     *   constructor throws a `TypeError` without it. The parameter stays optional
     *   because that throw is the documented way a missing `target` is reported,
     *   and `new PowerApdex()` must stay callable to reach it.
     */
    constructor(options?: PowerApdexOptions);
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /** The configured satisfied threshold. */
    get target(): number;
    /** The configured tolerating threshold. */
    get tolerance(): number;
    /** Number of samples recorded at or below `target`. */
    get satisfied(): number;
    /** Number of samples recorded above `target` and at or below `tolerance`. */
    get tolerating(): number;
    /** Number of samples recorded above `tolerance`. */
    get frustrated(): number;
    /** Total samples recorded. */
    get total(): number;
    /**
     * Record one completed request's latency.
     *
     * @param {number} ms Latency in the same unit as `target`. Must be finite and
     *   non-negative, or `+Infinity` for a request that never completed — which
     *   lands in **frustrated**, the class it belongs to. `NaN` and a negative
     *   both throw: a latency that cannot be read is not a slow request, and
     *   filing it as one would move the score for a reason that has nothing to do
     *   with the service.
     * @returns {this}
     */
    record(ms: number): this;
    /**
     * The APDEX score, or `undefined` when nothing has been recorded.
     *
     * `undefined` rather than `0` and rather than `1`: an empty scorer has no
     * score, and both of the numbers a caller might default to would read as a
     * measurement. Same convention as `PowerHistogram.percentile()` on an empty
     * sketch.
     *
     * @returns {number|undefined} A value in `[0, 1]`.
     */
    score(): number | undefined;
    /**
     * Fold another scorer's counts into this one.
     *
     * Exact, unlike a sketch merge — three integers add. That is what makes a
     * per-worker or per-shard scorer aggregatable into a process-level one
     * without the boundary error a rank query would introduce.
     *
     * @param {PowerApdex} other - Must use the same `target` and `tolerance`. A
     *   mismatch is a configuration error rather than a silent average: the
     *   classes are defined by the thresholds, so counts taken against different
     *   thresholds are not the same measurement and adding them produces a number
     *   that means nothing.
     * @returns {this}
     */
    merge(other: PowerApdex): this;
    /** Zero the counts. The thresholds are configuration and survive. */
    reset(): this;
    /** Alias for {@link PowerApdex#reset}. */
    clear(): this;
    /**
     * Counters plus the thresholds they were taken against.
     *
     * The thresholds are in the snapshot deliberately, the way `PowerGCRA.stats()`
     * reports its configuration: a score is meaningless without the line it was
     * measured against, and a dashboard that has to remember which threshold
     * produced a series is a dashboard that will eventually plot two different
     * SLOs on one axis.
     *
     * @returns {{target: number, tolerance: number, satisfied: number, tolerating: number, frustrated: number, total: number, score: number|undefined}}
     */
    stats(): {
        target: number;
        tolerance: number;
        satisfied: number;
        tolerating: number;
        frustrated: number;
        total: number;
        score: number | undefined;
    };
    /** Compatibility alias for {@link PowerApdex#stats}. See `guides/stats-naming.md`. */
    getStats(): {
        target: number;
        tolerance: number;
        satisfied: number;
        tolerating: number;
        frustrated: number;
        total: number;
        score: number | undefined;
    };
    /**
     * Detach from metrics and zero the counts.
     *
     * Owns no timer and no listener registry — it is three integers — so this is
     * a **state reset**, not a teardown. The interface exists so the helper takes
     * part in `using` / `await using` like every other long-lived helper here.
     *
     * @returns {void}
     */
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerApdex;
export type PowerApdexOptions = {
    /**
     * - The SLO in the same unit `record()` takes
     * (milliseconds by convention). Required: there is no default, because a
     * guessed threshold would score against the wrong line and still look like a
     * real number.
     */
    target: number;
    /**
     * The upper bound of the tolerating
     * class. Must be `>= target`; a smaller value would make the tolerating class
     * empty and the arithmetic negative.
     */
    tolerance?: number | undefined;
    /**
     * -
     * Opt in to metrics. See `guides/metrics.md`.
     */
    observability?: boolean | import("./metrics.js").MetricsCollector | undefined;
};
