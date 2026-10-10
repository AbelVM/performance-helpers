export class PowerHistogram {
    /**
     * Rebuild a sketch from its {@link PowerHistogram#toJSON} representation.
     *
     * **This is the missing half of the documented distributed path.** The class
     * doc advertises that the sketch "merges exactly, so per-worker or per-shard
     * sketches can be combined into a global histogram", and `toJSON()` has always
     * existed — but `structuredClone` does not preserve the class, so a sketch
     * arriving from a worker is a *plain object*, and `merge()` rejected it with
     * "expects a PowerHistogram". The headline use case was unreachable, and a
     * caller had to hand-roll reconstruction, which is exactly the kind of thing
     * that gets the bucket indices wrong.
     *
     * Accepts the output of `toJSON()` and nothing else: a plain object with the
     * same shape. The check is **structural**, not `instanceof`, per the
     * cross-realm rule — `instanceof` is false for a value from another realm, and
     * this method exists precisely to consume values that crossed a boundary.
     *
     * @param {object} obj - A `toJSON()` result. `relativeAccuracy` must match the
     *   sketch it will be merged into, because bucket indices are only comparable
     *   within the same accuracy.
     * @returns {PowerHistogram} A new sketch; `obj` is not retained.
     */
    static fromJSON(obj: object): PowerHistogram;
    /**
     * @param {PowerHistogramOptions} [options]
     */
    constructor(options?: PowerHistogramOptions);
    /** @type {Map<number, number>} sparse bucket index -> count */
    /** @type {{indices: number[], prefix: number[]}|null} */
    /**
     * Add `n` to the running sum with Neumaier compensation.
     *
     * **AUD-029, and the ES2026 feature the row named does not apply.**
     * `Math.sumPrecise` was the suggested fix for "naive `+=`, which loses
     * precision on mixed magnitudes" — and the loss is real: recording `1e16` and
     * then a thousand `1`s gives a `sum` of `1e16`, discarding all thousand
     * (measured, absolute error -1000). But `sumPrecise` sums an **iterable**, and
     * a DDSketch does not retain its values — that is the whole point of the
     * format, O(1) memory for an unbounded range. It is also `undefined` on this
     * library's declared floor (`engines.node` is `>=22.12`), so it would need a
     * capability probe and a fallback, which is the "partly negates the benefit"
     * case the audit itself warns about.
     *
     * So the problem is solved the way an *incremental* accumulator has to be
     * solved: Neumaier compensated summation. Each add keeps the rounding error it
     * could not represent in `_sumCompensation`, and the `sum` getter returns the
     * pair. The cost is one extra field and a few flops per record, on a path that
     * already does a `Math.log` and a `Map` operation — so it is not free, but it
     * is not the bottleneck either.
     *
     * @param {number} n
     * @returns {void}
     * @private
     */
    /** Number of records added. */
    get count(): number;
    /** Sum of all recorded values. */
    get sum(): number;
    /**
     * Average of the recorded values, or `0` when empty.
     *
     * Averaged over the records that carry a value, not over `count`. A `+Infinity`
     * record is counted and reported in `infCount` but deliberately contributes
     * nothing to `sum`, so dividing `sum` by `count` under-reported every
     * histogram that saw one: `[10, Infinity]` gave `mean` of 5 for a single
     * finite sample. There is no finite mean over a set containing `Infinity`, so
     * the finite samples are averaged and the infinities are left to `infCount`.
     */
    get mean(): number;
    /** Minimum recorded value, or `undefined` when empty. */
    get min(): number | undefined;
    /** Maximum recorded value, or `undefined` when empty. */
    get max(): number | undefined;
    /**
     * Configured relative error bound for quantiles.
     * @returns {number}
     */
    get relativeAccuracy(): number;
    /**
     * Number of *occupied* buckets. The legacy option of the same name sized a
     * dense array; with sparse DDSketch storage this reports what is actually in
     * use, which is the useful number.
     * @returns {number}
     */
    get bucketCount(): number;
    /**
     * Number of records that fell above the advisory `maxValue`. These are
     * stored faithfully - this counter exists so a caller can notice a range that
     * no longer matches reality instead of silently reading clamped data.
     * @returns {number}
     */
    get outOfRangeCount(): number;
    /**
     * Number of records below the advisory `minValue`.
     * @returns {number}
     */
    get belowRangeCount(): number;
    /** Reset the histogram to an empty state. */
    reset(): void;
    /**
     * Record a numeric value into the histogram.
     * @param {number} value Latency or measurement value. Must be finite and
     *   non-negative.
     * @returns {this}
     */
    record(value: number): this;
    /**
     * Return the estimated value for the requested percentile.
     *
     * The estimate is guaranteed to be within `relativeAccuracy` of the true
     * quantile, for any value range.
     *
     * @param {number} quantile Percentile between `0` and `100`, or fraction
     *   between `0` and `1`. **The two ranges overlap at `1`, and the fraction
     *   reading wins** — `percentile(1)` is the 100th percentile, not the 1st.
     *   Use `0.5` or `50` for p50 and `100` for the maximum. This is documented
     *   rather than accidental: see `guides/powerHistogram.md`, which calls `1`
     *   "the one to watch".
     *
     *   A value **above 100 saturates to the maximum** rather than throwing.
     *   That is deliberate and is the one place this method degrades instead of
     *   rejecting: `NaN` and a negative both throw, because they would index
     *   nonsense, whereas `150` asks for "at or above the top" and the maximum is
     *   the correct answer to that. Pinned by
     *   `test/powerHistogram.quantileRange.test.js`.
     * @returns {number|undefined} Estimated percentile value, or `undefined` when empty.
     */
    percentile(quantile: number): number | undefined;
    /**
     * Estimated number of recorded samples whose value is **at or below**
     * `value` — the inverse of {@link PowerHistogram#percentile}, which maps a
     * rank to a value where this maps a value to a rank.
     *
     * The name is deliberately not `countBelow`. `belowRangeCount` already means
     * *strictly* below in this class, and a method whose name says one thing
     * while its boundary does another is how an off-by-one reaches an SLO. The
     * boundary here is inclusive, which is the class APDEX calls "satisfied".
     *
     * ## What the estimate rests on
     *
     * Every occupied bucket below the one `value` falls into is counted in full,
     * because such a bucket's entire multiplicative range lies at or below
     * `value`. The boundary bucket is **interpolated**: the share of its
     * log-range at or below `value` is applied to its count, which is the same
     * uniform-in-log-space assumption the bucket layout already makes. The error
     * is therefore bounded by the mass sitting in that one bucket, and it is
     * worst exactly where a distribution concentrates near the threshold — the
     * case `bench/claims.js apdex` measures rather than asserts.
     *
     * A `+Infinity` record is never at or below a finite `value`, so it is
     * excluded; `countAtOrBelow(Infinity)` returns `count`.
     *
     * @param {number} value Threshold. `NaN` throws. A negative threshold
     *   returns `0`, because `record()` refuses negative values so nothing
     *   recorded can be at or below one. `0` returns the count of exact-zero
     *   records.
     * @returns {number} Estimated count in `[0, count]`. **Not an integer** when
     *   the boundary bucket is interpolated — rounding it would bias every
     *   threshold that lands mid-bucket in the same direction, and a caller who
     *   needs a whole number is one `Math.round()` from one.
     */
    countAtOrBelow(value: number): number;
    /**
     * Clamp an estimate into the exact observed `[min, max]` range.
     *
     * A bucket's representative value is the midpoint of its multiplicative
     * range, so the lowest non-zero bucket can report a value slightly *below*
     * the true `min`. Left alone that makes the quantile function
     * non-monotonic - `percentile(0)` returns the exact `min` while
     * `percentile(5)` returns the bucket midpoint beneath it, so a p0 > p5 curve
     * is observable. Clamping to the exact bounds restores monotonicity and
     * cannot break the relative bound, because `min`/`max` are exact.
     *
     * @param {number} value
     * @returns {number}
     * @private
     */
    /**
     * Merge another sketch into this one.
     *
     * DDSketch buckets are exact multiplicative ranges, so the merge is exact
     * up to the same relative bound - unlike rank-error sketches (t-digest,
     * GK, KLL) which are only one-way mergeable. This is what makes it safe to
     * keep a per-worker histogram and fold them into a pool-level one.
     *
     * **Accepts a plain sketch as well as a `PowerHistogram`** (AUD-012). A sketch
     * that crossed a worker boundary arrives as a plain object, because
     * `structuredClone` does not preserve the class, and rejecting it made the
     * distributed path this docblock advertises unreachable. The check is
     * structural rather than `instanceof` for the same reason — see
     * {@link PowerHistogram.fromJSON}.
     *
     * @param {PowerHistogram|object} other - Sketch to absorb, either an instance
     *   or a `toJSON()` result. Must use the same `relativeAccuracy`; a mismatch
     *   is a configuration error because the bucket indices are not comparable.
     * @returns {this}
     */
    merge(other: PowerHistogram | object): this;
    /**
     * Return a snapshot copy of bucket counts, ordered from the lowest occupied
     * bucket to the highest.
     *
     * The array spans only the *occupied* range, so its length is
     * `bucketCount`-1 at most; a single leading entry is the zero bucket.
     * @returns {Array<number>}
     */
    snapshot(): Array<number>;
    /**
     * Serializable representation, suitable for merging elsewhere or shipping to
     * a metrics backend.
     * @returns {{relativeAccuracy:number, count:number, sum:number, min:number, max:number, zeroCount:number, infCount:number, outOfRangeCount:number, belowRangeCount:number, buckets:Array<[number, number]>}}
     */
    toJSON(): {
        relativeAccuracy: number;
        count: number;
        sum: number;
        min: number;
        max: number;
        zeroCount: number;
        infCount: number;
        outOfRangeCount: number;
        belowRangeCount: number;
        buckets: Array<[number, number]>;
    };
    /**
     * Bucket index for a strictly positive, finite value.
     * @param {number} v
     * @returns {number}
     * @private
     */
    /**
     * Representative value for a bucket index. This is the midpoint of the
     * bucket's multiplicative range, so the worst-case relative error against
     * any value in the bucket is bounded by `relativeAccuracy`.
     * @param {number} index
     * @returns {number}
     * @private
     */
    /**
     * Ascending list of occupied bucket indices, cached until the bucket set
     * changes.
     * @returns {number[]}
     * @private
     */
    /**
     * Ascending occupied bucket indices with their cumulative counts, cached
     * until the bucket set changes.
     *
     * `prefix[i]` is the total count of every bucket *before* `indices[i]`, so
     * `prefix[indices.length]` is the count of all indexed samples. That is what
     * lets {@link PowerHistogram#countAtOrBelow} answer a rank query in
     * O(log b) over occupied buckets instead of walking the range — a rank query
     * is the kind of thing a dashboard calls on every scrape, and the walk would
     * make the cost of a score scale with the spread of the data rather than with
     * the number of queries.
     *
     * @returns {{indices: number[], prefix: number[]}}
     * @private
     */
}
export default PowerHistogram;
export type PowerHistogramOptions = import("./jsdoc-types.js").PowerHistogramOptions;
