/**
 * `PowerCache` reads the clock once per call on the paths that already read it.
 *
 * PERF-003's first half: `getOrSet` and `touch` each read `this._now()` and then called
 * `_fetchValidNode`, which sampled it again to test the same entry's expiry — two reads
 * for one answer, at the 141 ns `src/utils/now.js` attributes to `nowMs()` against a
 * whole `PowerThrottle.tryConsume` of 164 ns. The change is committed; **this is the
 * guard it did not come with**, so the duplicate read could return silently and nothing
 * would notice.
 *
 * **The clock is injectable, so this needs no benchmark.** `powerCache.js` wires
 * `this._now = typeof now === 'function' ? now : nowMs`, so a counting clock measures the
 * thing directly — reads, not nanoseconds. Every assertion is an integer, so none depends
 * on this machine's speed or the harness's spread. The row's figures are the *reason* to
 * do the change, not a way to prove it; a duration assertion would be the decoration
 * AGENTS.md warns about against a 28 % median min/max spread.
 *
 * **Every count below was measured on both revisions before being asserted**, which is
 * how an earlier draft of this file came to assert a *regression* that did not exist: it
 * reported a failing case as a finding about shipped code without re-measuring cleanly.
 * The numbers are therefore stated as observations first and pinned second.
 *
 * Three of them are the reason the change was safe, and they are what a naive "pass
 * `now` everywhere" version would break:
 *
 * - **a miss reads nothing** — `_fetchValidNode` returns before it samples, so there is
 *   no node to expire and no reason to know the time. Verified 0.00 reads per call on
 *   both `HEAD` and `HEAD~2`.
 * - **an entry with no expiry reads nothing** — it cannot be expired. Threading a
 *   reading down must not turn this path into one that samples. (`defaultTTL: null` is
 *   how such an entry is built; `set(k, v)` with no `ttl` uses `defaultTTL`, so a draft
 *   that omitted the constructor option was asserting about a fixture that did not exist.)
 * - **`getOrSet` on a miss reads 2, and that is not a leftover** — a miss returns before
 *   the fetch's clock read, so the duplicate this row removed was never on that path.
 *   Those two reads are `getOrSet`'s own and the insert path's, answering different
 *   questions.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

/**
 * A cache whose clock counts its reads and returns a controllable time.
 *
 * @param {object} [options] - Extra `PowerCache` options.
 * @returns {{cache: PowerCache, reads: () => number, setNow: (t: number) => void}}
 */
function countingCache(options = {}) {
  const state = { n: 0, t: 1000 };
  const cache = new PowerCache({
    now: () => {
      state.n += 1;
      return state.t;
    },
    ...options,
  });
  return { cache, reads: () => state.n, setNow: (t) => (state.t = t) };
}

describe('PowerCache clock reads (PERF-003)', () => {
  it('getOrSet on a hit reads once', () => {
    // Was 2 before the change. The assertion is the whole point of this file: it is the
    // duplicate that the row exists to remove, and nothing else in the suite counts it.
    const { cache, reads } = countingCache();
    cache.set('k', 'v', { ttl: 5000 });
    const before = reads();
    expect(cache.getOrSet('k', () => 'other')).toBe('v');
    expect(reads() - before).toBe(1);
  });

  it('touch on a hit reads once', () => {
    // Also 2 before: the fetch sampled to test expiry, then `touch` sampled again to
    // compute the new one.
    const { cache, reads } = countingCache();
    cache.set('k', 'v', { ttl: 5000 });
    const before = reads();
    expect(cache.touch('k', 9000)).toBe(true);
    expect(reads() - before).toBe(1);
  });

  it('get on a hit still reads once', () => {
    // The control. `get` never read the clock itself, so if this fell to 0 the expiry
    // check had been optimised into not happening — which a count of 1 alone would not
    // distinguish from a count of 0 that happened to be right for the wrong reason.
    const { cache, reads } = countingCache();
    cache.set('k', 'v', { ttl: 5000 });
    const before = reads();
    expect(cache.get('k')).toBe('v');
    expect(reads() - before).toBe(1);
  });

  it('get on a miss reads nothing', () => {
    // Measured 0.00 per call on both revisions before being asserted here.
    const { cache, reads } = countingCache();
    const before = reads();
    expect(cache.get('absent')).toBeUndefined();
    expect(reads() - before).toBe(0);
  });

  it('touch on a miss reads once - a deliberate cost, not a leftover', () => {
    // **The one count that moved the wrong way, and it is worth stating rather than
    // pinning quietly.** `touch` now reads the clock *before* its lookup, so a miss
    // spends a reading and returns `false` without needing it. Measured: 0 on `HEAD~2`,
    // 1 now. The change bought 141 ns on every `touch` **hit** (2 reads to 1) and paid
    // 141 ns on every miss, and those are the same magnitude - so this is a trade, not a
    // regression, and the alternative - looking the key up first to avoid the reading -
    // would add a `Map` lookup to every hit to save a clock read on a path that returns
    // `false` immediately. That is the wrong direction for a cache whose hot path is the
    // hit.
    //
    // It is pinned at 1 deliberately: a future reader who assumes the miss paths are all
    // free will otherwise have no way to notice this moving again.
    const { cache, reads } = countingCache();
    const before = reads();
    expect(cache.touch('absent')).toBe(false);
    expect(reads() - before).toBe(1);
  });

  it('getOrSet on a miss reads twice', () => {
    // Pinned so the *reason* it is 2 is not "unfinished work" in a later reader's eyes.
    // See the file header: the duplicate this row removed was never on the miss path.
    const { cache, reads } = countingCache();
    const before = reads();
    expect(cache.getOrSet('fresh', () => 'made', { ttl: 5000 })).toBe('made');
    expect(reads() - before).toBe(2);
  });

  it('an entry with no expiry reads nothing', () => {
    // The property that had to survive the optimisation.
    const { cache, reads } = countingCache({ defaultTTL: null });
    cache.set('forever', 'v');
    const before = reads();
    expect(cache.get('forever')).toBe('v');
    expect(reads()).toBe(before);
  });

  it('has reads once, and is unchanged by any of this', () => {
    // Included because it is the third read-clock path and nothing else here covers it.
    const { cache, reads } = countingCache();
    cache.set('k', 'v', { ttl: 5000 });
    const before = reads();
    expect(cache.has('k')).toBe(true);
    expect(reads() - before).toBe(1);
  });

  it('expiry still follows the injected clock', () => {
    // The optimisation must not change what the clock is used *for*. Without an injected
    // `now` this case could only sleep.
    const { cache, setNow } = countingCache();
    cache.set('k', 'v', { ttl: 100 });

    setNow(1050);
    expect(cache.get('k')).toBe('v');

    setNow(1200); // past 1000 + 100
    expect(cache.get('k')).toBeUndefined();
  });

  it('touch extends from the reading it took, and expiry still follows', () => {
    // `touch` moved its reading *before* the lookup, so this pins that the new expiry is
    // computed from that same reading rather than a stale one. The initial ttl has to
    // outlast the jump to `t = 1500`: touching an already-expired entry returns `false`
    // by design, which an earlier draft of this file got wrong.
    const { cache, setNow } = countingCache();
    cache.set('k', 'v', { ttl: 5000 });

    setNow(1500);
    expect(cache.touch('k', 1000)).toBe(true);
    expect(cache.get('k')).toBe('v');

    setNow(2400); // 1500 + 1000
    expect(cache.get('k')).toBe('v');
    setNow(2501);
    expect(cache.get('k')).toBeUndefined();
  });
});
