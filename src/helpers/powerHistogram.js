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
 * ## Non-negative values only
 *
 * `record()` refuses a negative with a `TypeError`. DDSketch's sign-magnitude
 * bucket mapping would accept one, and this is a **scope decision rather than an
 * omission** — see {@link PowerHistogram#record} for the three reasons, the
 * loudness of the guard, and what to do instead. `PowerApdex.record()` carries
 * the same guard, so the constraint is consistent across the library.
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

/**
 * Whether `v` is a histogram sketch in either of its two shapes.
 *
 * **Structural, not `instanceof`, and that is the whole point** (AUD-012).
 * `instanceof` compares against *this realm's* prototype, so it is `false` for a
 * value from another `vm` context, an iframe, or a `worker_threads` sandbox —
 * and `structuredClone` does not preserve the class at all, so a sketch that
 * crossed a worker boundary is a plain object that was never an instance of
 * anything. Both are legitimate inputs, so the test is on the fields.
 *
 * There are **two shapes**, and confusing them is the bug this replaces: an
 * instance carries the private field names (`_alpha`, `_count`) with `buckets` as
 * a `Map`, while a `toJSON()` result carries the public names
 * (`relativeAccuracy`, `count`) with `buckets` as an array of pairs. Checking
 * only one shape silently rejects the other.
 *
 * A `Symbol.toStringTag` spoof is not accepted, because the check reads real
 * properties rather than a tag — the same reason `powerBuffer.isArrayBuffer`
 * uses the spec's own accessor.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isHistogramSketch(v) {
  if (!v || typeof v !== 'object') return false;
  const s = /** @type {any} */ (v);
  const instanceShape =
    typeof s._alpha === 'number' &&
    typeof s._count === 'number' &&
    typeof s._zeroCount === 'number' &&
    typeof s._infCount === 'number' &&
    typeof s._sum === 'number' &&
    isBucketIterable(s._buckets);
  const jsonShape =
    typeof s.relativeAccuracy === 'number' &&
    typeof s.count === 'number' &&
    typeof s.zeroCount === 'number' &&
    typeof s.infCount === 'number' &&
    typeof s.sum === 'number' &&
    isBucketIterable(s.buckets);
  return instanceShape || jsonShape;
}

/**
 * Whether `b` can be iterated as `[index, count]` pairs.
 *
 * **Iterability, not `instanceof Map` or `Array.isArray`** — and that is the
 * cross-realm rule applied to a container rather than to a buffer. A `Map` from
 * another `vm` context is not an instance of *this* realm's `Map`, so
 * `instanceof Map` rejects a genuinely cross-realm instance, which is one of the
 * two shapes this whole path exists to accept. `Symbol.iterator` is a well-known
 * symbol shared by every realm, so testing for it is realm-independent.
 *
 * It is also exactly the property the merge loop needs: both a `Map` and an array
 * of pairs yield `[index, count]`, and nothing else about the container is read.
 *
 * @param {unknown} b
 * @returns {boolean}
 */
function isBucketIterable(b) {
  return (
    !!b && typeof b === 'object' && typeof (/** @type {any} */ (b)[Symbol.iterator]) === 'function'
  );
}

/**
 * Normalise either sketch shape into the field names {@link
 * PowerHistogram#merge} reads.
 *
 * One mapping rather than two, because the alternative is a `merge()` that
 * branches on shape at every field — and a branch that is wrong once is wrong
 * everywhere. `buckets` is passed through as-is: both a `Map` and an array of
 * pairs are iterable of `[index, count]`, which is all the merge loop needs.
 *
 * @param {any} v - Already validated by {@link isHistogramSketch}.
 * @returns {{alpha:number, count:number, sum:number, min:number, max:number,
 *   zeroCount:number, infCount:number, outOfRangeCount:number,
 *   belowRangeCount:number, buckets:Iterable<[number, number]>}}
 */
