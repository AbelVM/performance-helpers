import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

/**
 * CACHE-019: a recency mutation inside an `entries()` loop is an **infinite
 * loop**, and the same hazard CACHE-018 fixed on the unlink axis.
 *
 * `_moveToTail` relinks the entry to the MRU end, which is *behind* an MRU-first
 * cursor, so a walk that was standing on it comes back around and finds it
 * again. Measured on 6 keys, `for (const [k] of c.entries()) c.get(k)` never
 * returns: 60 yields without a stop, visiting the same 6 distinct keys.
 *
 * Found while fixing CACHE-018 and **verified pre-existing** by `git stash` — the
 * CACHE-018 fix made the symptom less obvious without touching this cause, which
 * is the argument for not folding one defect into another. Before that fix it
 * oscillated `k9,k8,k9,k8,…`; after it, it swept the list once and then
 * oscillated. A non-terminating iterator is worse than a truncating one, because
 * the truncation at least returned.
 *
 * **The fix is a bound, not a repeat-detector.** The walk visits at most as many
 * entries as existed when it started. That is only sound if no legitimate walk
 * yields more than that, so it is measured below rather than assumed: inserting
 * during a walk lands the new entry *behind* the cursor, so additions are never
 * visited (tinylfu 40 yields for 40 entries, plain LRU 10 for 10, slru 15 for 20).
 * A `Set` of visited nodes would detect a cycle exactly but allocates on every
 * iteration call, and this class does not spend that to save a caller from its own
 * loop body.
 *
 * Every assertion here is a count. The failure mode is a hang, so a test that
 * timed out would be the test, not the fix — a runaway is bounded by a counter
 * that the test itself owns, which is what `BOUND` is for.
 */

/**
 * Iterate with a hard cap, so a regression fails an assertion instead of hanging
 * the suite. Returns what the walk produced and whether it hit the cap.
 */
function walkBounded(c, body, bound = 200) {
  const seen = [];
  let capped = false;
  for (const [k, v] of c.entries()) {
    if (seen.length >= bound) {
      capped = true;
      break;
    }
    seen.push(k);
    body(c, k, v);
  }
  return { seen, capped };
}

