import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

describe('PowerHistogram', () => {
  it('records values and computes basic statistics', () => {
    const hist = new PowerHistogram({ minValue: 1, maxValue: 1000, bucketCount: 16 });
    hist.record(1);
    hist.record(2);
    hist.record(4);
    hist.record(8);
    hist.record(16);

    expect(hist.count).toBe(5);
    expect(hist.sum).toBe(31);
    expect(hist.mean).toBe(31 / 5);
    expect(hist.min).toBe(1);
    expect(hist.max).toBe(16);
  });

  it('returns approximate percentiles', () => {
    const hist = new PowerHistogram({ minValue: 1, maxValue: 256, bucketCount: 64 });
    for (let i = 1; i <= 100; i += 1) {
      hist.record(i);
    }

    expect(hist.percentile(50)).toBeGreaterThanOrEqual(35);
    expect(hist.percentile(50)).toBeLessThanOrEqual(65);
    expect(hist.percentile(90)).toBeGreaterThanOrEqual(80);
    expect(hist.percentile(90)).toBeLessThanOrEqual(110);
  });

  it('accepts fractional quantiles', () => {
    const hist = new PowerHistogram({ minValue: 1, maxValue: 1000, bucketCount: 16 });
    hist.record(10);
    hist.record(20);
    hist.record(30);

    expect(hist.percentile(0.5)).toBeGreaterThanOrEqual(10);
    expect(hist.percentile(0.5)).toBeLessThanOrEqual(30);
  });

  it('resets the histogram state', () => {
    const hist = new PowerHistogram();
    hist.record(5);
    hist.reset();

    expect(hist.count).toBe(0);
    expect(hist.sum).toBe(0);
    expect(hist.min).toBeUndefined();
    expect(hist.max).toBeUndefined();
    expect(hist.percentile(50)).toBeUndefined();
  });

  it('throws for invalid values', () => {
    const hist = new PowerHistogram();
    expect(() => hist.record(-1)).toThrow(TypeError);
    expect(() => hist.record(Number.NaN)).toThrow(TypeError);
    hist.record(1);
    expect(() => hist.percentile(-5)).toThrow(TypeError);
  });

  it('keeps percentile estimates meaningful when minValue is zero', () => {
    const hist = new PowerHistogram({ minValue: 0, maxValue: 100, bucketCount: 16 });
    hist.record(1);
    hist.record(5);
    hist.record(20);
    const nonEmptyBuckets = hist.snapshot().filter((count) => count > 0);

    expect(nonEmptyBuckets.length).toBeGreaterThan(1);
    expect(hist.percentile(50)).toBeGreaterThan(0);
    expect(hist.percentile(50)).toBeLessThan(100);
  });
});

// --- AUD-012: the documented cross-worker merge path ------------------------