function sketchFields(v) {
  if (typeof v._alpha === 'number') {
    return {
      alpha: v._alpha,
      count: v._count,
      // AUD-029. `v.sum`, the getter, not `v._sum`. On an instance the getter
      // returns the compensated pair while `_sum` is only the raw accumulator, so
      // reading the private field would drop the other sketch's compensation
      // during a merge. On a `toJSON()` result `sum` is the stored total, which
      // is the same thing — so one expression serves both shapes.
      sum: v.sum,
      min: v._min,
      max: v._max,
      zeroCount: v._zeroCount,
      infCount: v._infCount,
      outOfRangeCount: v._outOfRangeCount,
      belowRangeCount: v._belowRangeCount,
      buckets: v._buckets,
    };
  }
  return {
    alpha: v.relativeAccuracy,
    count: v.count,
    sum: v.sum,
    // `toJSON()` writes `null` for an empty sketch's bounds, where the internal
    // representation uses the infinities. Round-tripping must not turn an empty
    // min into `null` and then compare `null < this._min` as true.
    min: v.min === null ? Number.POSITIVE_INFINITY : v.min,
    max: v.max === null ? Number.NEGATIVE_INFINITY : v.max,
    zeroCount: v.zeroCount,
    infCount: v.infCount,
    outOfRangeCount: v.outOfRangeCount,
    belowRangeCount: v.belowRangeCount,
    buckets: v.buckets,
  };
}

/**
 * Whether the legacy-`bucketCount` warning has already been emitted.
 *
 * Module-level rather than per-instance, and deliberately so: the warning is
 * about the *option*, which does not change between instances, so a caller
 * constructing a histogram per request would otherwise fill stderr with the same
 * sentence. One per process is the right dose — enough to be seen, not enough to
 * be noise.
 *
 * @type {boolean}
 */
let _warnedLegacyBucketCount = false;

/**
 * Emit the legacy-`bucketCount` warning through whichever channel exists.
 *
 * `console.warn` when there is one, and nothing when there is not — a library
 * must not throw for a deprecated option it has already accepted, and must not
 * crash in an environment without a console. The message names the option that
 * *does* control precision, because a warning that says only "ignored" leaves the
 * caller to guess.
 *
 * @param {number} value The value the caller passed.
 * @returns {void}
 */
