/**
 * `assertLimitRequired` (QUAL-009).
 *
 * `assertLimit` keeps its BUG-024 passthrough: given a nullish value with no
 * `fallback`, it hands the value straight back, so its return type is honestly
 * `number | null | undefined`. That honesty is a problem for a constructor: the
 * field it assigns is then `number | null | undefined` too, which meant 25
 * null-safety diagnostics downstream - and before the honest type landed, the
 * same fields were `any` and none of it showed up at all.
 *
 * `assertLimitRequired` is the constructor-facing variant. It resolves to
 * `number`, and it throws rather than returning something a limit cannot be.
 * The point of the throw is that "unreachable in practice" is exactly the claim
 * that rots: when `assertLimit` did return `undefined`, the field was assigned
 * `undefined` and the limit it guards silently stopped guarding anything.
 */
import { describe, it, expect } from 'vitest';
import { assertLimit, assertLimitRequired } from '../src/utils/options.js';

const spec = { name: 'maxEntries', className: 'PowerCache' };

describe('assertLimitRequired', () => {
  it('behaves exactly like assertLimit for valid input', () => {
    for (const value of [0, 1, 42, 1e6, 3.7]) {
      expect(assertLimitRequired(value, { ...spec, min: 0 })).toBe(
        assertLimit(value, { ...spec, min: 0 })
      );
    }
  });

  it('returns a real number, never null or undefined', () => {
    const n = assertLimitRequired(5, spec);
    expect(typeof n).toBe('number');
    expect(n).toBe(5);
  });

  it('accepts Infinity when the spec allows it', () => {
    expect(assertLimitRequired(Number.POSITIVE_INFINITY, { ...spec, allowInfinity: true })).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it('rejects Infinity when the spec does not', () => {
    expect(() => assertLimitRequired(Number.POSITIVE_INFINITY, spec)).toThrow(/finite/);
  });

  it('uses the fallback for a nullish value', () => {
    expect(assertLimitRequired(undefined, { ...spec, fallback: 7 })).toBe(7);
    expect(assertLimitRequired(null, { ...spec, fallback: 7 })).toBe(7);
  });

  it('throws for a nullish value with no fallback, where assertLimit passes through', () => {
    // This is the whole point of the second entry point. The behaviour
    // difference is the fix, not an accident.
    expect(assertLimit(undefined, spec)).toBeUndefined();
    expect(() => assertLimitRequired(undefined, spec)).toThrow(
      /must be a number or have a `fallback`/
    );
    expect(assertLimit(null, spec)).toBeNull();
    expect(() => assertLimitRequired(null, spec)).toThrow(TypeError);
  });

  it('the throw names the option and the class', () => {
    expect(() => assertLimitRequired(undefined, spec)).toThrow(/maxEntries/);
    expect(() => assertLimitRequired(undefined, spec)).toThrow(/PowerCache/);
  });

  it('still enforces min, finite-ness and coercion identically to assertLimit', () => {
    expect(() => assertLimitRequired(-1, { ...spec, min: 0 })).toThrow(/must be >= 0/);
    expect(() => assertLimitRequired(Number.NaN, spec)).toThrow(/finite/);
    // Numeric strings coerce, as they always have.
    expect(assertLimitRequired('12', spec)).toBe(12);
  });

  it('leaves no gap: every path either yields a number or throws', () => {
    const inputs = [undefined, null, 0, -1, 1, Number.NaN, Number.POSITIVE_INFINITY, '7', ''];
    for (const value of inputs) {
      for (const fallback of [undefined, 0, 3]) {
        const s = fallback === undefined ? spec : { ...spec, fallback };
        let out;
        try {
          out = assertLimitRequired(value, s);
        } catch {
          continue; // throwing is an acceptable outcome
        }
        expect(typeof out).toBe('number');
        expect(Number.isFinite(out) || out === Number.POSITIVE_INFINITY).toBe(true);
      }
    }
  });
});
