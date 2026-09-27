/**
 * Lock-free in-process histogram for latency telemetry and percentile estimation.
 *
 * Use `PowerHistogram` to record latency values and query estimated
 * percentiles.
 *
 * ## Storage: DDSketch
 *
 * The sketch is a [DDSketch](https://dl.acm.org/doi/10.14778/3361349.3361381)
 * (Masson, Rim & Lee, *PVLDB* 12(12):2195-2205, 2019) - the format
 * OpenTelemetry uses for its own histogram aggregator. Each positive value
 * `v` is mapped to a logarithmic bucket index
 *
 * ```
 * index(v) = ceil( ln(v) / ln(gamma) ),   gamma = (1 + alpha) / (1 - alpha)
 * ```
 *
 * which gives a **relative** error bound of `alpha` on every quantile, for an
 * **unbounded** value range, at O(1) insertion cost. It also merges exactly,
 * so per-worker or per-shard sketches can be combined into a global histogram.
 *
 * ## Why this replaced a fixed bucket range
 *
 * The previous implementation mapped values into a fixed, dense, log-spaced
 * array covering `[minValue, maxValue]` and clamped everything outside into the
 * first/last bucket. That is silent data loss in a measuring instrument: with
 * the defaults (`maxValue = 10000`) a histogram containing 99 samples of 1 ms
 * and one sample of 1e8 ms reported `p99.9 = 20000` - a 5000x under-report,
 * with no warning. A latency SLO built on that number is wrong, and nothing in
 * the API said so.
 *
 * `maxValue` is still accepted, but it is now only an **advisory** bound used
 * for reporting (`outOfRangeCount`), never for storage.
 *
 * @class PowerHistogram
 * @public
 */
import { DEFAULT_HISTOGRAM_RELATIVE_ACCURACY, DEFAULT_HISTOGRAM_MAX_VALUE } from './constants.js';

export class PowerHistogram {
  /**
   * @param {Object} [options]
   * @param {number} [options.relativeAccuracy=0.01] Target relative error for
   *   every quantile, in `(0, 1)`. `0.01` is 1%. Smaller is more accurate and
   *   uses more buckets.
   * @param {number} [options.maxValue=10000] Advisory upper bound. Values above
   *   this are still stored faithfully in their own bucket; they are only
   *   counted in `outOfRangeCount` so a caller can alert on a broken range.
   * @param {number} [options.minValue=0] Advisory lower bound, counted in
   *   `belowRangeCount`.
   * @param {number} [options.bucketCount] Legacy option, retained so existing
   *   constructor calls keep working. It no longer sizes a dense array - read
   *   the `bucketCount` getter for the number of *occupied* buckets.
   */
  constructor(options = {}) {
    const {
      relativeAccuracy = DEFAULT_HISTOGRAM_RELATIVE_ACCURACY,
      maxValue = DEFAULT_HISTOGRAM_MAX_VALUE,
      minValue = 0,
      bucketCount,
    } = options || {};

    const alpha = Number(relativeAccuracy);
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
      throw new TypeError(
        'PowerHistogram: `relativeAccuracy` must be a number in (0, 1) exclusive'
      );
    }
    this._alpha = alpha;
    this._gamma = (1 + alpha) / (1 - alpha);
    this._logGamma = Math.log(this._gamma);

    this._minValue = Number.isFinite(Number(minValue)) ? Math.max(0, Number(minValue)) : 0;
    this._maxValue = Number.isFinite(Number(maxValue)) ? Number(maxValue) : Infinity;
    // `bucketCount` is accepted for backwards compatibility only. Keep it so a
    // caller reading the option back is not surprised by `undefined`.
    this._legacyBucketCount = Number.isFinite(Number(bucketCount))
      ? Math.max(4, Math.floor(Number(bucketCount)))
      : null;

    /** @type {Map<number, number>} sparse bucket index -> count */
    this._buckets = new Map();
    this._zeroCount = 0;
    this._infCount = 0;
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._outOfRangeCount = 0;
    this._belowRangeCount = 0;
    // Cached sorted index list, rebuilt only when the bucket set changes.
    this._sortedIndices = null;
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

  /**
   * Configured relative error bound for quantiles.
   * @returns {number}
   */
  get relativeAccuracy() {
    return this._alpha;
  }

  /**
   * Number of *occupied* buckets. The legacy option of the same name sized a
   * dense array; with sparse DDSketch storage this reports what is actually in
   * use, which is the useful number.
   * @returns {number}
   */
  get bucketCount() {
    return this._buckets.size;
  }

  /**
   * Number of records that fell above the advisory `maxValue`. These are
   * stored faithfully - this counter exists so a caller can notice a range that
   * no longer matches reality instead of silently reading clamped data.
   * @returns {number}
   */
  get outOfRangeCount() {
    return this._outOfRangeCount;
  }

  /**
   * Number of records below the advisory `minValue`.
   * @returns {number}
   */
  get belowRangeCount() {
    return this._belowRangeCount;
  }

  /** Reset the histogram to an empty state. */
  reset() {
    this._buckets.clear();
    this._zeroCount = 0;
    this._infCount = 0;
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._outOfRangeCount = 0;
    this._belowRangeCount = 0;
    this._sortedIndices = null;
  }

