import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

/**
 * Three defects in `PowerCache`'s eviction cursor and TTL handling.
 *
 * `CACHE-003` is a live bug with a deterministic reproduction. `CACHE-001` and
 * `CACHE-002` are not, and the file says so where it matters — see the note on
 * the cursor tests, which is the most important comment in it.
 */

/**
 * Is `node` reachable from the head?
 *
 * The invariant a cursor has to satisfy: it may name a live node or nothing, and
 * never a node whose links `_remove` has already nulled. The consequence of
 * breaking it is not a wrong eviction but a destroyed list — `_evictIfNeeded`
 * hands the detached node to `_unlinkNode`, whose `!p` and `!n` branches set
 * `_head` and `_tail` to `null` while `size` still reads 5.
 *
 * @param {import('../src/index.js').PowerCache} cache
 * @param {object} node
 * @returns {boolean}
 */
function isLive(cache, node) {
  for (let n = cache._head; n; n = n.next) if (n === node) return true;
  return false;
}

describe('PowerCache TTL normalisation (CACHE-003)', () => {
  /**
   * The reproduction. `now + ttl` on a non-number is string concatenation, so the
   * stored `expiresAt` became `"01e3"`, every expiry comparison produced `NaN`,
   * and `NaN > anything` is `false` — an entry that never expires. A
   * one-character typo in a config value silently disabled expiry, which is the
   * worst direction a cache has to fail in: the value looks accepted, and
   * memory grows until something unrelated breaks.
   */
  it('rejects a TTL that is not a number instead of storing a string', () => {
    const clock = 0;
    const cache = new PowerCache({ now: () => clock });
    expect(() => cache.set('k', 'v', { ttl: 'abc' })).toThrow(TypeError);
    expect(() => cache.set('k', 'v', { ttl: 'abc' })).toThrow(/must be a finite number/);
    // The shape of the old bug, asserted directly so the fix cannot be a
    // narrower guard that happens to miss this input: a numeric *string* is
    // accepted, and stored as a number.
    //
    // Note `'1e3'` is one of them — `Number('1e3') === 1000`. It appears in
    // `review.md` as CACHE-003's example of a bad value, and the row is wrong
    // about that: the string was never the problem, the *concatenation* was.
    // Before the fix `{ ttl: '1e3' }` stored `"01e3"`; now it stores a number and
    // expires correctly, which is the right outcome.
    cache.set('k', 'v', { ttl: '1000' });
    expect(typeof cache._map.get('k').expiresAt).toBe('number');
    expect(cache._map.get('k').expiresAt).toBe(1000);
    cache.set('k2', 'v', { ttl: '1e3' });
    expect(cache._map.get('k2').expiresAt).toBe(1000);
  });

  it('rejects a non-number type that coerces to a plausible duration', () => {
    // Found while probing the validation surface rather than by reading the row.
    // `Number([]) === 0` and `Number(true) === 1`, so a value check alone would
    // have accepted `{ ttl: [] }` as "expire now" and `{ ttl: true }` as "one
    // millisecond" — the same silent-misconfiguration failure as the string case,
    // one layer further down.
    const clock = 0;
    const cache = new PowerCache({ now: () => clock });
    for (const bad of [[], true, {}, new Date(0)]) {
      expect(() => cache.set('k', 1, { ttl: bad })).toThrow(TypeError);
    }
    // `null` and `undefined` are *not* non-numbers: they mean "no expiry" and
    // "use the default" respectively, and both must keep working.
    expect(() => cache.set('k', 1, { ttl: null })).not.toThrow();
    expect(() => cache.set('k', 1, {})).not.toThrow();
  });

  it('agrees across set, setMany and touch, which each had their own copy', () => {
    // The row's ask was one shared helper, so this asserts the three agree rather
    // than that any one of them is right — the original defect was three copies
    // of the same arithmetic, and fixing two would have left the third.
    const clock = 500;
    const cache = new PowerCache({ now: () => clock });
    cache.set('present', 1, { ttl: 1000 });
    expect(() => cache.set('a', 1, { ttl: 'nope' })).toThrow(TypeError);
    expect(() => cache.setMany([['b', 1]], { ttl: 'nope' })).toThrow(TypeError);
    // `touch` only reaches the expiry arithmetic for a key that exists, so the
    // entry has to be there first — otherwise this would pass vacuously.
    expect(() => cache.touch('present', 'nope')).toThrow(TypeError);
    // And the throw left the existing entry alone rather than half-updating it.
    expect(cache.get('present')).toBe(1);
  });

  it('keeps { ttl: 0 } meaning "expire now" and nullish meaning "never"', () => {
    // The distinction the stored sentinel makes impossible to see, so it is
    // asserted directly. `0` is the on-disk value for "no expiry", which makes it
    // very easy to conflate the two by accident.
    //
    // The boundary is `_fetchValidNode`'s `expiresAt <= now`: an entry is alive
    // strictly *before* its expiry and lapses at it. That is the opposite of
    // `PowerTTLMap`, which stores `now + ttl + 1` and reads back `now >
    // expiresAt` so it survives exactly at its TTL. Both are deliberate, and
    // pinned independently — the asymmetry is real and a reader should not
    // assume they agree.
    //
    // **The other half of that pair is `test/invariants.test.js`**, "expires on
    // the far side of the boundary, not at it", which pins the `PowerTTLMap`
    // side and gives its reason. This asymmetry was once filed as a defect to
    // standardise away; it was measured (a shared `ttl: 100` gives lifetimes
    // differing by one to two ticks) and rejected, because both sides are
    // deliberate and neither difference is observable to a caller. If you are
    // here because the two helpers disagree and you want to change that, read
    // both tests first — you would be reversing a decision, not fixing a bug.
    let clock = 1000;
    const cache = new PowerCache({ now: () => clock });
    cache.set('zero', 1, { ttl: 0 });
    expect(cache._map.get('zero').expiresAt).toBe(1000);
    expect(cache.get('zero')).toBeUndefined();

    cache.set('never', 1, { ttl: null });
    expect(cache._map.get('never').expiresAt).toBe(0);
    clock += 100_000;
    expect(cache.get('never')).toBe(1);

    cache.set('inf', 1, { ttl: Infinity });
    expect(cache._map.get('inf').expiresAt).toBe(0);
    expect(cache.get('inf')).toBe(1);
  });

  it('expires an entry whose TTL arrived as a numeric string, on time', () => {
    // The user-visible half of the original row. A TTL from an environment
    // variable is a string, and the old code made such an entry immortal rather
    // than slow — so this is the case that would have been reported as a leak.
    let clock = 0;
    const cache = new PowerCache({ now: () => clock });
    cache.set('env', 'v', { ttl: '100' });
    clock = 99;
    expect(cache.get('env')).toBe('v');
    clock = 100;
    expect(cache.get('env')).toBeUndefined();
  });
});

