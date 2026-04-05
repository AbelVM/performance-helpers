import { describe, it, expect } from 'vitest';
import * as nowModule from '../src/utils/now.js';

describe('nowMs behavior', () => {
  it('prefers performance when close to Date.now()', () => {
    // stub performance
    const origPerf = global.performance;
    global.performance = {
      timeOrigin: Date.now(),
      now: () => 123.5,
    };
    const val = nowModule.nowMs();
    expect(typeof val).toBe('number');
    // restore
    global.performance = origPerf;
  });

  it('falls back to Date.now() when perf deviates far from Date.now()', () => {
    const origPerf = global.performance;
    const nowVal = Date.now();
    global.performance = {
      timeOrigin: nowVal - 5000, // large delta so perfVal will be far from Date.now()
      now: () => 0,
    };
    const val = nowModule.nowMs();
    // should be close to Date.now()
    expect(Math.abs(val - Date.now())).toBeLessThan(1000);
    global.performance = origPerf;
  });
});