function warnLegacyBucketCount(value) {
  const message =
    `PowerHistogram: \`bucketCount: ${value}\` is accepted for backwards compatibility ` +
    'and ignored. Precision is controlled by `relativeAccuracy` (default ' +
    `${DEFAULT_HISTOGRAM_RELATIVE_ACCURACY}); a smaller value means more buckets. ` +
    'Setting both would make `relativeAccuracy` win, so `bucketCount` is not mapped to it.';
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(message);
  }
}

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
    // AUD-040. **Warn once, on first use, rather than silently ignoring it.**
    //
    // A caller who sets `bucketCount: 1000` believing it controls precision was
    // ignored without a word: the option is stored, read back faithfully, and
    // does nothing. That is the worst shape a dead option can take, because
    // reading it back *confirms* the caller's belief — the value round-trips, so
    // it looks honoured.
    //
    // Honouring it was the alternative, and it was rejected: `bucketCount` and
    // `relativeAccuracy` are two spellings of the same knob (alpha fixes the
    // relative error, which fixes the bucket density), so mapping one to the
    // other would silently override an explicitly-passed `relativeAccuracy`
    // whenever both were set. A warning changes nothing and tells the truth.
    //
    // Once per process, not per instance: a caller constructing a histogram per
    // request would otherwise fill stderr, and the message is about the *option*,
    // which does not change between instances.
    if (this._legacyBucketCount !== null && !_warnedLegacyBucketCount) {
      _warnedLegacyBucketCount = true;
      warnLegacyBucketCount(this._legacyBucketCount);
    }

    /** @type {Map<number, number>} sparse bucket index -> count */
    this._buckets = new Map();
    this._zeroCount = 0;
    this._infCount = 0;
    this._count = 0;
    this._sum = 0;
    // AUD-029. The rounding error `_sum` could not represent, kept separately so
    // the `sum` getter can return the pair. See `_addToSum`.
    this._sumCompensation = 0;
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
  _addToSum(n) {
    const t = this._sum + n;
    // The branch is which operand was larger, because that is the one whose
    // low bits the addition could not represent. Written out rather than using
    // `Math.abs` twice, since the comparison is the whole algorithm.
    if (Math.abs(this._sum) >= Math.abs(n)) {
      this._sumCompensation += this._sum - t + n;
    } else {
      this._sumCompensation += n - t + this._sum;
    }
    this._sum = t;
  }

  /** Number of records added. */
  get count() {
    return this._count;
  }

  /** Sum of all recorded values. */
  get sum() {
    // AUD-029. The compensated total, not the raw accumulator. See
    // `_addToSum` for why the two differ and why the naive `+=` was wrong.
    return this._sum + this._sumCompensation;
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
    // The compensated total, for the same reason the `sum` getter returns it: a
    // mean over a set with mixed magnitudes is exactly where the naive
    // accumulator's error shows up as a wrong number rather than a rounding
    // artefact.
    return this.sum / valued;
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
    // AUD-029. Both halves, or a cleared histogram keeps the rounding error of
    // the values it just dropped and reports a non-zero `sum` while empty.
    this._sumCompensation = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._outOfRangeCount = 0;
    this._belowRangeCount = 0;
    this._order = null;
  }

  /**
   * Record a numeric value into the histogram.
   *
   * **Non-negative only, and that is a deliberate scope decision rather than an
   * oversight** (AUD-042). DDSketch's sign-magnitude bucket mapping would handle
   * negatives, and the audit that raised this suggested adopting it. It was
   * rejected, for three reasons:
   *
   * 1. **Every caller in this library records a non-negative quantity** — RTT in
   *    `powerSocketAdapter`, `powerWebSocketClient` and `powerWebTransportClient`,
   *    event-loop delay in `powerEventLoopMonitor`, latency in `PowerApdex`. There
   *    is no internal need, so the change would be speculative surface.
   * 2. **The class is scoped to latency.** `guides/metaGuide.md` lists it as
   *    "In-process latency and percentile-style telemetry", and latency is
   *    non-negative by definition. A signed delta is a different quantity.
   * 3. **The cost lands on the quantile path.** Sign-magnitude indexing keeps the
   *    bucket order monotonic, but the exact-zero bucket moves from "below
   *    everything" to "between the negative and positive buckets" — and
   *    `percentile()`, `countAtOrBelow()` and `snapshot()` all depend on where it
   *    sits. Getting that wrong is a silent error in the one thing this class
   *    exists to answer.
   *
   * The guard is also **loud**, which is the property that makes documenting it
   * sufficient rather than a workaround: a caller who passes a negative gets an
   * immediate `TypeError` naming the fix, not a bucket of nonsense.
   *
   * `PowerApdex.record()` carries the same guard for the same reason, so the
   * constraint is consistent across the library rather than accidental here.
   *
   * @param {number} value Latency or measurement value. Must be finite and
   *   non-negative. For a signed quantity, offset it first — `record(v - baseline)`
   *   for a delta against a known baseline, or `record(Math.abs(v))` for a
   *   magnitude.
   * @returns {this}
   */
  record(value) {
    const n = Number(value);
    if (Number.isNaN(n) || n < 0) {
      throw new TypeError(
        'PowerHistogram.record() requires a finite non-negative number. ' +
          'This class is scoped to latency and other non-negative measurements; ' +
          'for a signed quantity, offset it first — record(v - baseline) for a ' +
          'delta against a known baseline, or record(Math.abs(v)) for a magnitude.'
      );
    }
    this._count += 1;
    if (n === 0) {
      this._zeroCount += 1;
      // AUD-029. Routed through the compensated add rather than a bare `+= 0`.
      // Adding zero is a genuine no-op for Neumaier — `t` equals `_sum` and the
      // compensation term gains nothing — so this is not a correctness fix, it is
      // keeping one accumulation path so a future change to `_addToSum` cannot
      // miss this branch.
      this._addToSum(0);
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
    this._addToSum(n);
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

    // Zero bucket first, then indexed buckets in ascending order, then +Inf.
    if (this._zeroCount > 0) {
      if (target <= this._zeroCount) return 0;
    }
    // AUD-015. Binary search over the cumulative counts rather than a linear
    // walk. `_bucketOrder()` already builds `prefix`, where `prefix[i]` is the
    // total count of every bucket *before* `indices[i]` — so the first bucket
    // whose cumulative count reaches `target` is the first `i` with
    // `zeroCount + prefix[i + 1] >= target`, and that is a monotone predicate
    // over a sorted array. O(log b) in occupied buckets instead of O(b), which
    // matters because a dashboard calls this on every scrape and the old cost
    // scaled with the *spread* of the data rather than with the number of
    // queries.
    //
    // The predicate is monotone because `prefix` is non-decreasing, so the
    // standard lower-bound search finds the *first* index satisfying it — the
    // same bucket the linear walk would have stopped at.
    const { indices, prefix } = this._bucketOrder();
    let lo = 0;
    let hi = indices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._zeroCount + prefix[mid + 1] >= target) hi = mid;
      else lo = mid + 1;
    }
    if (lo < indices.length) return this._clamp(this._value(indices[lo]));
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
  static fromJSON(obj) {
    if (!isHistogramSketch(obj)) {
      throw new TypeError('PowerHistogram.fromJSON() expects a toJSON() result');
    }
    const f = sketchFields(obj);
    const h = new PowerHistogram({ relativeAccuracy: f.alpha });
    h._count = f.count;
    // AUD-029. `f.sum` is the *total* — the compensated pair on an instance, the
    // stored field on a `toJSON()` result. It lands in `_sum` with the
    // compensation term left at zero, which is exact: the total is already the
    // answer, and re-deriving a split between accumulator and error from a single
    // number would be guesswork.
    h._sum = f.sum;
    h._min = f.min;
    h._max = f.max;
    h._zeroCount = f.zeroCount;
    h._infCount = f.infCount;
    h._outOfRangeCount = f.outOfRangeCount;
    h._belowRangeCount = f.belowRangeCount;
    for (const [index, n] of f.buckets) h._buckets.set(index, n);
    h._order = null;
    return h;
  }

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
  merge(other) {
    // AUD-012. Structural, not `instanceof`: a cross-realm `PowerHistogram` is
    // not an instance of *this* realm's class, and a plain sketch from
    // `structuredClone` never was. Both are legitimate inputs, so the test is on
    // the fields — and both shapes are normalised to one set of names, because a
    // `merge()` that branches per field is a branch that is wrong once and wrong
    // everywhere.
    if (!isHistogramSketch(other)) {
      throw new TypeError('PowerHistogram.merge() expects a PowerHistogram or a toJSON() result');
    }
    const src = sketchFields(other);
    if (src.alpha !== this._alpha) {
      throw new TypeError(
        `PowerHistogram.merge(): relativeAccuracy mismatch (${this._alpha} vs ${src.alpha}). ` +
          'Bucket indices are only comparable within the same accuracy.'
      );
    }
    for (const [index, n] of src.buckets) {
      this._buckets.set(index, (this._buckets.get(index) || 0) + n);
    }
    this._zeroCount += src.zeroCount;
    this._infCount += src.infCount;
    this._count += src.count;
    // AUD-029. The other sketch's *total*, through the compensated add. Reading
    // `src.sum` rather than `src._sum` is what makes this correct for an instance
    // as well as a plain sketch: `sum` is the getter returning the compensated
    // pair on an instance and the stored field on a `toJSON()` result, so both
    // shapes contribute their real total. `src._sum` would have contributed the
    // raw accumulator and silently dropped the other sketch's compensation.
    this._addToSum(src.sum);
    this._outOfRangeCount += src.outOfRangeCount;
    this._belowRangeCount += src.belowRangeCount;
    if (src.count > 0) {
      if (src.min < this._min) this._min = src.min;
      if (src.max > this._max) this._max = src.max;
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
      // AUD-029. The compensated total, not the raw accumulator — the same value
      // the `sum` getter returns. Writing `_sum` here would make the round-trip
      // lossy: `fromJSON` would restore a total that had already lost the
      // compensation, and a sketch that crossed a worker boundary would report a
      // different `sum` than the one that produced it.
      sum: this.sum,
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
