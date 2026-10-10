import { describe, it, expect } from 'vitest';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

/**
 * `countAtOrBelow()` — the rank query, and the inverse of `percentile()`.
 *
 * `percentile(q)` maps a rank to a value. This maps a value to a rank, which is
 * the question "what fraction of my requests were under X" — the most common
 * latency question after percentiles, and the one the sketch could not answer at
 * all before this existed.
 *
 * Two things are pinned here that are easy to get wrong and invisible when they
 * are:
 *
 * 1. **The cache.** The answer is O(log b) over a cached `{indices, prefix}`
 *    order. That cache is invalidated in four places, and a missed one produces
 *    a stale answer that is *correct for the data as it was* — so it passes
 *    every test that queries once and checks the number. The
 *    record/merge/reset-after-query tests are the ones that catch it.
 * 2. **The accuracy bound.** The estimate is bounded by the mass in the bucket
 *    the threshold lands in, and by nothing else. That is the whole guarantee,
 *    it is what makes the method honest rather than merely useful, and it is
 *    asserted as a property rather than as a number, because the number moves
 *    with the distribution.
 *
 * ## Why the exact assertions use `relativeAccuracy: 0.5`
 *
 * That makes `gamma` exactly 3, and `Math.log(3) / Math.log(3)` is exactly `1`
 * in IEEE754, so the values 1 and 3 land precisely on bucket edges and a
 * threshold on an edge is counted exactly. With the default 1% accuracy a
 * threshold almost never lands on an edge, and the boundary bucket is
 * interpolated by design — so an exact assertion there would be pinning a
 * floating-point accident rather than a behaviour.
 */
