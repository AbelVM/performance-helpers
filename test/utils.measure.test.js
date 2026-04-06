import { describe, it, expect } from 'vitest';
import { measureSync, measureAsync } from '../src/utils/now.js';

describe('measureSync and measureAsync', () => {
  it('measureSync returns result and duration for sync function', () => {
    const res = measureSync(() => {
      let s = 0;
      for (let i = 0; i < 1000; i++) s += i;
      return s;
    });
    expect(res).toHaveProperty('result');
    expect(typeof res.ms).toBe('number');
    expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(res.end - res.start).toBeCloseTo(res.ms, -1);
  });

  it('measureSync attaches duration to thrown error', () => {
    try {
      measureSync(() => {
        throw new Error('boom');
      });
    } catch (e) {
      expect(e).toHaveProperty('durationMs');
      expect(typeof e.durationMs).toBe('number');
    }
  });

  it('measureAsync measures promise-returning function', async () => {
    const r = await measureAsync(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    expect(r.result).toBe(42);
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('measureAsync attaches duration to rejected promise', async () => {
    try {
      await measureAsync(async () => {
        await new Promise((_, rej) => setTimeout(() => rej(new Error('fail')), 5));
      });
      throw new Error('should have rejected');
    } catch (e) {
      expect(e).toHaveProperty('durationMs');
      expect(typeof e.durationMs).toBe('number');
    }
  });
});
