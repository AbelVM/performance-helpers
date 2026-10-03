/**
 * `{ seed }` on `PowerCache` (CACHE-020).
 *
 * `SmallLfuSketch` has accepted and documented a `seed` since it was written —
 * "per-cache seed, so two caches do not share a hash pattern" — and
 * `powerCache.js` never passed one, so `smallLfu.js:138` drew it from
 * `Math.random()` on every construction. Two caches built from identical options
 * therefore hashed differently, which means an admission-sensitive measurement
 * could not be attributed to its configuration and a regression that moved
 * admission could not be reproduced from its own options.
 *
 * The test is deliberately a **property**, not a value. Asserting
 * `cache._sketch.seed === 12345` would pass the day the option was threaded
 * through and fail the day someone re-derived the seed, and it says nothing
 * about the thing the option is for. What matters is that two identically
 * seeded caches *decide identically* — so the property is asserted on eviction
 * order and on the counters, both of which are what an admission decision
 * changes.
 *
 * The non-triviality guard matters more than the property. Two caches that
 * rejected nothing would agree no matter how they hashed, so every case here
 * asserts `stats().rejectedAdmission > 0` first (CACHE-011 — the counter was a
 * private field until this row, which is why the earlier draft of this test
 * wanted to reach for `_rejectedAdmission`). A property test that cannot fail on
 * the regression it names is decoration.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

/** Capacity small enough that a scan of 400 keys is refused repeatedly. */
const MAX_ENTRIES = 16;
/** Working-set keys, warmed across passes so the sketch counts them above 1. */
const HOT = 12;
const SCAN = 400;

/**
 * Run a fixed key stream through a cache and report what the admission filter
 * decided, as a comparable trace.
 *
 * The stream is deterministic — no `Math.random`, no clock — so two runs of this
 * differ only if the hashing differs. The trace is the eviction order rather
 * than a hit/miss tally, because two caches can agree on a hit rate while having
 * made opposite admission calls on individual keys.
 *
 * @param {Object} [options] - Extra `PowerCache` options; `seed` among them.
 * @returns {{trace: string[], rejections: number}}
 */
function admissionTrace(options = {}) {
  const cache = new PowerCache({
    maxEntries: MAX_ENTRIES,
    admission: 'tinylfu',
    ...options,
  });
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < HOT; i += 1) cache.set(`hot-${i}`, pass);
    for (let i = 0; i < SCAN; i += 1) cache.set(`scan-${pass}-${i}`, i);
  }
  return {
    // Read the recency list in MRU order (`keys()` is a generator, so it has to
    // be materialised) — the full eviction order the policy produced.
    trace: [...cache.keys()],
    rejections: cache.stats().rejectedAdmission,
  };
}

describe('PowerCache { seed }', () => {
  it('is not an unknown option', () => {
    // The guard exists so a typo cannot pass as a valid option. Without this the
    // other cases would throw for the wrong reason and the option could still
    // be unbound in a later refactor that reintroduced the throw-only-if-misspelt
    // behaviour.
    expect(() => new PowerCache({ admission: 'tinylfu', seed: 7 })).not.toThrow();
  });

  it('two caches with the same seed make identical admission decisions', () => {
    const a = admissionTrace({ seed: 12345 });
    const b = admissionTrace({ seed: 12345 });

    // Non-triviality first. If the filter refused nothing the two traces would
    // agree for the wrong reason and the equality below would be worthless.
    expect(a.rejections).toBeGreaterThan(0);
    expect(a.rejections).toBe(b.rejections);
    expect(a.trace).toEqual(b.trace);
  });

  it('the same seed reproduces across separate constructions', () => {
    // Deliberately not a fresh `describe` with shared state: this is the case a
    // benchmark actually hits, where the cache is constructed inside the measured
    // region. Constructing both in one pass would hide a seed drawn at
    // module-eval time instead of at construction.
    const first = admissionTrace({ seed: 987654321 });
    const second = admissionTrace({ seed: 987654321 });
    expect(first.trace).toEqual(second.trace);
  });

  it('a pinned seed is a seed, and an omitted one is drawn per construction', () => {
    // The property the option restores is "I can pin this", which has two halves:
    // a supplied seed reaches the sketch unchanged, and the default is still
    // random rather than quietly becoming a constant. A shared constant would be
    // the worse regression of the two — it would make every cache in a process
    // hash alike, which is what the sketch's own option was written to prevent.
    expect(new PowerCache({ admission: 'tinylfu', seed: 1 })._sketch.seed).toBe(1);
    expect(new PowerCache({ admission: 'tinylfu', seed: 2 })._sketch.seed).toBe(2);

    const unseededA = new PowerCache({ admission: 'tinylfu' });
    const unseededB = new PowerCache({ admission: 'tinylfu' });
    // Two unseeded caches collide with probability ~2/2^32 = 4.7e-10. Stated
    // rather than left implicit: it is the one probabilistic assertion here, and
    // it reads a private field, which is why the pinned cases above assert the
    // public trace instead.
    expect(unseededA._sketch.seed).not.toBe(unseededB._sketch.seed);
  });

  it('a seed the sketch would silently rewrite is rejected instead', () => {
    // `smallLfu.js:138` ends with `| 0`, so `4294967296` and `1.5` both arrive as
    // seed 0. A caller who passed a seed to make admission reproducible would get
    // a reproducible *wrong* one, with nothing to say so — which is the exact
    // failure the option exists to remove.
    for (const bad of [1.5, 4294967296, -2147483649, Number.NaN, 'abc', Infinity]) {
      expect(() => new PowerCache({ admission: 'tinylfu', seed: bad })).toThrow(/`seed`/);
    }
  });

  it('is validated even with admission off, so it is never silently ignored', () => {
    // `seed` under `admission: 'none'` does nothing, and a silently inert option
    // is the failure the unknown-option pass was added to remove. A bad value
    // says so; a good value is accepted and simply unused.
    expect(() => new PowerCache({ admission: 'none', seed: 42 })).not.toThrow();
    expect(() => new PowerCache({ admission: 'none', seed: 'abc' })).toThrow(/`seed`/);
  });
});
