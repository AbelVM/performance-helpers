import { describe, it, expect } from 'vitest';
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
});
