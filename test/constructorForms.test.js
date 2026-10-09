import { describe, it, expect } from 'vitest';
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';
import { PowerQueue } from '../src/helpers/powerQueue.js';
import { PowerLatch } from '../src/helpers/powerLatch.js';
import { PowerLogger } from '../src/helpers/powerLogger.js';
import { PowerObserver } from '../src/helpers/powerObserver.js';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

/**
 * QUAL-011 (F2): a helper whose leading argument is a number accepts it either
 * positionally or as an options key.
 *
 * ## What this was
 *
 * Six helpers took a positional number while twenty took an options object, and
 * the split had no rule a reader could infer. `PowerTTLMap` already normalised
 * both forms — the right answer, applied to one class out of seven — and the rest
 * did not, in two distinct ways:
 *
 * - **Silently wrong.** `new PowerLogger({ level: 2 })` came up at level 0,
 *   because the object was read as `options`, which has no `level` key. And
 *   `new PowerObserver({ value: 5 })` stored the *object* as the observed value,
 *   so it appeared to work while being entirely misconfigured.
 * - **Rejected outright.** `new PowerSemaphore({ limit: 3 })` threw, naming a
 *   number the caller had just passed an object for.
 *
 * All five now accept both forms. Positional calls are untouched, so this is
 * additive.
 *
 * ## The rule that keeps it honest
 *
 * An object is read as options only when it carries at least one **known**
 * option key. A bare `{}` still falls through to the numeric path and is
 * rejected — which `test/powerLatch.reset.test.js` already pins as a property
 * ("whatever the constructor rejects, `reset()` must reject too"), and which a
 * looser normalisation silently broke the first time.
 */
describe('a leading numeric argument is accepted positionally or as an option', () => {
  it('PowerSemaphore: limit', () => {
    expect(new PowerSemaphore(3).limit).toBe(3);
    expect(new PowerSemaphore({ limit: 3 }).limit).toBe(3);
    expect(new PowerSemaphore().limit).toBe(1);
  });

  it('PowerQueue: initialCapacity', () => {
    expect(new PowerQueue({ initialCapacity: 8 }).capacity).toBe(new PowerQueue(8).capacity);
  });

  it('PowerLatch: count', () => {
    expect(new PowerLatch(3).remaining).toBe(3);
    expect(new PowerLatch({ count: 3 }).remaining).toBe(3);
  });

  it('PowerLogger: level — the one that was silently wrong', () => {
    // Before: `new PowerLogger({ level: 2 })` returned 0. A logger asked to be
    // verbose was quiet, with nothing to indicate why.
    expect(new PowerLogger(2).getDebugLevel()).toBe(2);
    expect(new PowerLogger({ level: 2 }).getDebugLevel()).toBe(2);
    // The two forms agree rather than merely both existing.
    expect(new PowerLogger({ format: 'json', level: 1 }).getDebugLevel()).toBe(1);
  });

  it('PowerObserver: value — the one that stored the object as the value', () => {
    // Before: `.value` was `{ value: 5 }`, an object, observed as an object.
    expect(new PowerObserver(5).value).toBe(5);
    expect(new PowerObserver({ value: 5 }).value).toBe(5);
  });

  it('PowerTTLMap, which already did this, still does both', () => {
    // The class the others were brought in line with. Pinned so the pattern is
    // a contract rather than an accident of one implementation.
    expect(new PowerTTLMap(1000)._defaultTTL).toBe(1000);
    expect(new PowerTTLMap({ defaultTTL: 1000 })._defaultTTL).toBe(1000);
  });

  it('an object carrying no known key is still rejected', () => {
    // The boundary that `powerLatch.reset.test.js` depends on: `{}` is not an
    // options object, it is an invalid number, and the two must agree.
    expect(() => new PowerLatch({})).toThrow();
    expect(() => new PowerSemaphore({})).toThrow();
    // Nor is an array.
    expect(() => new PowerSemaphore([])).toThrow();
  });

  it('an unrecognised key in a recognised object still throws', () => {
    // Validation is not bypassed by arriving in the other form — that is the
    // whole point of 8f83c07.
    expect(() => new PowerSemaphore({ limit: 3, nonsense: 1 })).toThrow(
      /unknown option `nonsense`/
    );
    expect(() => new PowerLogger({ level: 2, nonsense: 1 })).toThrow(/unknown option `nonsense`/);
  });

  it('an object carrying only an unknown key reaches the option check', () => {
    // R1. The options-object test used to be "carries a *known* key", which let
    // `new PowerSemaphore({ permits: 3 })` — the obvious spelling, and the one
    // the guide's neighbours use — fall through to the numeric path. The caller
    // was then told "`limit` must be a finite number (received [object
    // Object])": an option they never wrote, and a value they never passed.
    //
    // Recognising *any* own key routes it to `assertKnownOptions`, which names
    // the key and suggests the right one. The bare-`{}` case above still throws,
    // because `{}` has no keys and so is still an invalid number.
    expect(() => new PowerSemaphore({ permits: 3 })).toThrow(/unknown option `permits`/);
    // The accepted set is listed, which is what makes it actionable. Note there
    // is no "Did you mean" here: `permits` → `limit` is five edits against a
    // threshold of two, and `suggestOption` deliberately stays quiet rather than
    // guessing across that distance. Asserting a suggestion the heuristic does
    // not make would be pinning a wish.
    expect(() => new PowerSemaphore({ permits: 3 })).toThrow(
      /Accepted options: limit, queueCapacity/
    );
  });
});
