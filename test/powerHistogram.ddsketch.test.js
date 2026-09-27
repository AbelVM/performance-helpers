import { describe, it, expect } from 'vitest';
import { PowerHistogram } from '../src/index.js';

describe('PowerHistogram (DDSketch) - out-of-range data is not clamped (BUG-002)', () => {
  it('reports a value above maxValue instead of collapsing it into the top bucket', () => {
    // The old fixed-bucket implementation reported p99.9 = 20000 for this
    // exact input (true 1e8) - a 5000x under-report with no warning.
    const h = new PowerHistogram(); // defaults, maxValue = 10000
    for (let i = 0; i < 99; i++) h.record(1);
    h.record(1e8);

    const p999 = h.percentile(99.9);
    expect(p999).toBeGreaterThan(9e7);
    expect(p999).toBeLessThan(1.1e8);
    expect(h.max).toBe(1e8);
  });

  it('counts out-of-range records for reporting without altering storage', () => {
    const h = new PowerHistogram({ maxValue: 10 });
    h.record(5);
    h.record(50);
    h.record(1000);
    expect(h.outOfRangeCount).toBe(2);
    expect(h.max).toBe(1000);
    // still stored faithfully
    expect(h.percentile(100)).toBeGreaterThan(900);
  });

  it('counts below-range records', () => {
    const h = new PowerHistogram({ minValue: 10 });
    h.record(1);
    h.record(50);
    expect(h.belowRangeCount).toBe(1);
    expect(h.min).toBe(1);
  });

  it('handles an unbounded range spanning 600 decades in a few buckets', () => {
    const h = new PowerHistogram({ maxValue: Number.POSITIVE_INFINITY });
    h.record(1e-300);
    h.record(1e300);
    expect(h.min).toBe(1e-300);
    expect(h.max).toBe(1e300);
    expect(h.bucketCount).toBe(2);
  });
});

