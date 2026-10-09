/**
 * @typedef {import('./jsdoc-types.js').PowerHistogramOptions} PowerHistogramOptions
 */
export class PowerHistogram {
    /**
     * @param {PowerHistogramOptions} [options]
     */
    constructor(options?: PowerHistogramOptions);
    /** @type {Map<number, number>} sparse bucket index -> count */
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
     * @param {PowerHistogram} other - Sketch to absorb. Must use the same
     *   `relativeAccuracy`; a mismatch is a configuration error because the
     *   bucket indices are not comparable.
     * @returns {this}
     */
    merge(other: PowerHistogram): this;
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
}
export default PowerHistogram;
export type PowerHistogramOptions = import("./jsdoc-types.js").PowerHistogramOptions;
