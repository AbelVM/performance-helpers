import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

/**
 * PERF-003: `set` and `setMany` read the node map once, not twice.
 *
 * ## Why a counter and not a duration
 *
 * The row asked for a `Map.has` before a `Map.get` to be dropped from `set`. That is
 * a work reduction, and the honest way to assert a work reduction is to count the
 * work. A timing assertion here would be actively misleading: the change removes
 * roughly one `Map.get` on half the calls, and **BENCH-001 measures a 28 % median
 * min/max spread on this machine**, so the effect sits far inside the noise. Worse,
 * `node bench/claims.js zipf` — the mode whose own header calls its timing column
 * "secondary" and uninformative below that spread — does not isolate this path at
 * all; it measures admission policy and hit rate.
 *
 * So the speed claim is **withdrawn** rather than asserted, and what is pinned
 * instead is the thing that is actually true and could regress: the number of reads.
 * A change that put the `has` back would pass every timing assertion anyone could
 * write here, and fails this one.
 *
 * ## The `undefined` case is the whole risk
 *
 * Collapsing `has(key)` into `get(key) !== undefined` is only safe because `_map`
 * holds **nodes**, which are objects. On a map of raw values it would be a bug: a
 * key legitimately holding `undefined` is indistinguishable from an absent one, and
 * the update path would insert a second entry instead of overwriting. That is not a
 * hypothetical, so it is pinned below.
 */

/**
 * Count `has` / `get` reads against a cache's real node map.
 *
 * Instrumenting the map the instance already holds, rather than a stand-in, is the
 * point: a counter on a private harness would not prove anything about the code
 * under test.
 *
 * @param {PowerCache} cache
 * @returns {{has:number, get:number}} Live counters, mutated by the wrapped map.
 */
function countLookups(cache) {
  /** @type {{has:number, get:number}} */
  const counts = { has: 0, get: 0 };
  const map = /** @type {any} */ (cache)._map;
  for (const name of /** @type {const} */ (['has', 'get'])) {
    const original = map[name].bind(map);
    map[name] = (...args) => {
      counts[name] += 1;
      return original(...args);
    };
  }
  return counts;
}

describe('PERF-003: set reads the node map once', () => {
  it('set() on an existing key does one read, not two', () => {
    const cache = new PowerCache({ maxEntries: 100 });
    cache.set('a', 1);
    const counts = countLookups(cache);
    cache.set('a', 2);
    // The regression this pins: `has(key)` followed by `_updateExisting`'s own
    // `get(key)` was two reads of one key, on the hot path, for every overwrite.
    expect(counts.get).toBe(1);
    // And `has` is not called at all on this path any more.
    expect(counts.has).toBe(0);
  });

  it('set() on a new key still does exactly one read', () => {
    // The miss path was already one lookup, so this guards against "fixing" the hit
    // path by adding a speculative read ahead of it.
    const cache = new PowerCache({ maxEntries: 100 });
    const counts = countLookups(cache);
    cache.set('fresh', 1);
    expect(counts.get).toBe(1);
    expect(counts.has).toBe(0);
  });

  it('setMany() gets the same treatment', () => {
    // The second site the row names. A fix applied to one call site and not the other
    // is the usual way a row like this ends up half done.
    const cache = new PowerCache({ maxEntries: 100 });
    cache.set('a', 1);
    cache.set('b', 1);
    const counts = countLookups(cache);
    cache.setMany([
      ['a', 2],
      ['b', 2],
    ]);
    expect(counts.get).toBe(2);
    expect(counts.has).toBe(0);
  });

  it('a mixed batch reads once per entry, hit or miss', () => {
    const cache = new PowerCache({ maxEntries: 100 });
    cache.set('a', 1);
    const counts = countLookups(cache);
    cache.setMany([
      ['a', 2],
      ['new', 1],
    ]);
    expect(counts.get).toBe(2);
    expect(counts.has).toBe(0);
  });
});

describe('PERF-003: collapsing has into get is safe only because _map holds nodes', () => {
  it('overwrites a key whose stored value is undefined, rather than inserting twice', () => {
    // **This is the test that justifies the change.** On a map of raw values,
    // `get(key) !== undefined` would take the *insert* branch here and leave the
    // original entry in place alongside a second one. It works because `_map`
    // stores node objects, and it would silently stop working if that changed.
    const cache = new PowerCache({ maxEntries: 100 });
    cache.set('u', undefined);
    expect(cache.has('u')).toBe(true);
    expect(cache.get('u')).toBeUndefined();

    cache.set('u', 'now a value');

    expect(cache.get('u')).toBe('now a value');
    // One entry, not two: the overwrite replaced the node rather than adding one.
    expect(cache.size).toBe(1);
  });

  it('still updates weight and recency on an overwrite of an undefined value', () => {
    // The node, not the value, is what the update path mutates. If the collapsed
    // lookup ever handed back something else, weight accounting would drift rather
    // than throw — so this asserts the observable consequence.
    // No injected clock: the assertions are about weight *bookkeeping*, which does
    // not move with time, and an injected clock that is never advanced would be a
    // `prefer-const` error and a lie about what the test controls.
    const cache = new PowerCache({ maxEntries: 10, weightFn: () => 2 });
    cache.set('u', undefined);
    expect(cache.stats().weight).toBe(2);
    cache.set('u', 'v');
    // Replaced, not accumulated: a double insert would read 4.
    expect(cache.stats().weight).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('an absent key still takes the insert path', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    cache.set('nope', 1);
    expect(cache.has('nope')).toBe(true);
    expect(cache.size).toBe(1);
  });
});