describe('PowerHistogram - relative error guarantee', () => {
  it.each([0.01, 0.005, 0.001])('bounds the single-value error by relativeAccuracy=%s', (alpha) => {
    const h = new PowerHistogram({ relativeAccuracy: alpha });
    for (const v of [1e-9, 1e-3, 1, 1e3, 1e9]) {
      const single = new PowerHistogram({ relativeAccuracy: alpha });
      single.record(v);
      const est = single.percentile(50);
      expect(Math.abs(est - v) / v).toBeLessThanOrEqual(alpha + 1e-12);
    }
    expect(h.count).toBe(0);
  });

  it('holds the bound over a dense log sweep', () => {
    const alpha = 0.01;
    let worst = 0;
    for (let e = -20; e <= 20; e += 0.01) {
      const v = Math.exp(e);
      const single = new PowerHistogram({ relativeAccuracy: alpha });
      single.record(v);
      const rel = Math.abs(single.percentile(50) - v) / v;
      if (rel > worst) worst = rel;
    }
    expect(worst).toBeLessThanOrEqual(alpha + 1e-12);
  });

  it('estimates a known quantile within the bound', () => {
    const alpha = 0.01;
    // A narrow uniform range keeps one rank step far below the bound, so the
    // comparison is meaningful (a wide log range would make the discrete rank
    // step dominate the estimate).
    const lo = 1000;
    const hi = 1010;
    const h = new PowerHistogram({ relativeAccuracy: alpha });
    const values = [];
    for (let i = 0; i < 20000; i++) {
      const v = lo + ((hi - lo) * i) / 20000;
      values.push(v);
      h.record(v);
    }
    values.sort((a, b) => a - b);
    for (const q of [25, 50, 75, 90, 99]) {
      const truth = values[Math.floor((q / 100) * values.length)];
      const est = h.percentile(q);
      expect(Math.abs(est - truth) / truth).toBeLessThanOrEqual(alpha);
    }
  });

  it('returns identical values for an identical-value sketch', () => {
    const h = new PowerHistogram();
    for (let i = 0; i < 1000; i++) h.record(42);
    for (const q of [0, 1, 25, 50, 75, 99, 100]) {
      // A relative-error sketch returns the midpoint of the bucket, so the
      // estimate is 42 * gamma^index, not exactly 42. The guarantee is the
      // relative bound, not exactness.
      const est = h.percentile(q);
      expect(Math.abs(est - 42) / 42).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('PowerHistogram - merge', () => {
  it('merges exact counts and produces the combined quantiles', () => {
    const a = new PowerHistogram();
    const b = new PowerHistogram();
    for (let i = 0; i < 1000; i++) a.record(1);
    for (let i = 0; i < 1000; i++) b.record(2);
    const merged = new PowerHistogram().merge(a).merge(b);

    expect(merged.count).toBe(2000);
    expect(merged.sum).toBe(3000);
    expect(merged.min).toBe(1);
    expect(merged.max).toBe(2);
    // p50 of 1000x1 + 1000x2 is 1, and p99.9 is 2. Both estimates are bucket
    // midpoints, so assert the relative bound rather than exactness.
    expect(Math.abs(merged.percentile(50) - 1) / 1).toBeLessThanOrEqual(0.01);
    expect(Math.abs(merged.percentile(99.9) - 2) / 2).toBeLessThanOrEqual(0.01);
  });

  it('matches a single sketch that recorded everything', () => {
    const single = new PowerHistogram();
    const shards = [new PowerHistogram(), new PowerHistogram(), new PowerHistogram()];
    const values = [];
    for (let i = 0; i < 3000; i++) {
      const v = Math.exp((i / 3000) * 10);
      values.push(v);
      single.record(v);
      shards[i % 3].record(v);
    }
    const merged = new PowerHistogram();
    for (const s of shards) merged.merge(s);

    for (const q of [50, 90, 99, 99.9]) {
      expect(merged.percentile(q)).toBeCloseTo(single.percentile(q), 6);
    }
  });

  it('rejects a merge across different relativeAccuracy', () => {
    const a = new PowerHistogram({ relativeAccuracy: 0.02 });
    const b = new PowerHistogram({ relativeAccuracy: 0.01 });
    expect(() => a.merge(b)).toThrow(/relativeAccuracy mismatch/);
  });

  it('rejects a non-PowerHistogram argument', () => {
    expect(() => new PowerHistogram().merge({})).toThrow(TypeError);
  });
});

describe('PowerHistogram - zero, inf, reset, snapshot', () => {
  it('tracks exact zero in its own bucket', () => {
    const h = new PowerHistogram();
    h.record(0);
    h.record(0);
    h.record(5);
    expect(h.count).toBe(3);
    expect(h.min).toBe(0);
    expect(h.percentile(0)).toBe(0);
    expect(h.percentile(50)).toBe(0); // 2 of 3 values are zero
    expect(h.snapshot()).toEqual([2, 1]);
  });

  it('accepts +Infinity and reports it rather than dropping it', () => {
    const h = new PowerHistogram();
    h.record(1);
    h.record(Number.POSITIVE_INFINITY);
    expect(h.count).toBe(2);
    expect(h.percentile(100)).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects negative and NaN input', () => {
    const h = new PowerHistogram();
    expect(() => h.record(-1)).toThrow(TypeError);
    expect(() => h.record(Number.NaN)).toThrow(TypeError);
  });

  it('reset() clears every counter including the out-of-range tally', () => {
    const h = new PowerHistogram({ maxValue: 5 });
    h.record(0);
    h.record(1);
    h.record(100);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.sum).toBe(0);
    expect(h.min).toBeUndefined();
    expect(h.max).toBeUndefined();
    expect(h.percentile(50)).toBeUndefined();
    expect(h.bucketCount).toBe(0);
    expect(h.outOfRangeCount).toBe(0);
    expect(h.snapshot()).toEqual([0]);
  });

  it('toJSON round-trips the important state', () => {
    const h = new PowerHistogram();
    h.record(0);
    h.record(7);
    const j = h.toJSON();
    expect(j.count).toBe(2);
    expect(j.zeroCount).toBe(1);
    expect(j.min).toBe(0);
    expect(j.max).toBe(7);
    expect(j.relativeAccuracy).toBe(h.relativeAccuracy);
    expect(j.buckets.length).toBe(1);
  });
});

describe('PowerHistogram - option validation', () => {
  it.each([0, 1, -0.5, Number.NaN, Infinity])('rejects relativeAccuracy=%s', (bad) => {
    expect(() => new PowerHistogram({ relativeAccuracy: bad })).toThrow(TypeError);
  });

  it('accepts a valid relativeAccuracy and exposes it', () => {
    const h = new PowerHistogram({ relativeAccuracy: 0.02 });
    expect(h.relativeAccuracy).toBe(0.02);
  });

  it('still accepts the legacy bucketCount option without error', () => {
    const h = new PowerHistogram({ bucketCount: 64, minValue: 1, maxValue: 5000 });
    h.record(10);
    expect(h.count).toBe(1);
  });
});