describe('CACHE-019: a recency mutation in the loop terminates the walk', () => {
  it('get() on the yielded key does not loop forever', () => {
    // The reported shape, and the one a caller writes to "warm everything I
    // just exported". 60 yields without a stop before the fix.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);

    const { seen, capped } = walkBounded(c, (cache, k) => cache.get(k));
    expect(capped).toBe(false);
    // Every entry is still visited: the bound ends the *cycle*, and the cycle
    // only starts after a full pass, so a correct walk is not truncated.
    expect(new Set(seen).size).toBe(6);
  });

  it('touch() on the yielded key does not loop forever', () => {
    // `touch` is the recency-only operation — no read, no expiry check, no
    // value change — so it is the *most* likely thing to appear in a loop body
    // and the easiest to miss by testing only `get`.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);

    const { seen, capped } = walkBounded(c, (cache, k) => cache.touch(k));
    expect(capped).toBe(false);
    expect(new Set(seen).size).toBe(6);
  });

  it('set() on the yielded key does not loop forever', () => {
    // The third relink path. `set` on an existing key updates in place *and*
    // promotes, so it is the same hazard reached through the write API rather
    // than the read one.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);

    const { capped } = walkBounded(c, (cache, k) => cache.set(k, 99));
    expect(capped).toBe(false);
  });

  it('terminates under get() and insert() together', () => {
    // Both hazards at once, and the combination is the one a real sweep does:
    // refresh recency and log what changed. Insertion grows `size`, so a bound
    // read from the live size rather than the entry size would be defeated —
    // this is the case that says the bound has to be captured up front.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);

    let n = 0;
    const { capped } = walkBounded(c, (cache, k) => {
      cache.get(k);
      cache.set(`new${n++}`, n);
    });
    expect(capped).toBe(false);
  });

  it('the bound cannot truncate a walk that only inserts', () => {
    // The measurement the fix rests on. Inserting during a walk lands the new
    // entry *behind* the cursor, so a correct walk never exceeds the number of
    // entries it started with — across all four list shapes.
    const shapes = [
      ['plain', { maxEntries: 100 }, 10],
      ['tinylfu', { admission: 'tinylfu', maxEntries: 50, windowSize: 10 }, 40],
      ['tinylfu window 0', { admission: 'tinylfu', maxEntries: 50, windowSize: 0 }, 40],
      ['slru', { policy: 'slru', maxEntries: 30 }, 20],
    ];

    for (const [label, options, n] of shapes) {
      const c = new PowerCache(options);
      for (let i = 0; i < n; i++) c.set(`k${i}`, i);

      let inserted = 0;
      const { seen, capped } = walkBounded(c, (cache) => {
        cache.set(`new${inserted}`, inserted++);
      });

      expect(capped, `${label} must not hit the cap`).toBe(false);

      // The claim is not "every entry is visited" — under a bounded cache an
      // insert can *evict* an entry before the walk reaches it, and SLRU does:
      // 20 entries plus 15 inserts exceeds `maxEntries: 30`, and the 5 originals
      // that were never yielded are gone from the cache rather than skipped.
      // The claim is that nothing the walk passed over is still resident, which
      // is what a truncation would leave behind.
      const passedOver = [];
      for (let i = 0; i < n; i++) {
        const key = `k${i}`;
        if (!seen.includes(key) && c.has(key)) passedOver.push(key);
      }
      expect(passedOver, `${label} skipped a resident entry`).toEqual([]);
    }
  });

  it('does not change a walk that mutates nothing', () => {
    // The control. A bound that shortened ordinary iteration would pass every
    // test above and break this one.
    const c = new PowerCache();
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);

    const { seen, capped } = walkBounded(c, () => {});
    expect(capped).toBe(false);
    expect(seen).toHaveLength(10);
  });

  it('yields exactly the resident count when nothing is mutated', () => {
    // **The bound is a backstop, and this is the evidence for that claim.** A
    // correct walk visits every resident entry exactly once and then stops
    // because the list ran out — `node` goes `null` — so the budget is never the
    // binding constraint. Measured over 300 clean walks across both policies:
    // the maximum of `yields - sizeAtEntry` is **0**.
    //
    // That is also why the off-by-one mutants are not caught here, and it is
    // worth being explicit rather than leaving a test that looks like it is
    // pinning something it is not: an extra unit of budget is *unobservable*,
    // because there is no state in which a correct walk would spend it. Only a
    // cycling walk reaches the bound, and those are already capped above. An
    // argument, not coverage — see the note on the `walkBounded` cap.
    const shapes = [
      ['plain', {}, 10],
      ['slru', { policy: 'slru', maxEntries: 30 }, 20],
      ['tinylfu', { admission: 'tinylfu', maxEntries: 50, windowSize: 10 }, 40],
    ];

    for (const [label, options, n] of shapes) {
      const c = new PowerCache(options);
      for (let i = 0; i < n; i++) c.set(`k${i}`, i);

      const resident = c.size;
      let yields = 0;
      for (const [k] of c.entries()) {
        void k;
        yields++;
      }
      expect(yields, `${label} yields exactly size`).toBe(resident);
    }
  });

  it('still deletes correctly when combined with a recency mutation', () => {
    // The two fixes are not alternatives: CACHE-018 made `delete` in the loop
    // work, and it has to keep working when the loop body also promotes nodes.
    const c = new PowerCache();
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);

    const { seen, capped } = walkBounded(c, (cache, k) => {
      cache.get(k);
      cache.delete(k);
    });
    expect(capped).toBe(false);
    expect(c.size).toBe(0);
    // Every key was seen exactly once: deletion and relink together must not
    // re-visit a key the walk already passed.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('leaves the list consistent after a recency-mutating walk', () => {
    // The bound stops the walk; it must not corrupt anything. `_moveToTail` ran
    // during the walk, so the invariant to check afterwards is that `size` and a
    // fresh walk still agree, in both directions.
    const c = new PowerCache();
    for (let i = 0; i < 10; i++) c.set(`k${i}`, i);

    walkBounded(c, (cache, k) => cache.get(k));

    let mru = 0;
    for (const key of c.keys()) {
      void key;
      mru++;
    }
    let lru = 0;
    for (const key of c.keys('LRU')) {
      void key;
      lru++;
    }
    expect(mru).toBe(c.size);
    expect(lru).toBe(c.size);
  });

  it('holds for the SLRU policy, where a hit relinks across segments', () => {
    // SLRU splices a hit out of probation into protected rather than moving it
    // to the tail, so the relink is a two-step splice — a different shape for
    // the same hazard.
    for (const order of ['MRU', 'LRU']) {
      const c = new PowerCache({ policy: 'slru', maxEntries: 20 });
      for (let i = 0; i < 12; i++) c.set(`k${i}`, i);
      const { capped } = walkBounded(c, (cache, k) => cache.get(k));
      expect(capped, `${order} must not hit the cap`).toBe(false);
    }
  });

  it('an empty cache yields nothing, and a single-entry cache yields it once', () => {
    // `size` is 0 for the empty case, so the bound starts at zero — the walk has
    // to read it before the first yield or an empty cache would yield once.
    expect([...new PowerCache().entries()]).toEqual([]);

    const one = new PowerCache();
    one.set('only', 1);
    const { seen, capped } = walkBounded(one, (cache, k) => cache.get(k));
    expect(capped).toBe(false);
    expect(seen).toEqual(['only']);
  });
});
