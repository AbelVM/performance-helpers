/**
 * `invalidate(predicate)` and `evict(count)` — GAP-017.
 *
 * Both are bulk removal, and both were missing while the cache could only drop
 * entries one `delete()` at a time or all at once with `clear()`. The row also
 * asked for `entriesAscending()` / `entriesDescending()`; those were declined and
 * the reason is recorded in `powerCache.js` next to the code — `entries(order)`
 * already takes both orders, so the aliases would be a second spelling of one
 * decision.
 *
 * What these tests are really for is the two ways a bulk removal corrupts a
 * linked-list cache without throwing: it walks a generator that cannot survive
 * its own removals, and it leaves a cached head pointer aimed at a freed node.
 * Both fail *silently* — a wrong eviction order or a growing `size`, never an
 * exception — so the assertions here are counters and orderings, checked after
 * the fact rather than by watching the call.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

/**
 * A cache holding `count` entries keyed `0..count-1`, each inserted in order, so
 * key 0 is the least recently used and key `count-1` the most.
 *
 * @param {number} count
 * @param {Object} [options] - Extra `PowerCache` options, e.g. `onEvict`.
 * @returns {PowerCache}
 */
function filled(count, options = {}) {
  const cache = new PowerCache({ maxEntries: count + 4, ...options });
  for (let i = 0; i < count; i += 1) cache.set(i, i * 10);
  return cache;
}

