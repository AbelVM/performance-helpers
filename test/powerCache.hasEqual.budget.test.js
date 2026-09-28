/**
 * `hasEqual` deep comparison: the depth bug, the width budget, and the
 * `compareFn` escape hatch (PERF-004).
 *
 * The first test here is a **correctness** test, not a performance one. The
 * depth limit was counting array *elements* rather than nesting *levels*, so a
 * flat array of 101 objects exhausted it and every remaining pair fell back to
 * reference equality - which made two structurally identical copies compare as
 * unequal, and such an entry was unfindable through `hasEqual` for as long as
 * it lived in the cache. A performance item found a cache-defeating bug.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';
// Internal tuning constants, deliberately not on the public barrel: the guide
// documents `maxNodes` as an option, and adding a constant export to shorten a
// test would widen the public API for no caller.
import { MAX_DEEP_EQUAL_DEPTH, MAX_DEEP_EQUAL_NODES } from '../src/helpers/constants.js';

/** `n` structurally identical objects, distinct array each call. */
const objects = (n) => Array.from({ length: n }, (_, i) => ({ id: i }));

describe('hasEqual: depth is per level, not per element', () => {
  it('compares a flat array of objects far deeper than the depth limit', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    const n = MAX_DEEP_EQUAL_DEPTH * 5;
    cache.set('k', objects(n));
    // This is the regression. The limit was consumed once per element, so from
    // element 101 onwards every comparison degraded to reference equality and
    // two distinct-but-equal copies reported `false`.
    expect(cache.hasEqual('k', objects(n))).toBe(true);
  });

  it('still reports a real difference in a flat array past the limit', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    const n = MAX_DEEP_EQUAL_DEPTH * 5;
    const differing = objects(n);
    differing[n - 1] = { id: -1 };
    cache.set('k', objects(n));
    expect(cache.hasEqual('k', differing)).toBe(false);
  });

  it('still compares genuine nesting up to the depth limit', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    const nest = (d) => (d === 0 ? { leaf: true } : { nest: nest(d - 1) });
    const d = MAX_DEEP_EQUAL_DEPTH - 5;
    cache.set('k', nest(d));
    expect(cache.hasEqual('k', nest(d))).toBe(true);
  });
});

describe('hasEqual: width budget', () => {
  it('bounds a wide comparison that the depth limit could not', () => {
    // Depth says nothing about width. A flat array of 50k scalars recurses at
    // depth 2 and never trips a depth limit, and comparing two of them blocked
    // for tens of milliseconds on what a caller expects to be a cache lookup.
    const cache = new PowerCache({ maxEntries: 10 });
    const wide = Array.from({ length: 50_000 }, (_, i) => i);
    cache.set('k', wide);

    const t0 = Date.now();
    const r = cache.hasEqual(
      'k',
      Array.from({ length: 50_000 }, (_, i) => i)
    );
    const ms = Date.now() - t0;

    expect(r).toBe(false); // truncated, and the safe direction for a cache
    expect(ms).toBeLessThan(200);
  });

  it('truncation reports false, never true', () => {
    // A false negative costs a recompute. A false positive hands back the wrong
    // value, and this is a cache - so the budget is allowed to be wrong, but
    // only in one direction.
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('k', objects(100));
    expect(cache.hasEqual('k', objects(100), { maxNodes: 10 })).toBe(false);
  });

  it('honours an explicit maxNodes', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('k', objects(2000));
    // Under the budget: a real comparison.
    expect(cache.hasEqual('k', objects(2000))).toBe(true);
    // Over it: truncated.
    expect(cache.hasEqual('k', objects(2000), { maxNodes: 500 })).toBe(false);
  });

  it('the default budget is documented and generous', () => {
    expect(MAX_DEEP_EQUAL_NODES).toBeGreaterThan(1000);
    // Far beyond anything hand-written, and well inside a tick - which is the
    // point: a cache lookup should not cost 37 ms.
    expect(MAX_DEEP_EQUAL_NODES).toBeLessThanOrEqual(100_000);
  });
});

describe('hasEqual: compareFn escape hatch', () => {
  it('short-circuits values the walk cannot model', () => {
    // A class with a *private* field: the structural walk sees no own
    // enumerable keys, so without a comparator every instance looks identical.
    // This is the case the escape hatch exists for, and it is why `compareFn`
    // is not merely an optimisation hook.
    class Token {
      #secret;
      constructor(secret) {
        this.#secret = secret;
      }
      get secret() {
        return this.#secret;
      }
    }
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('a', new Token('one'));
    // Without a comparator, the walk finds nothing to compare and says equal.
    expect(cache.hasEqual('a', new Token('two'))).toBe(true);

    const cmp = (x, y) =>
      x instanceof Token && y instanceof Token ? x.secret === y.secret : undefined;
    expect(cache.hasEqual('a', new Token('one'), { compareFn: cmp })).toBe(true);
    expect(cache.hasEqual('a', new Token('two'), { compareFn: cmp })).toBe(false);
  });

  it('returning undefined means "no opinion" and the walk continues', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('k', { a: 1, b: [2, 3] });
    // The comparator declines everything, so the structural walk must decide.
    const decline = () => undefined;
    expect(cache.hasEqual('k', { a: 1, b: [2, 3] }, { compareFn: decline })).toBe(true);
    expect(cache.hasEqual('k', { a: 1, b: [2, 4] }, { compareFn: decline })).toBe(false);
  });
});

describe('hasEqual: unchanged behaviour', () => {
  it('reference equality still short-circuits before any budget', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    const big = objects(50_000);
    cache.set('k', big);
    // The *same* object. `a === b` is the cheapest correct answer and it must
    // not be rationed, or a caller storing and passing back the same reference
    // would see a cache miss on a million-node value.
    expect(cache.hasEqual('k', big, { maxNodes: 5 })).toBe(true);
  });

  it('cycles still terminate', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    const a = { name: 'a' };
    const b = { name: 'b', a };
    a.b = b;
    const a2 = { name: 'a' };
    const b2 = { name: 'b', a: a2 };
    a2.b = b2;
    cache.set('k', a);
    expect(cache.hasEqual('k', a2)).toBe(true);
  });

  it('a caller-supplied seen map is still honoured', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('k', { deep: { a: 1 } });
    // `WeakMap` has no `size`, so the caller's map is observed by what it
    // holds rather than by how much of it. The point of the option is reuse
    // across calls without a per-comparison allocation, so two calls sharing
    // one map must both work.
    const seen = new WeakMap();
    expect(cache.hasEqual('k', { deep: { a: 1 } }, { seen })).toBe(true);
    expect(cache.hasEqual('k', { deep: { a: 1 } }, { seen })).toBe(true);
  });

  it('primitives and the obvious fast paths are unchanged', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('s', 'hello');
    cache.set('d', new Date(0));
    cache.set('u', new Uint8Array([1, 2, 3]));
    expect(cache.hasEqual('s', 'hello')).toBe(true);
    expect(cache.hasEqual('s', 'other')).toBe(false);
    expect(cache.hasEqual('d', new Date(0))).toBe(true);
    expect(cache.hasEqual('d', new Date(1))).toBe(false);
    expect(cache.hasEqual('u', new Uint8Array([1, 2, 3]))).toBe(true);
    expect(cache.hasEqual('u', new Uint8Array([1, 2, 4]))).toBe(false);
  });
});
