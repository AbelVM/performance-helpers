import { describe, it, expect } from 'vitest';
import { PowerLatch } from '../src/helpers/powerLatch.js';

/**
 * LIM-002 — `reset(count)` bypassed the integer validation its own constructor
 * enforces.
 *
 * The constructor runs `assertLimitRequired(count, { integer: true })` and throws
 * on `2.5`. `reset()` ran `Math.max(0, Number(count) || 0)` and accepted it. The
 * two spellings of the same option had diverged, which is how RES-010's "set
 * `integer` at the integer call sites" fixed the constructor and left the setter.
 *
 * The consequence is not a wrong count, it is a latch that **cannot finish**:
 * `reset(2.5)` then one `countDown()` leaves `remaining` at `1.5`, and `wait()`
 * never settles — measured, it hung until the probe's own timeout. In the other
 * direction `reset(NaN)` and `reset(-5)` both collapsed to `0`, which *resolved*
 * every pending waiter, so a bad argument fabricated completion out of a latch
 * that had not been counted down.
 *
 * `test/powerLatch.test.js` asserts `reset(0)` resolves a waiter and nothing
 * about the argument being validated, so every one of these cases passed against
 * the unfixed setter.
 */
describe('PowerLatch.reset validates count exactly as the constructor does', () => {
  it('rejects a fractional count', () => {
    // The hang, stated as the thing that must not be constructible.
    const latch = new PowerLatch(1);
    expect(() => latch.reset(2.5)).toThrow(TypeError);
    expect(() => latch.reset(2.5)).toThrow(/whole number/);
  });

  it('leaves the latch untouched when it rejects a count', () => {
    // A setter that validates its argument and then mutates anyway is worse than
    // one that does neither. The count has to be what it was.
    const latch = new PowerLatch(3);
    latch.countDown();
    expect(latch.remaining).toBe(2);
    expect(() => latch.reset(2.5)).toThrow();
    expect(latch.remaining, 'a rejected reset must not half-apply').toBe(2);
  });

  it('rejects the coercions that resolve waiters', async () => {
    // `NaN` and `-5` both collapsed to `0` through `|| 0`, and `0` resolves every
    // pending waiter. A caller who mistyped the count got a *completed* latch,
    // which is the more dangerous half: nothing is ever left waiting.
    for (const bad of [NaN, -5, -0.5]) {
      const latch = new PowerLatch(2);
      const p = latch.wait();
      expect(() => latch.reset(bad), `reset(${String(bad)})`).toThrow();
      // Unchanged, not collapsed to `0`. This is the assertion that matters:
      // under `|| 0` every one of these became `0`, and `0` is the state that
      // resolves every pending waiter. "Still waiting" and "already complete"
      // are opposite outcomes and only one of them is right here.
      expect(latch.remaining, `remaining after reset(${String(bad)})`).toBe(2);
      latch.countDown();
      latch.countDown();
      await expect(p).resolves.toBeUndefined();
    }
  });

  it('rejects a count the constructor would reject', () => {
    // The property, rather than a list of examples: **whatever the constructor
    // rejects, `reset()` must reject too.** That is what routing both through
    // `assertLimitRequired` bought, and it is the assertion that fails if a
    // future tightening lands on one class and not the other.
    //
    // `[]` is accepted by both, and deliberately so — it is `Number([]) === 0`,
    // the same coercion `assertLimitRequired` applies everywhere in the library.
    // The point is agreement between the two, not which way they fall.
    const samples = [2.5, NaN, -5, -0.5, 'x', {}, true, [], null, undefined];
    for (const value of samples) {
      let constructorThrew = false;
      try {
        new PowerLatch(value === null || value === undefined ? 1 : value);
      } catch {
        constructorThrew = true;
      }
      const latch = new PowerLatch(1);
      let resetThrew = false;
      try {
        latch.reset(value);
      } catch {
        resetThrew = true;
      }
      expect(
        resetThrew,
        `reset(${JSON.stringify(value) ?? String(value)}): constructorThrew=${constructorThrew} resetThrew=${resetThrew}`
      ).toBe(constructorThrew);
    }
  });

  it('accepts the whole-number counts it is supposed to', () => {
    // The legitimate half, which a test that only asserted throwing would not
    // reach. `reset()`'s default is `1`, and `reset(0)` is documented to resolve
    // waiters, so both have to keep working.
    const latch = new PowerLatch(1);
    expect(() => latch.reset()).not.toThrow();
    expect(latch.remaining).toBe(1);

    expect(() => latch.reset(4)).not.toThrow();
    expect(latch.remaining).toBe(4);

    expect(() => latch.reset(0)).not.toThrow();
    expect(latch.remaining).toBe(0);
  });

  it('a numeric string still counts, as it does in the constructor', () => {
    // `assertLimitRequired` accepts a numeric string because `process.env.X` is a
    // string. Consistency with the constructor is the whole point of routing
    // both through one helper, so the acceptance has to be pinned on both sides
    // or a later "tighten it" change will land on one class only.
    const latch = new PowerLatch(1);
    latch.reset('3');
    expect(latch.remaining).toBe(3);
  });

  it('a latch reset to an integer still reaches zero', () => {
    // The end-to-end shape, because the first test proves the fraction is
    // rejected and this proves the accepted value is actually usable.
    const latch = new PowerLatch(1);
    const p = latch.wait();
    latch.reset(2);
    latch.countDown();
    expect(latch.remaining).toBe(1);
    latch.countDown();
    return expect(p).resolves.toBeUndefined();
  });
});