  /**
   * Record a numeric value into the histogram.
   * @param {number} value Latency or measurement value. Must be finite and
   *   non-negative.
   * @returns {this}
   */
  record(value) {
    const n = Number(value);
    if (Number.isNaN(n) || n < 0) {
      throw new TypeError('PowerHistogram.record() requires a finite non-negative number');
    }
    this._count += 1;
    if (n === 0) {
      this._zeroCount += 1;
      this._sum += 0;
      if (0 < this._min) this._min = 0;
      return this;
    }
    if (n === Number.POSITIVE_INFINITY) {
      this._infCount += 1;
      return this;
    }
    this._sum += n;
    if (n < this._min) this._min = n;
    if (n > this._max) this._max = n;
    if (n > this._maxValue) this._outOfRangeCount += 1;
    else if (n < this._minValue) this._belowRangeCount += 1;

    const index = this._index(n);
    this._buckets.set(index, (this._buckets.get(index) || 0) + 1);
    this._sortedIndices = null;
    return this;
  }

  /**
   * Return the estimated value for the requested percentile.
   *
   * The estimate is guaranteed to be within `relativeAccuracy` of the true
   * quantile, for any value range.
   *
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
    const sorted = this._sortedIndexList();

    // Zero bucket first, then indexed buckets in ascending order, then +Inf.
    if (this._zeroCount > 0) {
      if (target <= this._zeroCount) return 0;
    }
    let cumulative = this._zeroCount;
    for (let i = 0; i < sorted.length; i += 1) {
      cumulative += this._buckets.get(sorted[i]);
      if (cumulative >= target) return this._clamp(this._value(sorted[i]));
    }
    if (this._infCount > 0) return Number.POSITIVE_INFINITY;
    // Unreachable for a target <= count, but keep a defined return.
    return this._max;
  }

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
  _clamp(value) {
    if (this._count === 0) return value;
    if (value < this._min) return this._min;
    if (value > this._max) return this._max;
    return value;
  }

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
  merge(other) {
    if (!(other instanceof PowerHistogram)) {
      throw new TypeError('PowerHistogram.merge() expects a PowerHistogram');
    }
    if (other._alpha !== this._alpha) {
      throw new TypeError(
        `PowerHistogram.merge(): relativeAccuracy mismatch (${this._alpha} vs ${other._alpha}). ` +
          'Bucket indices are only comparable within the same accuracy.'
      );
    }
    for (const [index, n] of other._buckets) {
      this._buckets.set(index, (this._buckets.get(index) || 0) + n);
    }
    this._zeroCount += other._zeroCount;
    this._infCount += other._infCount;
    this._count += other._count;
    this._sum += other._sum;
    this._outOfRangeCount += other._outOfRangeCount;
    this._belowRangeCount += other._belowRangeCount;
    if (other._count > 0) {
      if (other._min < this._min) this._min = other._min;
      if (other._max > this._max) this._max = other._max;
    }
    this._sortedIndices = null;
    return this;
  }

  /**
   * Return a snapshot copy of bucket counts, ordered from the lowest occupied
   * bucket to the highest.
   *
   * The array spans only the *occupied* range, so its length is
   * `bucketCount`-1 at most; a single leading entry is the zero bucket.
   * @returns {Array<number>}
   */
  snapshot() {
    const sorted = this._sortedIndexList();
    const counts = [this._zeroCount];
    for (let i = 0; i < sorted.length; i += 1) counts.push(this._buckets.get(sorted[i]));
    // The +Infinity bucket is *appended*. It used to be written into the last
    // slot, which silently clobbered a real bucket whenever the sketch held
    // both a +Inf and an indexed value.
    if (this._infCount > 0) counts.push(this._infCount);
    return counts;
  }

  /**
   * Serializable representation, suitable for merging elsewhere or shipping to
   * a metrics backend.
   * @returns {{relativeAccuracy:number, count:number, sum:number, min:number, max:number, zeroCount:number, infCount:number, outOfRangeCount:number, belowRangeCount:number, buckets:Array<[number, number]>}}
   */
  toJSON() {
    return {
      relativeAccuracy: this._alpha,
      count: this._count,
      sum: this._sum,
      min: this._count === 0 ? null : this._min,
      max: this._count === 0 ? null : this._max,
      zeroCount: this._zeroCount,
      infCount: this._infCount,
      outOfRangeCount: this._outOfRangeCount,
      belowRangeCount: this._belowRangeCount,
      buckets: Array.from(this._buckets.entries()).sort((a, b) => a[0] - b[0]),
    };
  }

  /**
   * Bucket index for a strictly positive, finite value.
   * @param {number} v
   * @returns {number}
   * @private
   */
  _index(v) {
    return Math.ceil(Math.log(v) / this._logGamma);
  }

  /**
   * Representative value for a bucket index. This is the midpoint of the
   * bucket's multiplicative range, so the worst-case relative error against
   * any value in the bucket is bounded by `relativeAccuracy`.
   * @param {number} index
   * @returns {number}
   * @private
   */
  _value(index) {
    return (2 * Math.pow(this._gamma, index)) / (1 + this._gamma);
  }

  /**
   * Ascending list of occupied bucket indices, cached until the bucket set
   * changes.
   * @returns {number[]}
   * @private
   */
  _sortedIndexList() {
    if (this._sortedIndices === null) {
      this._sortedIndices = Array.from(this._buckets.keys()).sort((a, b) => a - b);
    }
    return this._sortedIndices;
  }
}

export default PowerHistogram;