describe('PowerCache eviction cursor (CACHE-001, CACHE-002)', () => {
  /**
   * **The row's premise did not reproduce, and this is a guard, not a proof.**
   *
   * `CACHE-001` is marked `**[verified]** A dangling cursor destroys the whole
   * linked list: size 5, head null, tail null`. Before changing anything, a
   * fuzzer ran ~2.4 million operations — 40 000 seeds × 60 operations, across
   * `admission: 'tinylfu'` with `windowSize: 4`, with `windowSize: 0`, and under
   * `policy: 'slru'`, using `set`, `setMany`, `get`, `getOrSet`, `has`,
   * `delete`, `touch`, `cleanupExpired`, `resize`, `clear`, `invalidate` and
   * `entries` — and the cursor named a live node after every single one.
   *
   * The mechanism is real; the reachability is not. Every path that removes the
   * cursor's node either passes `advanceEvictionCandidate: true` (the eviction
   * sweeps) or the node is the head, which `_remove` already repairs. A
   * differential trace over every public method — `set`, `get`, `getOrSet`,
   * `setMany`, `has`, `delete`, `touch`, `cleanupExpired`, `resize`, `clear`,
   * `entries`, `keys` and `stats`, five seeds of 80 operations each — found the
   * two versions **observationally identical**.
   *
   * **No source change was made for this row.** Two were written and both
   * reverted once the evidence came in, which is the outcome the project's own
   * rule points at: a change that cannot be distinguished from no change is not
   * a fix, and a test that cannot fail on the regression it names is decoration.
   * What ships is this invariant test, which is what CACHE-002 asked for and
   * which guards a real fragility against a future fifth `_unlinkNode` caller.
   * The negative result is recorded in the row, along with a correction: the
   * `resize()` line `this._evictionCandidate = this.head` looks like a typo for a
   * missing property and is not — `head` is one of ten `Object.defineProperty`
   * aliases, and `cache.head === cache._head`.
   */
  it('never leaves the cursor on a node that is not in the list', () => {
    const cache = new PowerCache({ maxEntries: 8, admission: 'tinylfu', windowSize: 4 });
    let clock = 0;
    cache._now = () => clock;
    for (let i = 0; i < 40; i += 1) {
      cache.set(`k${i % 12}`, i, { ttl: 50 });
      cache.get(`k${(i + 1) % 12}`);
      cache.touch(`k${(i + 3) % 12}`, 50);
      clock += 30;
      cache.cleanupExpired();
      if (i % 5 === 0) cache.delete(`k${(i + 2) % 12}`);
      if (i % 7 === 0) cache.resize({ maxEntries: 4 + (i % 5) });
      const cursor = cache._evictionCandidate;
      expect(cursor === null || isLive(cache, cursor)).toBe(true);
    }
    // And the list is still walkable, which is the part a destroyed list loses.
    expect([...cache.entries()].length).toBe(cache.size);
    expect(cache._head === null || isLive(cache, cache._head)).toBe(true);
  });

  it('keeps the linked list intact across a shrink and a regrow', () => {
    // The row's own observation, confirmed: before this file **no test mentioned
    // `cache.resize` at all** — `rg resize test/` found only `PowerPool.resize`.
    // So `resize` had no coverage, which is part of why CACHE-001's premise went
    // unexamined.
    //
    // This asserts the contract a caller can depend on rather than the cursor
    // mechanics: a shrink evicts the least recently used, and a regrow loses
    // nothing and leaves the cache able to accept more.
    const cache = new PowerCache({ maxEntries: 8 });
    for (let i = 0; i < 8; i += 1) cache.set(`k${i}`, i);
    expect(cache.size).toBe(8);

    cache.resize({ maxEntries: 3 });
    expect(cache.size).toBe(3);
    expect([...cache.entries()].map(([k]) => k).sort()).toEqual(['k5', 'k6', 'k7']);
    expect(cache._evictionCandidate === null || isLive(cache, cache._evictionCandidate)).toBe(true);

    cache.resize({ maxEntries: 10 });
    expect(cache.size).toBe(3);
    cache.set('extra', 'x');
    expect(cache.get('extra')).toBe('x');
    expect(cache.size).toBe(4);
  });
});

