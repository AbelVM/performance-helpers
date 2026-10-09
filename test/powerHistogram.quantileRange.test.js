import { describe, it, expect } from 'vitest';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

/**
 * The quantile argument's accepted range, and the one place it saturates rather
 * than rejects.
 *
 * `percentile()` takes either `0..100` or `0..1`, and the two ranges overlap at
 * `1` — where the fraction reading wins, so `percentile(1)` is p100 and not p1.
 * That ambiguity is documented in the guide, which calls `1` "the one to watch".
 * What was *not* documented was the behaviour above 100, and an undocumented
 * boundary in a method this careful about its other one is the kind of gap that
 * gets "fixed" into a breaking change by someone who assumed it was an oversight.
 */
describe('PowerHistogram quantile argument range', () => {
  /** A histogram with a known, strictly increasing set of observations. */
  function filled() {
    const h = new PowerHistogram();
    for (let i = 1; i <= 100; i++) h.record(i);
    return h;
  }

  describe('the 0..1 / 0..100 overlap', () => {
    it('reads 1 as the 100th percentile, not the 1st', () => {
      // The documented ambiguity, pinned so the fraction reading cannot be
      // "corrected" into the other one. `percentile(1)` returning p1 would be a
      // 100x error in the reported tail.
      const h = filled();
      expect(h.percentile(1)).toBe(h.percentile(100));
      expect(h.percentile(1)).toBeGreaterThan(h.percentile(0.01));
    });

    it('reads 0.5 and 50 as the same quantile', () => {
      const h = filled();
      expect(h.percentile(0.5)).toBe(h.percentile(50));
    });

    it('reads 0 as the exact minimum', () => {
      const h = filled();
      expect(h.percentile(0)).toBe(1);
    });
  });

  describe('above 100 saturates', () => {
    it('returns the maximum rather than throwing', () => {
      // Deliberate, and now documented on the method. `150` asks for "at or
      // above the top", and the maximum is the correct answer to that — unlike
      // `NaN` or a negative, which would index nonsense and so do throw.
      const h = filled();
      expect(h.percentile(150)).toBe(h.percentile(100));
      expect(h.percentile(1000)).toBe(h.percentile(100));
      // `Infinity` is *not* in this set: it is non-finite, and the non-finite
      // rejection below catches it before the clamp. Only finite values above
      // 100 saturate.
      expect(() => h.percentile(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
    });

    it('is monotonic across the boundary', () => {
      // Saturation must not invert the curve: p100 and p150 agree, and neither
      // is below p99.
      const h = filled();
      expect(h.percentile(99)).toBeLessThanOrEqual(h.percentile(100));
      expect(h.percentile(100)).toBeLessThanOrEqual(h.percentile(150));
    });
  });

  describe('below 0 and non-finite still throw', () => {
    it('rejects a negative quantile', () => {
      // The other half of the boundary, and the reason saturation above 100 is
      // defensible: a negative would index before the start, which has no
      // sensible answer.
      const h = filled();
      expect(() => h.percentile(-1)).toThrow(/non-negative/);
    });

    it('rejects NaN', () => {
      const h = filled();
      expect(() => h.percentile(Number.NaN)).toThrow(/non-negative/);
    });

    it('rejects a non-numeric argument', () => {
      const h = filled();
      expect(() => h.percentile('p99')).toThrow(/non-negative/);
    });
  });

  it('returns undefined on an empty histogram for any quantile', () => {
    // The empty case short-circuits before the range check, so it must not
    // start throwing for an out-of-range argument it never looked at.
    const h = new PowerHistogram();
    expect(h.percentile(50)).toBeUndefined();
    expect(h.percentile(150)).toBeUndefined();
  });
});
