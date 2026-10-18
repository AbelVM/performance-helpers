import { describe, expect, it, vi } from 'vitest';
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

  it('validates options and supports explicit disable toggles', () => {
    expect(() => new PowerBrownout({ threshold: 2 })).toThrow(RangeError);
    expect(() => new PowerBrownout({ disabledKinds: ['prefetch', 1] })).toThrow(TypeError);

    const brownout = new PowerBrownout({ disabledKinds: ['prefetch'] });
    expect(brownout.allows('prefetch')).toBe(false);
    brownout.disable('prefetch', false);
    expect(brownout.allows('prefetch')).toBe(true);
    expect(brownout.getStats()).toMatchObject({ disabledKinds: [], decisions: 2, shed: 1 });
  });

  it('combines caller pressure with available Node pressure', () => {
    expect(getResourcePressure({ eventLoopPressure: 0.9 })).toBeGreaterThanOrEqual(0.9);
    expect(getResourcePressure({})).toBeGreaterThanOrEqual(0);
    vi.stubGlobal('process', undefined);
    expect(getResourcePressure({})).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('PowerBrownout adaptive threshold', () => {
  it('adapts threshold based on pressure history when enabled', () => {
    const brownout = new PowerBrownout({ threshold: 0.5, adaptive: true });
    // low pressure: threshold should rise (shed less)
    brownout.setPressure(0.1);
    const t1 = brownout.stats().threshold;
    expect(t1).toBeGreaterThan(0.5);
    // high pressure: threshold should fall (shed more)
    brownout.setPressure(0.9);
    const t2 = brownout.stats().threshold;
    expect(t2).toBeLessThan(t1);
    expect(brownout.stats().adaptive).toBe(true);
    expect(brownout.stats().pressureEwma).toBeGreaterThan(0);
  });

  it('keeps threshold fixed when adaptive is disabled', () => {
    const brownout = new PowerBrownout({ threshold: 0.5 });
    brownout.setPressure(0.9);
    expect(brownout.stats().threshold).toBe(0.5);
    expect(brownout.stats().adaptive).toBe(false);
  });

  it('validates adaptive option shape', () => {
    const b = new PowerBrownout({ adaptive: { min: 0.2, max: 0.8, alpha: 0.3 } });
    expect(b.stats().adaptive).toBe(true);
    expect(() => new PowerBrownout({ adaptive: 'x' })).not.toThrow();
  });
});