describe('PowerHistogram.countAtOrBelow()', () => {
  /**
   * `gamma` is exactly 3, so bucket edges are 1 and 3 and both are occupied.
   * Fully determined: every number asserted against this fixture below was
   * read off the implementation and checked by hand.
   *
   * @returns {PowerHistogram} One observation of 1 and one of 3.
   */
  function onEdge() {
    const h = new PowerHistogram({ relativeAccuracy: 0.5 });
    h.record(1);
    h.record(3);
    return h;
  }

  /** Two observations far enough apart to be in unrelated buckets. */
  function farApart() {
    const h = new PowerHistogram();
    h.record(1);
    h.record(1000);
    return h;
  }

  describe('it is the inverse of percentile()', () => {
    it('round-trips a quantile back to its own rank', () => {
      // The property a consumer actually relies on: ask for p90, get a value,
      // ask how many samples are at or below that value, and get ~90% back.
      const h = new PowerHistogram({ relativeAccuracy: 0.01 });
      for (let i = 0; i < 20_000; i++) h.record(10 ** ((i % 1000) / 250));
      for (const q of [10, 50, 90, 99]) {
        const value = h.percentile(q);
        const rank = (h.countAtOrBelow(value) / h.count) * 100;
        // Within the sketch's own relative accuracy, which is the strongest
        // claim the round trip can make.
        expect(Math.abs(rank - q)).toBeLessThan(1);
      }
    });

    it('counts whole buckets exactly when the threshold clears them', () => {
      // 1 and 1000 are in unrelated buckets, so a threshold between them counts
      // the one below and none of the one above, with no boundary bucket to
      // interpolate.
      expect(farApart().countAtOrBelow(100)).toBe(1);
      expect(farApart().countAtOrBelow(5000)).toBe(2);
      expect(farApart().countAtOrBelow(0.5)).toBe(0);
    });
  });

  describe('the boundary is inclusive', () => {
    it('counts a sample sitting exactly on the threshold', () => {
      // The class APDEX calls "satisfied" is `<= T`. The name is
      // `countAtOrBelow` rather than `countBelow` because `belowRangeCount`
      // already means *strictly* below in this class, and a method whose name
      // says one thing while its boundary does another is how an off-by-one
      // reaches an SLO.
      const h = onEdge();
      expect(h.countAtOrBelow(3)).toBe(2); // the 3 is counted, whole
      expect(h.countAtOrBelow(1)).toBe(1); // and so is the 1
    });

    it('does not count a sample the threshold has not reached', () => {
      // 1.5 is inside the bucket holding the 3, so that sample is only
      // partially counted — the interpolation, working as documented.
      const h = onEdge();
      expect(h.countAtOrBelow(1.5)).toBeGreaterThan(1);
      expect(h.countAtOrBelow(1.5)).toBeLessThan(2);
      expect(h.countAtOrBelow(0.5)).toBeLessThan(1);
    });

    it('is monotonic and never leaves [0, count]', () => {
      const h = onEdge();
      let previous = -1;
      for (let t = 0; t <= 10; t += 0.05) {
        const c = h.countAtOrBelow(t);
        expect(c).toBeGreaterThanOrEqual(previous);
        expect(c).toBeLessThanOrEqual(h.count);
        previous = c;
      }
    });
  });

  describe('edge cases', () => {
    it('returns 0 for an empty sketch', () => {
      expect(new PowerHistogram().countAtOrBelow(10)).toBe(0);
    });

    it('returns 0 for a negative threshold', () => {
      // `record()` refuses negative values, so nothing recorded can be at or
      // below one. Returning 0 is the answer, not an error.
      expect(onEdge().countAtOrBelow(-1)).toBe(0);
    });

    it('counts exact zeros at or below zero, and below everything positive', () => {
      // Zeros are the one class with no bucket of their own in the index
      // space, so they are handled before the bucket walk rather than inside it.
      const h = new PowerHistogram({ relativeAccuracy: 0.5 });
      h.record(0);
      h.record(0);
      h.record(3);
      expect(h.countAtOrBelow(0)).toBe(2);
      expect(h.countAtOrBelow(0.5)).toBe(2);
      expect(h.countAtOrBelow(3)).toBe(3);
    });

    it('excludes +Infinity from a finite threshold and includes it at Infinity', () => {
      // A `+Infinity` record is never at or below a finite value. This is what
      // makes `PowerApdex.record(Infinity)` land in *frustrated* rather than
      // being silently dropped from the denominator.
      const h = new PowerHistogram({ relativeAccuracy: 0.5 });
      h.record(0);
      h.record(0);
      h.record(3);
      h.record(Number.POSITIVE_INFINITY);
      expect(h.count).toBe(4);
      expect(h.countAtOrBelow(1e9)).toBe(3);
      expect(h.countAtOrBelow(Number.POSITIVE_INFINITY)).toBe(4);
    });

    it('throws on NaN, the way percentile() does', () => {
      expect(() => onEdge().countAtOrBelow(NaN)).toThrow(TypeError);
    });

    it('is not an integer when the threshold lands mid-bucket', () => {
      // Documented, and deliberately not rounded: rounding would bias every
      // threshold that lands mid-bucket in the same direction.
      const h = new PowerHistogram({ relativeAccuracy: 0.1 });
      for (let i = 0; i < 100; i++) h.record(1000);
      const c = h.countAtOrBelow(1005);
      expect(Number.isInteger(c)).toBe(false);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(100);
    });
  });

  describe('the cache is invalidated everywhere it must be', () => {
    it('reflects a record taken after a query', () => {
      // **The regression test for the `_order` cache.** A stale cache answers
      // correctly for the data as it was, so a test that queries once and
      // checks the number cannot tell the difference.
      const h = onEdge();
      expect(h.countAtOrBelow(3)).toBe(2);
      h.record(3);
      expect(h.countAtOrBelow(3)).toBe(3);
      expect(h.count).toBe(3);
    });

    it('reflects a merge taken after a query', () => {
      const a = onEdge();
      const b = onEdge();
      expect(a.countAtOrBelow(3)).toBe(2);
      a.merge(b);
      expect(a.countAtOrBelow(3)).toBe(4);
      expect(a.count).toBe(4);
    });

    it('reflects a reset taken after a query', () => {
      const h = onEdge();
      expect(h.countAtOrBelow(3)).toBe(2);
      h.reset();
      expect(h.countAtOrBelow(3)).toBe(0);
      h.record(3);
      expect(h.countAtOrBelow(3)).toBe(1);
    });

    it('keeps percentile() and countAtOrBelow() agreeing through all three', () => {
      // The two share one cache. If they ever disagree about the order, this is
      // where it shows up first.
      const h = onEdge();
      h.record(3);
      h.merge(onEdge());
      h.reset();
      for (let i = 1; i <= 30; i++) h.record(i * 3);
      const p50 = h.percentile(50);
      expect(h.countAtOrBelow(p50) / h.count).toBeCloseTo(0.5, 1);
    });
  });

  describe('the accuracy bound is the mass in the boundary bucket', () => {
    /**
     * The count in the bucket a threshold lands in — the only mass the estimate
     * can be wrong by, because every other bucket is counted whole or not at
     * all.
     *
     * Reaches into `_buckets`/`_index` deliberately: the bound is a property of
     * the storage layout, and there is no public accessor for "the mass in the
     * bucket containing X". Asserting the property rather than a number is what
     * makes this test survive a change to the interpolation.
     *
     * @param {PowerHistogram} h
     * @param {number} t
     * @returns {number}
     */
    function boundaryMass(h, t) {
      return h._buckets.get(h._index(t)) || 0;
    }

    it('holds on a spread distribution', () => {
      const h = new PowerHistogram({ relativeAccuracy: 0.01 });
      const values = [];
      for (let i = 0; i < 20_000; i++) values.push(10 ** ((i % 977) / 200));
      for (const v of values) h.record(v);
      for (const t of [1, 3, 10, 30, 100, 300, 1000]) {
        const truth = values.filter((v) => v <= t).length;
        const est = h.countAtOrBelow(t);
        expect(Math.abs(est - truth)).toBeLessThanOrEqual(boundaryMass(h, t));
      }
    });

    it('is tight enough to be useful, and loose enough to be honest', () => {
      // The same spread distribution, now asserting the *size* of the error
      // rather than only its bound. Under a tenth of a percent of the sample
      // count, which in APDEX terms is under a thousandth of the score — below
      // the resolution APDEX is quoted at, and the reason the derived score is
      // worth having at all for a spread distribution.
      const h = new PowerHistogram({ relativeAccuracy: 0.01 });
      const values = [];
      for (let i = 0; i < 20_000; i++) values.push(10 ** ((i % 977) / 200));
      for (const v of values) h.record(v);
      for (const t of [1, 3, 10, 30, 100, 300, 1000]) {
        const truth = values.filter((v) => v <= t).length;
        expect(Math.abs(h.countAtOrBelow(t) - truth) / values.length).toBeLessThan(0.001);
      }
    });

    it('is the reason a score cannot be derived from a sketch', () => {
      // **A characterisation, not an aspiration.** This pins a *loss*, and it
      // says so: when the mass concentrates inside one bucket straddling the
      // threshold, the estimate is wrong by most of that bucket and no value of
      // `relativeAccuracy` repairs it. `bench/claims.js apdex` measures the
      // consequence — a derived APDEX of 0.625 against a truth of 0.950 — and
      // that measurement is why `PowerApdex` keeps integer counters instead of
      // calling this method twice.
      //
      // If a future change makes this exact, this test fails and that is the
      // correct outcome: it would mean the bound above no longer describes the
      // implementation, and both should be revisited together.
      const h = new PowerHistogram({ relativeAccuracy: 0.01 });
      for (let i = 0; i < 1000; i++) h.record(i < 900 ? 99.5 : 100.5);
      const truth = 900;
      const est = h.countAtOrBelow(100);
      expect(est).not.toBe(truth);
      // ...and it is still inside the bound, which is the part that holds.
      expect(Math.abs(est - truth)).toBeLessThanOrEqual(boundaryMass(h, 100));
    });

    it('under-counts a point mass sitting exactly on the threshold', () => {
      // The realistic version of the case above, and the one worth pinning
      // separately because it does not look adversarial: a service whose
      // latency is a fixed cost, with the SLO set at that cost. Every one of
      // the 1000 samples is at exactly 100 ms and every one of them is
      // satisfied, but the sketch cannot tell a point mass at 100 from a spread
      // across the bucket containing it, so it reports a quarter of them.
      //
      // This is the failure `PowerApdex` exists to avoid, and it is why the
      // guide tells a reader to reach for counters rather than a rank query
      // when the number is an SLO attainment figure.
      const h = new PowerHistogram();
      for (let i = 0; i < 1000; i++) h.record(100);
      expect(h.countAtOrBelow(100)).toBeLessThan(500);
      expect(h.countAtOrBelow(100)).toBeGreaterThan(0);
      // The bound still holds, and it is the whole bucket.
      expect(Math.abs(h.countAtOrBelow(100) - 1000)).toBeLessThanOrEqual(boundaryMass(h, 100));
    });
  });
});