describe('PowerCache.invalidate(predicate)', () => {
  it('removes every matching entry and returns how many', () => {
    const cache = filled(5);
    expect(cache.invalidate((k) => k % 2 === 0)).toBe(3);
    expect([...cache.keys('LRU')]).toEqual([1, 3]);
    expect(cache.stats().size).toBe(2);
    expect(cache.has(2)).toBe(false);
    expect(cache.get(3)).toBe(30);
  });

  it('finds adjacent matches, which a walk driven by entries() cannot', () => {
    // The discriminating test. `entries()` documents that removing two
    // *adjacent* entries in one iteration step may end its walk early — so an
    // implementation that drove removal off the public generator would stop at
    // the first pair and report a number, not an error. Keys 1,2 and 3,4 are
    // adjacent on purpose; 0 and 5 bracket them.
    const cache = filled(6);
    expect(cache.invalidate((k) => k > 0 && k < 5)).toBe(4);
    expect([...cache.keys('LRU')]).toEqual([0, 5]);
    expect(cache.stats().size).toBe(2);
  });

  it('reports onEvict with reason invalidated, once per removal', () => {
    // A new reason string, so a caller can tell a policy removal from an
    // explicit one. `'evicted'` would be wrong here: nothing was over capacity.
    const seen = [];
    const cache = filled(4, { onEvict: (k, v, reason) => seen.push([k, v, reason]) });
    cache.invalidate((k) => k < 2);
    expect(seen).toEqual([
      [0, 0, 'invalidated'],
      [1, 10, 'invalidated'],
    ]);
  });

  it('leaves the cache untouched when the predicate throws', () => {
    // The reason the predicate runs over a snapshot. A bulk removal that applied
    // as it went would leave half the entries gone with no way to tell which
    // half, and nothing in `stats()` that says so.
    const cache = filled(6);
    let calls = 0;
    expect(() =>
      cache.invalidate(() => {
        calls += 1;
        if (calls === 3) throw new Error('boom');
        return true;
      })
    ).toThrow('boom');
    expect(calls).toBe(3);
    expect(cache.stats().size).toBe(6);
    expect([...cache.keys('LRU')]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('does not double-remove or over-count when the predicate deletes as a side effect', () => {
    // The predicate is caller code and may call `delete()` on what it is looking
    // at. `invalidate` collects first, so a node collected on an *earlier* call
    // can be gone by the time the removal loop reaches it: unlinking a freed node
    // would corrupt the node pool, and counting it would report a removal that
    // did not happen.
    //
    // The ordering is the whole test, and my first attempt got it wrong: deleting
    // the key the predicate was *currently* looking at removes it during the
    // collect walk, so it is never collected at all and the guard is unreachable.
    // The delete has to hit a node collected by a **previous** call — hence
    // `delete(k - 1)` while visiting `k`, and `invalidate` walks LRU→MRU.
    const cache = filled(4);
    const seen = [];
    const removed = cache.invalidate((k) => {
      seen.push(k);
      if (k === 1) cache.delete(0); // already collected, still linked
      return k === 0 || k === 1;
    });
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(removed).toBe(1); // only key 1 was actually removed
    expect(cache.stats().size).toBe(2);
    expect([...cache.keys('LRU')]).toEqual([2, 3]);
  });

  it('rejects a non-function predicate', () => {
    const cache = filled(2);
    for (const bad of [null, undefined, 'x', 3, {}]) {
      expect(() => cache.invalidate(bad)).toThrow(TypeError);
    }
    expect(cache.stats().size).toBe(2);
  });

  it('returns 0 on an empty cache and on a predicate that matches nothing', () => {
    const empty = new PowerCache();
    expect(empty.invalidate(() => true)).toBe(0);
    const cache = filled(3);
    expect(cache.invalidate(() => false)).toBe(0);
    expect(cache.stats().size).toBe(3);
  });

  it('leaves the cache able to evict correctly afterwards', () => {
    // The silent-corruption case. `_evictionCandidate` is a cached head pointer;
    // a removal that does not repair it aims the next sweep at a freed node,
    // which shows up as a cache that stops evicting or a `size` that drifts —
    // never as an error. So: fill past capacity after the bulk removal and count.
    const cache = new PowerCache({ maxEntries: 4 });
    for (let i = 0; i < 4; i += 1) cache.set(i, i);
    cache.invalidate(() => true);
    expect(cache.stats().size).toBe(0);
    for (let i = 0; i < 10; i += 1) cache.set(i, i);
    expect(cache.stats().size).toBe(4);
    // The four *most recent* survive an LRU sweep — 9 at the MRU end, 6 at LRU.
    expect([...cache.keys('LRU')]).toEqual([6, 7, 8, 9]);
  });

  it('counts the removals in stats().evictions', () => {
    // Same counter as a policy eviction, deliberately: both freed a node and both
    // called `onEvict`. A caller watching memory cannot otherwise tell.
    const cache = filled(4);
    const before = cache.stats().evictions;
    cache.invalidate((k) => k % 2 === 0);
    expect(cache.stats().evictions).toBe(before + 2);
  });
});

describe('PowerCache.evict(count)', () => {
  it('evicts least-recently-used first and returns the count', () => {
    const cache = filled(5);
    expect(cache.evict(2)).toBe(2);
    expect([...cache.keys('LRU')]).toEqual([2, 3, 4]);
    expect(cache.stats().size).toBe(3);
  });

  it("uses the caller's recency, not insertion order", () => {
    // `quick-lru`'s `evict(n)` — the API this row is copied from — evicts by
    // recency, so a key read since it was written goes first. Getting this wrong
    // evicts the wrong two entries and still reports 2.
    const cache = filled(4);
    cache.get(0); // 0 becomes the most recent, so LRU order is 1, 2, 3, 0
    expect(cache.evict(2)).toBe(2);
    expect([...cache.keys('LRU')]).toEqual([3, 0]);
  });

  it('reports the number actually removed, not the number asked for', () => {
    // `evict(1e9)` on an empty cache reporting 1000000000 would be a lie a
    // caller could act on.
    const cache = filled(3);
    expect(cache.evict(99)).toBe(3);
    expect(cache.stats().size).toBe(0);
    expect(cache.evict(99)).toBe(0);
    expect(new PowerCache().evict(5)).toBe(0);
  });

  it('defaults to one', () => {
    const cache = filled(3);
    expect(cache.evict()).toBe(1);
    expect(cache.stats().size).toBe(2);
  });

  it('accepts 0 and removes nothing', () => {
    const cache = filled(3);
    expect(cache.evict(0)).toBe(0);
    expect(cache.stats().size).toBe(3);
  });

  it('reports onEvict with reason evicted and counts it', () => {
    // The same reason and the same counter as the capacity sweep, because it is
    // the same event: a node left the cache and the caller was told.
    const seen = [];
    const cache = filled(3, { onEvict: (k, v, reason) => seen.push([k, reason]) });
    const before = cache.stats().evictions;
    cache.evict(2);
    expect(seen).toEqual([
      [0, 'evicted'],
      [1, 'evicted'],
    ]);
    expect(cache.stats().evictions).toBe(before + 2);
  });

  it('refuses a count that does not name one, rather than coercing it', () => {
    // `Number()` would make `null` 0 (silently do nothing), `true` 1 (silently
    // evict one) and `'3'` 3. A typo in a count must not read as a deliberate
    // value — the same rule the TTL normaliser in this class already applies.
    const cache = filled(3);
    for (const bad of [-1, 1.5, NaN, Infinity, '3', null, true, {}]) {
      expect(() => cache.evict(bad)).toThrow(TypeError);
    }
    expect(cache.stats().size).toBe(3);
  });

  it('leaves the cache able to fill and evict correctly afterwards', () => {
    const cache = new PowerCache({ maxEntries: 3 });
    for (let i = 0; i < 3; i += 1) cache.set(i, i);
    cache.evict(3);
    expect(cache.stats().size).toBe(0);
    for (let i = 0; i < 8; i += 1) cache.set(i, i);
    expect(cache.stats().size).toBe(3);
    expect([...cache.keys('LRU')]).toEqual([5, 6, 7]);
  });

  it('aborts an in-flight fetch for the entry it removes', async () => {
    // Same obligation as `delete()` and the capacity sweep (GAP-003): a factory
    // handed an `AbortSignal` must be signalled, or it runs to completion and
    // writes its result into a cache that no longer wants it.
    //
    // Two things had to be right, and my first attempt got both wrong. A key
    // mid-`getOrSetAsync` is **not resident**, so it cannot be selected — the
    // entry needs a node first. And filling to capacity to make it the eviction
    // candidate means the **capacity sweep** removes it, not `evict()`: the test
    // passed with `_abortInflight` deleted from `evict`, which is the definition
    // of a test that cannot fail on the thing it names. So: `evict(1)` explicitly,
    // with room to spare so no sweep can fire.
    const c = new PowerCache({ maxEntries: 8, defaultTTL: 60_000 });
    let signal = null;
    const factory = (s) => {
      signal = s;
      return new Promise(() => {});
    };
    void c.getOrSetAsync('a', factory).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    c.set('a', 'placeholder'); // now resident, and the only entry
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(c.evict(1)).toBe(1);
    expect(signal.aborted).toBe(true);
  });
});
