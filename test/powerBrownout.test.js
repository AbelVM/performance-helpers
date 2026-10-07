import { describe, expect, it } from 'vitest';
import { PowerBrownout, getResourcePressure } from '../src/index.js';

describe('PowerBrownout', () => {
  it('sheds optional work at pressure and reports decisions', () => {
    const brownout = new PowerBrownout({ threshold: 0.8, disabledKinds: ['prefetch'] });
    expect(brownout.allows('metrics')).toBe(true);
    expect(brownout.allows('prefetch')).toBe(false);
    brownout.setPressure(0.8);
    expect(brownout.allows('metrics')).toBe(false);
    expect(brownout.stats()).toMatchObject({ active: true, decisions: 3, shed: 2 });
  });

  it('validates normalized pressure', () => {
    const brownout = new PowerBrownout();
    expect(() => brownout.setPressure(2)).toThrow(RangeError);
    expect(() => brownout.allows(1)).toThrow(TypeError);
  });

  it('combines caller pressure with available Node pressure', () => {
    expect(getResourcePressure({ eventLoopPressure: 0.9 })).toBeGreaterThanOrEqual(0.9);
  });
});