describe('PowerCache.setMany makes the same decisions as set (CACHE-004)', () => {
  /**
   * `setMany` used to carry its own copy of the insert path, and it was a
   * simplified one: no oversize rejection, no TinyLFU sketch, no admission
   * window. Three copies of one insert is two too many, and these are the
   * divergences that had already accumulated.
   *
   * Before/after on the same script, which is the shape of every assertion here:
   *
   *   onEvict reasons  ["big2:evicted"]           ->  ["big2:rejected-oversized"]
   *   stats().rejected 0                           ->  1
   *   sketch estimates 0, 0, 0                     ->  1, 1, 1
   */
  it('rejects an oversized value with the right reason, as set does', () => {
    const reasons = [];
    const cache = new PowerCache({
      maxEntries: 10,
      maxWeight: 100,
      rejectOversized: true,
      // The default `weightFn` counts *entries*, not bytes, so a large value is
      // only oversized under a weight function that says so — which is how a
      // caller using a byte budget would configure it.
      weightFn: (v) => String(v).length,
      onEvict: (key, value, reason) => reasons.push(`${key}:${reason}`),
    });

    // The single-key path, for the comparison this row is really about.
    expect(cache.set('big1', 'x'.repeat(999))).toBe(false);
    expect(reasons).toEqual(['big1:rejected-oversized']);

    // The bulk path. `setMany` returns `this` for chaining and cannot report a
    // per-entry outcome, so `onEvict` and the counter are the signal.
    expect(cache.setMany([['big2', 'x'.repeat(999)]])).toBe(cache);
    expect(reasons).toEqual(['big1:rejected-oversized', 'big2:rejected-oversized']);
    expect(cache.stats().rejected).toBe(2);
    expect(cache.has('big2')).toBe(false);

    // A value that fits is still admitted, so this is not "reject everything".
    cache.setMany([['small', 'ok']]);
    expect(cache.get('small')).toBe('ok');
    expect(cache.stats().rejected).toBe(2);
  });

  it('makes bulk writes visible to the admission sketch', () => {
    // A frequency-driven filter cannot judge a key it has never seen, so
    // `estimate === 0` after a bulk load meant a batch of ten thousand entries
    // was invisible to admission — and a key at 0 can never re-enter.
    const cache = new PowerCache({ maxEntries: 10, admission: 'tinylfu', windowSize: 0 });
    cache.setMany([['a'], ['b'], ['c']]);
    for (const key of ['a', 'b', 'c']) {
      expect(cache._sketch.estimate(key)).toBeGreaterThan(0);
    }
  });

  it('applies the admission window on a bulk load', () => {
    // The window is what makes `windowSize > 0` worth having: a one-shot key
    // displaces the previous one-shot key inside the window rather than a
    // working-set entry in main space. `setMany` skipped it, so a bulk load
    // bypassed the mechanism entirely.
    const cache = new PowerCache({ maxEntries: 6, admission: 'tinylfu', windowSize: 4 });
    cache.setMany(Array.from({ length: 6 }, (_, i) => [`k${i}`, i]));
    expect(cache.size).toBeLessThanOrEqual(6);
    const inWindow = [...cache.entries('MRU')].filter(([k]) => cache._map.get(k)?.inWindow);
    expect(inWindow.length).toBeGreaterThan(0);
  });

  it('updates existing entries with the same weight bookkeeping as set', () => {
    // The third copy of the update arithmetic. A bulk overwrite that miscounted
    // weight would drift the budget without ever tripping a size assertion.
    const cache = new PowerCache({ maxEntries: 10, weightFn: (v) => String(v).length });
    cache.setMany([['a', 'x'.repeat(50)]]);
    expect(cache.currentWeight).toBe(50);
    cache.setMany([['a', 'x'.repeat(10)]]);
    expect(cache.get('a')).toBe('x'.repeat(10));
    expect(cache.currentWeight).toBe(10);
  });
});