describe('PowerHistogram cross-boundary merge (AUD-012)', () => {
  it('round-trips through toJSON/fromJSON', () => {
    // The class doc advertises exact merging of per-worker sketches, and
    // `toJSON()` has always existed — but there was no `fromJSON()`, so the
    // advertised path had no way back in.
    const a = new PowerHistogram({ relativeAccuracy: 0.01 });
    for (let i = 1; i <= 100; i++) a.record(i);
    a.record(0);
    a.record(Number.POSITIVE_INFINITY);

    const b = PowerHistogram.fromJSON(a.toJSON());

    expect(b.count).toBe(a.count);
    expect(b.sum).toBe(a.sum);
    expect(b.min).toBe(a.min);
    expect(b.max).toBe(a.max);
    expect(b.percentile(50)).toBeCloseTo(a.percentile(50), 10);
    expect(b.percentile(99)).toBeCloseTo(a.percentile(99), 10);
    expect(b.toJSON()).toEqual(a.toJSON());
  });

  it('merges a plain sketch, which is what structuredClone produces', () => {
    // The defect. `structuredClone` does not preserve the class, so a sketch
    // arriving from a worker is a plain object — and `merge()` rejected it with
    // "expects a PowerHistogram". The headline distributed use case was
    // unreachable without hand-rolling reconstruction.
    const a = new PowerHistogram({ relativeAccuracy: 0.01 });
    const b = new PowerHistogram({ relativeAccuracy: 0.01 });
    for (let i = 1; i <= 50; i++) a.record(i);
    for (let i = 51; i <= 100; i++) b.record(i);

    // Exactly what a worker postMessage would deliver.
    const plain = structuredClone(b.toJSON());
    expect(plain instanceof PowerHistogram).toBe(false);

    a.merge(plain);

    expect(a.count).toBe(100);
    expect(a.min).toBe(1);
    expect(a.max).toBe(100);
    // And the merge is exact, which is the property the docblock claims.
    const direct = new PowerHistogram({ relativeAccuracy: 0.01 });
    for (let i = 1; i <= 100; i++) direct.record(i);
    expect(a.percentile(50)).toBeCloseTo(direct.percentile(50), 10);
    expect(a.percentile(99)).toBeCloseTo(direct.percentile(99), 10);
  });

  it('merges a sketch from another realm', () => {
    // The cross-realm rule: `instanceof` is false for a value from another `vm`
    // context, so a structural check is the only one that works. A real second
    // realm rather than a hand-rolled stand-in, which would pass for the wrong
    // reason.
    const context = vm.createContext({});
    const foreign = vm.runInContext(
      `(() => {
         const h = new (class {})();
         return {
           _alpha: 0.01, _count: 3, _zeroCount: 0, _infCount: 0, _sum: 6,
           _min: 1, _max: 3, _outOfRangeCount: 0, _belowRangeCount: 0,
           _buckets: [[-100, 1], [0, 1], [100, 1]],
         };
       })()`,
      context
    );
    expect(foreign instanceof PowerHistogram).toBe(false);

    const a = new PowerHistogram({ relativeAccuracy: 0.01 });
    a.merge(foreign);

    expect(a.count).toBe(3);
    expect(a.min).toBe(1);
    expect(a.max).toBe(3);
  });

  it('still rejects something that is not a sketch', () => {
    // The structural check must not become a rubber stamp. A `Symbol.toStringTag`
    // spoof is rejected because the check reads real properties, not a tag.
    const a = new PowerHistogram();
    expect(() => a.merge({})).toThrow(TypeError);
    expect(() => a.merge(null)).toThrow(TypeError);
    expect(() => a.merge({ _alpha: 0.01, _count: 1 })).toThrow(TypeError);
    expect(() =>
      a.merge({ [Symbol.toStringTag]: 'PowerHistogram', _alpha: 0.01, _count: 1 })
    ).toThrow(TypeError);
    expect(() => PowerHistogram.fromJSON({ nope: true })).toThrow(TypeError);
  });

  it('still rejects a relativeAccuracy mismatch', () => {
    // A mismatch is a configuration error because bucket indices are not
    // comparable — unchanged by accepting plain sketches.
    const a = new PowerHistogram({ relativeAccuracy: 0.01 });
    const b = new PowerHistogram({ relativeAccuracy: 0.05 });
    expect(() => a.merge(b.toJSON())).toThrow(/relativeAccuracy mismatch/);
  });
});

// --- AUD-015: percentile() binary search ------------------------------------

