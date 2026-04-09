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
  constructor(options = {}) {
    const { minValue = 1, maxValue = 10000, bucketCount = 128 } = options || {};
    this._minValue = Number.isFinite(Number(minValue)) ? Math.max(0, Number(minValue)) : 1;
    this._maxValue = Math.max(this._minValue + 1, Number(maxValue) || 10000);
    this._bucketCount = Math.max(4, Math.floor(Number(bucketCount) || 128));
    this._buckets = new Uint32Array(this._bucketCount);
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._buildBoundaries();
  }

  /** Number of records added. */
  get count() {
    return this._count;
  }

  /** Sum of all recorded values. */
  get sum() {
    return this._sum;
  }

  /** Average of recorded values, or `0` when empty. */
  get mean() {
    return this._count === 0 ? 0 : this._sum / this._count;
  }

  /** Minimum recorded value, or `undefined` when empty. */
  get min() {
    return this._count === 0 ? undefined : this._min;
  }

  /** Maximum recorded value, or `undefined` when empty. */
  get max() {
    return this._count === 0 ? undefined : this._max;
  }

  /** Number of histogram buckets. */
  get bucketCount() {
    return this._bucketCount;
  }

  /** Reset the histogram to an empty state. */
  reset() {
    this._buckets.fill(0);
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
  }

  /**
   * Record a numeric value into the histogram.
   * @param {number} value Latency or measurement value.
   * @returns {this}
   */
  record(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new TypeError('PowerHistogram.record() requires a finite non-negative number');
    }
    const index = this._bucketIndex(n);
    this._buckets[index] += 1;
    this._count += 1;
    this._sum += n;
    if (n < this._min) this._min = n;
    if (n > this._max) this._max = n;
    return this;
  }

  /**
   * Return the estimated value for the requested percentile.
   * @param {number} quantile Percentile between `0` and `100`, or fraction between `0` and `1`.
   * @returns {number|undefined} Estimated percentile value, or `undefined` when empty.
   */
  percentile(quantile) {
    if (this._count === 0) return undefined;
    let q = Number(quantile);
    if (!Number.isFinite(q) || q < 0) {
      throw new TypeError('PowerHistogram.percentile() requires a non-negative number');
    }
    if (q <= 1) q *= 100;
    q = Math.min(100, q);
    if (q === 0) return this.min;

    const target = (q / 100) * this._count;
    let cumulative = 0;

    for (let i = 0; i < this._bucketCount; i += 1) {
      cumulative += this._buckets[i];
      if (cumulative >= target) {
        return this._estimateBucketValue(i);
      }
    }

    return this._estimateBucketValue(this._bucketCount - 1);
  }

  /**
   * Return a snapshot copy of bucket counts.
   * @returns {Array<number>}
   */
  snapshot() {
    return Array.from(this._buckets);
  }

  _buildBoundaries() {
    const boundaryMin =
      this._minValue > 0
        ? this._minValue
        : Math.max(Number.EPSILON, this._maxValue / Math.exp(this._bucketCount - 2));
    this._boundaries = new Float64Array(this._bucketCount - 1);
    const span = Math.log(this._maxValue / boundaryMin);
    const step = span / (this._bucketCount - 2);
    this._boundaries[0] = boundaryMin;
    for (let i = 1; i < this._bucketCount - 1; i += 1) {
      this._boundaries[i] = boundaryMin * Math.exp(step * i);
    }
  }

  _bucketIndex(value) {
    if (value < this._boundaries[0]) return 0;

    let low = 1;
    let high = this._boundaries.length - 1;

    while (low <= high) {
      const mid = low + ((high - low) >> 1);
      if (value < this._boundaries[mid]) high = mid - 1;
      else low = mid + 1;
    }

    if (low < this._boundaries.length) return low;
    return this._bucketCount - 1;
  }

  _estimateBucketValue(index) {
    if (index === 0) return this._minValue === 0 ? 0 : this._boundaries[0] / 2;
    const lower = this._boundaries[index - 1];
    if (index >= this._bucketCount - 1) {
      return lower * 2;
    }
    const upper = this._boundaries[index];
    return Math.sqrt(lower * upper);
  }
}

export default PowerHistogram;
