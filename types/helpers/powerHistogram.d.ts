/**
 * Lock-free in-process histogram for latency telemetry and percentile estimation.
 *
 * Use `PowerHistogram` to record latency values and query estimated
 * percentiles with a compact bucketed sketch.
 *
 * @class PowerHistogram
 * @public
 */
export class PowerHistogram {
    /**
     * @param {Object} [options]
     * @param {number} [options.minValue=1] Lower bound for the first non-zero bucket.
     * @param {number} [options.maxValue=10000] Upper bound for the sketch range.
     * @param {number} [options.bucketCount=128] Number of buckets used internally.
     */
    constructor(options?: {
        minValue?: number | undefined;
        maxValue?: number | undefined;
        bucketCount?: number | undefined;
    });
    _minValue: number;
    _maxValue: number;
    _bucketCount: number;
    _buckets: Uint32Array<ArrayBuffer>;
    _count: number;
    _sum: number;
    _min: number;
    _max: number;
    /** Number of records added. */
    get count(): number;
    /** Sum of all recorded values. */
    get sum(): number;
    /** Average of recorded values, or `0` when empty. */
    get mean(): number;
    /** Minimum recorded value, or `undefined` when empty. */
    get min(): number | undefined;
    /** Maximum recorded value, or `undefined` when empty. */
    get max(): number | undefined;
    /** Number of histogram buckets. */
    get bucketCount(): number;
    /** Reset the histogram to an empty state. */
    reset(): void;
    /**
     * Record a numeric value into the histogram.
     * @param {number} value Latency or measurement value.
     * @returns {this}
     */
    record(value: number): this;
    /**
     * Return the estimated value for the requested percentile.
     * @param {number} quantile Percentile between `0` and `100`, or fraction between `0` and `1`.
     * @returns {number|undefined} Estimated percentile value, or `undefined` when empty.
     */
    percentile(quantile: number): number | undefined;
    /**
     * Return a snapshot copy of bucket counts.
     * @returns {Array<number>}
     */
    snapshot(): Array<number>;
    _buildBoundaries(): void;
    _boundaries: Float64Array<ArrayBuffer> | undefined;
    _bucketIndex(value: any): number;
    _estimateBucketValue(index: any): number;
}
export default PowerHistogram;