describe('PowerHistogram.percentile() binary search (AUD-015)', () => {
  it('agrees with a linear walk over the cumulative counts', () => {
    // **A characterisation, not a regression test — and it says so because the
    // distinction matters.** AUD-015 replaced the linear walk with a lower-bound
    // binary search. The old walk was *correct*; it was only O(b) in occupied
    // buckets. So no behavioural test can fail on the change, and one that
    // claimed to would be decoration — mutation-checked by restoring the walk,
    // and this test passes either way.
    //
    // What it pins is that the search returns *exactly* what the walk returned,
    // for every quantile, on a sketch with enough occupied buckets for the two to
    // be able to disagree. Reimplementing the walk here is deliberate: the point
    // is that the new code matches the old semantics, not that it matches a
    // hand-computed number.
    //
    // The evidence that the change is *worth* anything is the benchmark, not this
    // file: 95.4 % faster at 200 occupied buckets and 99.4 % at 2 000, which is
    // the O(log b) against O(b) the row predicted.
    const h = new PowerHistogram({ relativeAccuracy: 0.001 });
    // A wide, uneven spread so many buckets are occupied.
    for (let i = 0; i < 500; i++) h.record(Math.pow(1.05, i) * (1 + (i % 7) * 0.01));
    h.record(0);
    h.record(Number.POSITIVE_INFINITY);

    const linear = (q) => {
      // The same normalisation `percentile()` applies, because the differential
      // test is about the *search*, not about the argument handling: a fraction
      // at or below 1 is read as a percentage. Omitting this made the
      // reimplementation disagree at q=0.1, which `percentile()` reads as the
      // 10th percentile rather than the 0.1st.
      let qq = q;
      if (qq <= 1) qq *= 100;
      qq = Math.min(100, qq);
      if (qq === 0) return h.min;
      const target = (qq / 100) * h.count;
      if (h._zeroCount > 0 && target <= h._zeroCount) return 0;
      const { indices } = h._bucketOrder();
      let cumulative = h._zeroCount;
      for (let i = 0; i < indices.length; i++) {
        cumulative += h._buckets.get(indices[i]);
        if (cumulative >= target) return h._value(indices[i]);
      }
      return h._infCount > 0 ? Number.POSITIVE_INFINITY : h._max;
    };

    for (const q of [0, 0.1, 1, 5, 25, 50, 75, 90, 95, 99, 99.9, 100, 150]) {
      expect(h.percentile(q), `q=${q}`).toBe(linear(q));
    }
  });

  it('is monotone non-decreasing across the quantile range', () => {
    // The property a consumer actually relies on, and the one a botched binary
    // search breaks first: a lower-bound search that finds the wrong index
    // produces a p-curve that jumps backwards.
    //
    // Walked over `(1, 100]` only. The two argument ranges overlap at `1` and the
    // fraction reading wins, so `percentile(1)` is p100 while `percentile(1.5)` is
    // p1.5 — a curve that steps from 1 upwards is non-monotone *by design*, and a
    // test that walked it would fail on correct code.
    const h = new PowerHistogram({ relativeAccuracy: 0.01 });
    for (let i = 1; i <= 200; i++) h.record(i * 3);
    let prev = -Infinity;
    for (let q = 2; q <= 100; q += 0.5) {
      const v = h.percentile(q);
      expect(v, `q=${q} went backwards`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // And the fraction range on its own, which is the other half of the contract.
    prev = -Infinity;
    for (let q = 0.01; q <= 1; q += 0.01) {
      const v = h.percentile(q);
      expect(v, `fraction q=${q} went backwards`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('handles the empty, all-zero, and all-infinity edge cases', () => {
    // The three shapes that exercise the fall-through paths the binary search
    // shares with the walk.
    const empty = new PowerHistogram();
    expect(empty.percentile(50)).toBeUndefined();

    const zeros = new PowerHistogram();
    for (let i = 0; i < 10; i++) zeros.record(0);
    expect(zeros.percentile(50)).toBe(0);
    expect(zeros.percentile(100)).toBe(0);

    const infs = new PowerHistogram();
    for (let i = 0; i < 10; i++) infs.record(Number.POSITIVE_INFINITY);
    expect(infs.percentile(50)).toBe(Number.POSITIVE_INFINITY);
  });
});

// --- AUD-040: bucketCount is accepted and ignored ---------------------------

describe('PowerHistogram legacy bucketCount (AUD-040)', () => {
  /**
   * A fresh module instance, so the process-global "already warned" flag starts
   * unset.
   *
   * Necessary rather than tidy: the flag is module-level by design (the warning
   * is about the *option*, which does not change between instances), and the
   * pre-existing tests in this file construct histograms with `bucketCount` at
   * lines 7, 22, 34 and 64 — so by the time these run, the flag is long since
   * set and a plain construction warns nothing.
   */
  async function freshHistogram(options) {
    vi.resetModules();
    const mod = await import('../src/helpers/powerHistogram.js');
    return new mod.PowerHistogram(options);
  }

  it('warns when bucketCount is set, and names the option that works', async () => {
    // A caller who set `bucketCount: 1000` believing it controls precision was
    // ignored without a word. The option is stored and read back faithfully, so
    // the value *round-trips* — which is the worst shape a dead option can take,
    // because reading it back confirms the caller's belief that it is honoured.
    const warnings = [];
    const original = console.warn;
    console.warn = (m) => warnings.push(m);
    try {
      await freshHistogram({ bucketCount: 1000 });
    } finally {
      console.warn = original;
    }

    expect(warnings).toHaveLength(1);
    // Names the option that *does* control precision, because a warning that says
    // only "ignored" leaves the caller to guess.
    expect(warnings[0]).toMatch(/bucketCount/);
    expect(warnings[0]).toMatch(/relativeAccuracy/);
  });

  it('warns once per process, not once per instance', async () => {
    // A caller constructing a histogram per request would otherwise fill stderr
    // with the same sentence. The warning is about the *option*, which does not
    // change between instances.
    const warnings = [];
    const original = console.warn;
    console.warn = (m) => warnings.push(m);
    try {
      vi.resetModules();
      const mod = await import('../src/helpers/powerHistogram.js');
      for (let i = 0; i < 5; i++) new mod.PowerHistogram({ bucketCount: 500 });
    } finally {
      console.warn = original;
    }

    expect(warnings).toHaveLength(1);
  });

  it('says nothing when bucketCount is not set', () => {
    // The common case must stay silent — a warning on every construction would
    // train callers to ignore the channel.
    const warnings = [];
    const original = console.warn;
    console.warn = (m) => warnings.push(m);
    try {
      new PowerHistogram();
      new PowerHistogram({ relativeAccuracy: 0.01 });
    } finally {
      console.warn = original;
    }

    expect(warnings).toEqual([]);
  });

  it('still stores the legacy value, and precision is unchanged', async () => {
    // The option is kept for backwards compatibility, and the warning does not
    // change that. Pinned so the fix cannot be "fixed" further into a throw.
    //
    // Asserted on `_legacyBucketCount`, not the `bucketCount` getter: that getter
    // is a *live* count of occupied buckets, which is a different thing entirely
    // and reads 0 on a fresh sketch. Confusing the two is exactly the mistake the
    // round-tripping option invites.
    const h = await freshHistogram({ bucketCount: 1000 });
    expect(h._legacyBucketCount).toBe(1000);
    // And precision is still controlled by relativeAccuracy, unchanged.
    h.record(5);
    expect(h.percentile(50)).toBeCloseTo(5, 6);
  });
});
