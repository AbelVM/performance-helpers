/**
 * `{ admission: 'tinylfu' }` on `PowerCache` (ALG-002).
 *
 * The headline number is scan resistance: an LRU admits anything that misses,
 * so a one-off scan over a larger key space evicts the entire working set.
 * TinyLFU refuses an insertion when the entry it would evict is still wanted.
 *
 * Off by default. `{ policy: 'slru' }` already resists this particular scan, so
 * these tests also pin that the two are complementary rather than additive -
 * see the `slru` cases at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

const HOT = 40;
const SCAN = 500;

/** A cache warmed with a working set, then hit by a one-off scan. */
function scanResistance(options) {
  const cache = new PowerCache({ maxEntries: HOT, ...options });
  const hot = [];
  for (let i = 0; i < HOT; i += 1) hot.push(`hot-${i}`);
  for (let pass = 0; pass < 5; pass += 1) for (const k of hot) cache.set(k, pass);
  for (let i = 0; i < SCAN; i += 1) cache.set(`scan-${i}`, 1);
  let survived = 0;
  for (const k of hot) if (cache.has(k)) survived += 1;
  return survived;
}

describe('PowerCache { admission: tinylfu }', () => {
  it('is off by default, and off means no sketch', () => {
    const cache = new PowerCache({ maxEntries: 10 });
    expect(cache._sketch).toBeNull();
  });

  it('resists a one-off scan that evicts the whole working set under LRU', () => {
    const plain = scanResistance({ policy: 'lru' });
    const filtered = scanResistance({ policy: 'lru', admission: 'tinylfu' });
    // The benchmark the audit describes. Plain LRU keeps none of the working
    // set; the filter keeps the large majority.
    expect(plain).toBe(0);
    expect(filtered).toBeGreaterThan(HOT * 0.75);
  });

  it('does not weaken policy slru, which already resists this scan', () => {
    // Worth stating plainly rather than implying the two compose: slru got
    // here first, and TinyLFU's contribution is to bring plain LRU up to the
    // same place.
    expect(scanResistance({ policy: 'slru' })).toBe(HOT);
    expect(scanResistance({ policy: 'slru', admission: 'tinylfu' })).toBe(HOT);
  });

  it('still honours maxEntries - admission is a filter, not a licence to grow', () => {
    const cache = new PowerCache({ maxEntries: 10, admission: 'tinylfu' });
    for (let i = 0; i < 200; i += 1) cache.set(`k${i}`, i);
    expect(cache.size).toBeLessThanOrEqual(10);
  });

  it('still honours maxWeight', () => {
    const cache = new PowerCache({ maxEntries: 1000, maxWeight: 50, admission: 'tinylfu' });
    for (let i = 0; i < 200; i += 1) cache.set(`k${i}`, 'x'.repeat(10));
    expect(cache.currentWeight).toBeLessThanOrEqual(50);
  });

  it('reads count towards frequency, not just writes', () => {
    // Without this a read-mostly cache would admit one-off writes on the
    // strength of a history it never had.
    const cache = new PowerCache({ maxEntries: HOT, policy: 'lru', admission: 'tinylfu' });
    const hot = [];
    for (let i = 0; i < HOT; i += 1) hot.push(`hot-${i}`);
    for (let pass = 0; pass < 5; pass += 1) for (const k of hot) cache.set(k, pass);
    // Now *read* the hot set, so the frequency comes from hits rather than only
    // from the writes above.
    for (let pass = 0; pass < 5; pass += 1) for (const k of hot) cache.get(k);
    for (let i = 0; i < SCAN; i += 1) cache.set(`scan-${i}`, 1);
    let survived = 0;
    for (const k of hot) if (cache.has(k)) survived += 1;
    expect(survived).toBeGreaterThan(0);
  });

  it('on a tie, keeps the incumbent rather than churning for a coin flip', () => {
    // A newly inserted key has no history, so an equal estimate is not evidence
    // that it is the better bet.
    const cache = new PowerCache({ maxEntries: 4, policy: 'lru', admission: 'tinylfu' });
    const existing = ['a', 'b', 'c', 'd'];
    for (const k of existing) cache.set(k, 1);
    // Every key has estimate 1; a tie must not evict.
    for (let i = 0; i < 20; i += 1) cache.set(`new-${i}`, 1);
    expect(existing.filter((k) => cache.has(k)).length).toBe(4);
  });

  it('clear() drops the frequency history with the entries', () => {
    // Carrying a tuned history across a clear would let the next admission
    // decisions be made from a workload that no longer exists.
    const cache = new PowerCache({ maxEntries: HOT, policy: 'lru', admission: 'tinylfu' });
    for (let i = 0; i < 20; i += 1) cache.set(`k${i}`, i);
    expect(cache._sketch.estimate('k0')).toBeGreaterThan(0);
    cache.clear();
    expect(cache._sketch.estimate('k0')).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('counts the insertions it refused', () => {
    // A filter that silently discards is indistinguishable from one that is
    // broken; the count is how a caller finds out.
    const cache = new PowerCache({ maxEntries: 5, policy: 'lru', admission: 'tinylfu' });
    for (let i = 0; i < 5; i += 1) cache.set(`hot-${i}`, i);
    for (let i = 0; i < 5; i += 1) for (let r = 0; r < 3; r += 1) cache.get(`hot-${i}`);
    for (let i = 0; i < 200; i += 1) cache.set(`scan-${i}`, i);
    expect(cache._rejectedAdmission).toBeGreaterThan(0);
  });

  it('builds a sketch under LRU and **not** under SLRU', () => {
    // **Breaking, deliberately.** SLRU's probation segment is the same mechanism
    // the sketch provides - both absorb one-shot traffic before it reaches the
    // main region - and stacking them measured as the worst variant rather than a
    // weaker one: `slru` + `tinylfu` retained 70.9 % of the working set against
    // `slru` alone's 89.4 % on `node bench/claims.js zipf`. A user composing
    // "the two scan-resistant options" got the worse of each.
    //
    // This test previously asserted `_sketch` was non-null under both policies,
    // pinning the behaviour being removed. It is written the other way on
    // purpose, and it is what keeps the combination stable if someone re-adds
    // the sketch for `slru`.
    const lru = new PowerCache({ maxEntries: 10, policy: 'lru', admission: 'tinylfu' });
    lru.set('a', 1);
    expect(lru.get('a')).toBe(1);
    expect(lru._sketch).not.toBeNull();

    const slru = new PowerCache({ maxEntries: 10, policy: 'slru', admission: 'tinylfu' });
    slru.set('a', 1);
    expect(slru.get('a')).toBe(1);
    expect(slru._sketch).toBeNull();
    // That it is *still SLRU* is asserted by the next test, behaviourally.
    // There is no public `policy` getter to check, and reaching for a private
    // field would pin an implementation detail that the behavioural comparison
    // already covers more honestly.

    const off = new PowerCache({ maxEntries: 10, admission: undefined });
    expect(off._sketch).toBeNull();
  });

  it('leaves slru behaviour identical with and without the option', () => {
    // The strongest form of the claim: not "the sketch is null" but "you cannot
    // tell the difference", measured by driving both caches through the same
    // workload and comparing results. A weaker test would pass while some other
    // part of the slru path still consulted the option.
    const drive = (cache) => {
      for (let i = 0; i < 20; i += 1) cache.set(`k${i % 8}`, i);
      for (let i = 0; i < 40; i += 1) cache.get(`k${i % 8}`);
      for (let i = 0; i < 60; i += 1) cache.set(`scan-${i}`, i);
      return {
        keys: [...cache.keys()].sort(),
        size: cache.size,
        stats: cache.stats(),
      };
    };
    const withOption = drive(
      new PowerCache({ maxEntries: 10, policy: 'slru', admission: 'tinylfu' })
    );
    const without = drive(new PowerCache({ maxEntries: 10, policy: 'slru' }));
    expect(withOption).toEqual(without);
  });
});
