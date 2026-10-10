import { assertKnownOptions } from '../utils/options.js';
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
import {
  DEFAULT_HISTOGRAM_RELATIVE_ACCURACY,
  DEFAULT_HISTOGRAM_MAX_VALUE,
  MIN_HISTOGRAM_BUCKETS,
} from './constants.js';

/**
 * @typedef {import('./jsdoc-types.js').PowerHistogramOptions} PowerHistogramOptions
 */

export class PowerHistogram {
  /**
   * @param {PowerHistogramOptions} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      ['relativeAccuracy', 'maxValue', 'minValue', 'bucketCount'],
      'PowerHistogram'
    );
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
      ? Math.max(MIN_HISTOGRAM_BUCKETS, Math.floor(Number(bucketCount)))
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
    // Cached bucket order plus its cumulative counts, rebuilt only when the
    // bucket set changes. One cache rather than two: `percentile()` needs the
    // order and `countAtOrBelow()` needs the running totals, and two caches
    // invalidated at the same four sites are two chances to forget one.
    /** @type {{indices: number[], prefix: number[]}|null} */
    this._order = null;
  }

  /** Number of records added. */
  get count() {
    return this._count;
  }

  /** Sum of all recorded values. */
  get sum() {
    return this._sum;
  }

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
  get mean() {
    const valued = this._count - this._infCount;
    if (valued <= 0) return this._infCount > 0 ? Infinity : 0;
    return this._sum / valued;
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
    this._order = null;
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
      // `_max` is initialised to -Infinity and values are non-negative, so a
      // histogram whose every record is 0 used to keep reporting `max` of
      // `-Infinity` — a maximum below every one of its own samples, which then
      // flowed into `toJSON().max` and into the metrics series. `min` was
      // updated on this branch and `max` was not.
      if (0 > this._max) this._max = 0;
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
    this._order = null;
    return this;
  }

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
  countAtOrBelow(value) {
    const t = Number(value);
    if (Number.isNaN(t)) {
      throw new TypeError('PowerHistogram.countAtOrBelow() requires a number');
    }
    if (this._count === 0) return 0;
    if (t < 0) return 0;
    // Exact zeros are at or below every non-negative threshold, and they are
    // the one class with no bucket of their own in the index space.
    if (t === 0) return this._zeroCount;
    if (t === Number.POSITIVE_INFINITY) return this._count;

    const { indices, prefix } = this._bucketOrder();
    // The bucket a sample of exactly `t` would land in. Every occupied bucket
    // with a lower index has a maximum of `gamma^index <= gamma^(k-1) < t`, so
    // all of it is at or below `t` and counts whole.
    const k = Math.ceil(Math.log(t) / this._logGamma);
    let lo = 0;
    let hi = indices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (indices[mid] < k) lo = mid + 1;
      else hi = mid;
    }
    let total = this._zeroCount + prefix[lo];
    if (lo < indices.length && indices[lo] === k) {
      // `?? 0` rather than a bare `get()`: the guard above proves the bucket is
      // occupied, but it proves it through an array index TypeScript cannot
      // narrow through, and an unoccupied bucket's count *is* zero.
      const inBucket = this._buckets.get(k) ?? 0;
      const share = (Math.log(t) - (k - 1) * this._logGamma) / this._logGamma;
      total += inBucket * Math.min(1, Math.max(0, share));
    }
    return total;
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
    this._order = null;
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
    return this._bucketOrder().indices;
  }

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
  _bucketOrder() {
    if (this._order === null) {
      const indices = Array.from(this._buckets.keys()).sort((a, b) => a - b);
      const prefix = new Array(indices.length + 1);
      prefix[0] = 0;
      for (let i = 0; i < indices.length; i += 1) {
        prefix[i + 1] = prefix[i] + this._buckets.get(indices[i]);
      }
      this._order = { indices, prefix };
    }
    return this._order;
  }
}

export default PowerHistogram;
