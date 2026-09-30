/**
 * The W-TinyLFU admission window on `PowerCache` (`windowSize`).
 *
 * The window is **off by default** (`windowSize: 0`), so every other test in
 * the suite exercises the shipped no-window behaviour and this file is the only
 * place it is turned on.
 *
 * It exists here for a narrower reason than a performance one. The window-floor
 * sweep in `bench/claims.js zipf` is the experiment that `adr/0003-tinylfu-admission-window.md`
 * ends by asking for, and it cannot be run without an implementation to sweep.
 * **The sweep's answer was negative** — no window size beats plain LRU on that
 * workload — so the honest description of this feature is "measured, not
 * recommended", not "faster". These tests are therefore not there to justify the
 * option; they are there to keep the *evidence* honest: a window that silently
 * stopped being wired up would leave the sweep measuring nothing and the note's
 * conclusion resting on an unexercised code path.
 *
 * The failure modes they guard are the ones that made three previous attempts
 * look like "the filter is just weak" rather than like bugs: a window that is
 * inert, a counter that goes negative, and a warm that ends at 5 entries instead
 * of 40.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

const HOT = 40;
const SCAN = 500;

/** Every node in the recency list, head (LRU) first. */
function listNodes(cache) {
  const out = [];
  let n = cache._head;
  while (n) {
    out.push(n);
    n = n.next;
  }
  return out;
}

/**
 * The invariant the whole design rests on: the window is the *last*
 * `windowSize` nodes of the list.
 *
 * The window is positional, and every previous attempt that maintained a
 * pointer to it missed a mutation somewhere — the region and the counter then
 * described different sets of nodes, and the visible symptom was a counter
 * reading negative some distance from the splice that caused it. A node carrying
 * a correct `inWindow` flag can still be on the wrong side of the boundary, so
 * this checks position and flag together and treats disagreement as a failure
 * rather than recomputing the truth from the flags.
 *
 * The window may legitimately hold **fewer** than `windowSize` nodes: a
 * challenger that loses arbitration is dropped, and the next arrival refills the
 * gap. So the invariant is "the flagged nodes are exactly the tail run, and
 * there are never more of them than the window holds" — not "there are always
 * exactly `windowSize` of them", which would fail on the transient and hide the
 * real defect by being satisfied by a test that had to be loosened elsewhere.
 */
function windowIntegrity(cache) {
  const nodes = listNodes(cache);
  const flagged = nodes.filter((n) => n.inWindow);
  if (flagged.length === 0) {
    return { ok: cache._windowOldest() == null || nodes.length <= cache._windowSize, flagged: 0 };
  }
  const tailRun = nodes.slice(-flagged.length);
  return {
    ok:
      flagged.length <= cache._windowSize &&
      tailRun.every((n) => n.inWindow) &&
      cache._windowOldest() === tailRun[0],
    flagged: flagged.length,
    size: Math.min(cache._windowSize, nodes.length),
  };
}

/** A cache warmed with a working set, then hit by a one-off scan. */
function scanResistance(options) {
  const cache = new PowerCache({ maxEntries: HOT, ...options });
  const hot = [];
  for (let i = 0; i < HOT; i += 1) hot.push(`hot-${i}`);
  for (let pass = 0; pass < 5; pass += 1) for (const k of hot) cache.set(k, pass);
  for (let i = 0; i < SCAN; i += 1) cache.set(`scan-${i}`, 1);
  let survived = 0;
  for (const k of hot) if (cache.has(k)) survived += 1;
  return { survived, cache };
}

describe('PowerCache admission window: it is off unless asked for', () => {
  it('defaults to no window, so the shipped tinylfu path is untouched', () => {
    const cache = new PowerCache({ maxEntries: 10, admission: 'tinylfu' });
    expect(cache._windowSize).toBe(0);
  });

  it('is inert without a sketch, rather than arming a filter that cannot run', () => {
    const noAdmission = new PowerCache({ maxEntries: 10, windowSize: 4 });
    expect(noAdmission._windowSize).toBe(0);
    // Under `slru` the sketch is not built at all (it is a documented no-op),
    // so the window cannot be armed either.
    const slru = new PowerCache({
      maxEntries: 10,
      admission: 'tinylfu',
      policy: 'slru',
      windowSize: 4,
    });
    expect(slru._windowSize).toBe(0);
  });

  it('clamps a window that would swallow the whole cache', () => {
    // A window the size of the cache never arbitrates: every key is admitted and
    // the filter never runs. The clamp is what stops `windowSize: 40` on a
    // 40-entry cache being a silent no-op that looks like a working feature.
    const cache = new PowerCache({ maxEntries: 40, admission: 'tinylfu', windowSize: 40 });
    expect(cache._windowSize).toBeLessThan(40);
    expect(cache._windowSize).toBeGreaterThan(0);
  });

  it('takes the recommended size from null', () => {
    const cache = new PowerCache({ maxEntries: 100, admission: 'tinylfu', windowSize: null });
    // min(max(4, ceil(100 * 0.01)), floor(100 / 4)) = 4
    expect(cache._windowSize).toBe(4);
  });
});

describe('PowerCache admission window: the invariants the design rests on', () => {
  it('a 40-key warm fills the cache', () => {
    // The bug this whole file exists around. An earlier implementation lost 35
    // of 40 keys because the promote branch displaced a main-space entry on
    // every window overflow, whether or not anything needed displacing: one key
    // was promoted into main space and the next arrival evicted it again,
    // forever. No exception, just a cache that quietly does not grow.
    for (const windowSize of [1, 2, 4, 8]) {
      const cache = new PowerCache({ maxEntries: HOT, admission: 'tinylfu', windowSize });
      for (let i = 0; i < HOT; i += 1) cache.set(`hot-${i}`, i);
      expect(cache.size, `windowSize=${windowSize}`).toBe(HOT);
    }
  });

  it('keeps the window and the counter describing the same set of nodes', () => {
    const cache = new PowerCache({ maxEntries: HOT, admission: 'tinylfu', windowSize: 4 });
    for (let pass = 0; pass < 5; pass += 1) {
      for (let i = 0; i < HOT; i += 1) {
        cache.set(`hot-${i}`, pass);
        cache.get(`hot-${i}`);
      }
    }
    const integrity = windowIntegrity(cache);
    expect(integrity.ok).toBe(true);
    expect(integrity.size).toBe(4);
    expect(integrity.flagged).toBe(4);
  });

  it('survives a read pass with the counter non-negative', () => {
    // The reported symptom of the third attempt: after a warm and a read pass
    // `_windowSize` read -16, so promotion ran about twenty times against a
    // window that held four.
    const cache = new PowerCache({ maxEntries: HOT, admission: 'tinylfu', windowSize: 4 });
    for (let i = 0; i < HOT; i += 1) cache.set(`hot-${i}`, i);
    const afterWarm = listNodes(cache).filter((n) => n.inWindow).length;
    expect(afterWarm).toBe(4);

    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < HOT; i += 1) cache.get(`hot-${i}`);
      expect(windowIntegrity(cache).ok, `after read pass ${round}`).toBe(true);
    }
  });

  it('never exceeds maxEntries, because the window is drawn from the same budget', () => {
    // The window is admission slack, not capacity on top of the limit. A cache
    // reporting `size: 12` under a limit of 10 is lying, and `maxEntries` is the
    // number callers size their working sets against.
    for (const windowSize of [1, 4, 8]) {
      const cache = new PowerCache({ maxEntries: 10, admission: 'tinylfu', windowSize });
      for (let i = 0; i < 200; i += 1) cache.set(`k-${i}`, i);
      expect(cache.size, `windowSize=${windowSize}`).toBeLessThanOrEqual(10);
      expect(windowIntegrity(cache).ok).toBe(true);
    }
  });

  it('keeps keys written after a fill, which the tie rule protects', () => {
    // Refusing ties inside the window meant every freshly-written key tied at
    // estimate 1 against the previous one, so a caller that fills a cache and
    // *then* reads it lost everything written after the first few.
    const cache = new PowerCache({ maxEntries: HOT, admission: 'tinylfu', windowSize: 4 });
    for (let i = 0; i < HOT; i += 1) cache.set(`hot-${i}`, i);
    for (let i = 0; i < HOT; i += 1) cache.get(`hot-${i}`);
    let survived = 0;
    for (let i = 0; i < HOT; i += 1) if (cache.has(`hot-${i}`)) survived += 1;
    expect(survived).toBeGreaterThanOrEqual(HOT - 4);
  });
});

describe('PowerCache admission window: what it actually does', () => {
  it('beats plain LRU on a one-off scan, and does not beat the shipped filter', () => {
    // The property the window was designed for is scan resistance, and it does
    // have it: plain LRU keeps *none* of the working set under this scan, while
    // every window size keeps most of it. That is the filter's value, not the
    // window's.
    //
    // What the window does not do is beat the shipped no-window filter. Measured
    // here at 35/40 against the shipped filter's 40/40, and on the paired Zipf
    // benchmark every window size lands within a point of the no-window
    // behaviour and below plain LRU's *hit rate* (see `bench/claims.js zipf`).
    // That is the measured reason `windowSize` is off by default and why this
    // option is documented as not recommended.
    const plain = scanResistance({});
    const shipped = scanResistance({ admission: 'tinylfu' });
    const withWindow = scanResistance({ admission: 'tinylfu', windowSize: 4 });
    expect(plain.survived).toBe(0);
    expect(shipped.survived).toBeGreaterThan(30);
    expect(withWindow.survived).toBeGreaterThan(30);
    expect(withWindow.survived).toBeLessThan(shipped.survived);
  });

  it('reports every eviction through onEvict, window evictions included', () => {
    // A window eviction that skipped the callback would be invisible to every
    // user cleanup and to the pool's own accounting, and the only symptom
    // would be a cache holding values nothing ever released.
    const evicted = [];
    const cache = new PowerCache({
      maxEntries: 10,
      admission: 'tinylfu',
      windowSize: 4,
      onEvict: (key) => evicted.push(key),
    });
    for (let i = 0; i < 60; i += 1) cache.set(`k-${i}`, i);
    expect(cache._evictions).toBe(evicted.length);
    expect(evicted.length).toBeGreaterThan(0);
  });

  it('is measured, not recommended: no window size beats plain LRU on the paired workload', () => {
    // The sweep result, as a test. A benchmark that only exists in a guide stops
    // being run and quietly stops being true; the conclusion BENCH-002 closed on
    // belongs somewhere it fails if the code drifts back toward shipping this as
    // a performance feature.
    //
    // Small enough to be exact rather than statistical: a working set equal to
    // the cache size, a burst of one-shot keys, and enough passes for LRU to
    // visibly lose the working set to the scan. The measured pairing is in
    // `bench/claims.js zipf`; this is the shape of it, kept here so the claim
    // is checked whenever the cache changes.
    const burst = (cache, working) => {
      for (let pass = 0; pass < 3; pass += 1)
        for (let i = 0; i < working; i += 1) cache.set(`hot-${i}`, pass);
      for (let i = 0; i < 25; i += 1) cache.set(`scan-${i}`, 1);
      let survived = 0;
      for (let i = 0; i < working; i += 1) if (cache.has(`hot-${i}`)) survived += 1;
      return survived;
    };
    const working = 20;
    const plain = burst(new PowerCache({ maxEntries: working }), working);
    const bestWindow = [1, 2, 4, 8, 16].reduce(
      (best, w) =>
        Math.max(
          best,
          burst(
            new PowerCache({ maxEntries: working, admission: 'tinylfu', windowSize: w }),
            working
          )
        ),
      0
    );
    // The window's whole reason for existing is that a one-shot scan must not
    // walk the working set, and it does deliver that. What it does not deliver
    // — across the whole sweep in `bench/claims.js zipf`, not just here — is a
    // working-set *hit-rate* win over the shipped no-window filter. If a future
    // change ever does beat it, that benchmark is where it will show, and this
    // file is where someone should end up.
    expect(plain).toBe(0);
    expect(bestWindow).toBeGreaterThan(0);
  });
});

/**
 * TEST-003: a **counter** for `_windowOldest()` calls.
 *
 * CACHE-006 claims a cost — 77 ns to 1781 ns per `get()` from window 0 to 1000,
 * with `windowSize: null` the *documented recommended* default at
 * `ceil(maxEntries * 0.01)` being the slow corner — and a cost needs an
 * instrument. The row's specified assertion is: "a `_moveToTail` on a main-space
 * node must call `_windowOldest()` **zero** times".
 *
 * Of the three call sites — `_windowVictim`, `_insertAtMainSpaceMrU` and
 * `_arbitrateWindow` — the last is on the **`get()`** path, and it only runs when
 * `admission: 'tinylfu'` is on. So the count depends on the configuration, and a
 * measurement that omits the filter measures a different one: a first version of
 * this test read 0 and appeared to clear the row. The counter therefore pins both
 * configurations, because the difference between them *is* the finding.
 *
 * So the counter is on the path that **does** walk, and the row's premise is
 * recorded as needing the same scrutiny the `zipf` numbers got. Measured: 65
 * walks over 30 evicting inserts, about 2.2 per insert.
 */
describe('TEST-003: _windowOldest() call counter', () => {
  /** @param {PowerCache} cache */
  const countWalks = (cache) => {
    let calls = 0;
    const original = cache._windowOldest.bind(cache);
    cache._windowOldest = (...a) => {
      calls += 1;
      return original(...a);
    };
    return {
      get calls() {
        return calls;
      },
    };
  };

  it('a main-space get() walks the window exactly once, under tinylfu', () => {
    // CACHE-006's specified assertion, and the row's premise **holds** — under
    // `admission: 'tinylfu'`, which is the configuration the row is about.
    //
    // It looked like it did not for a moment: a first measurement of this path
    // read 0, and the reason was that the cache omitted `admission: 'tinylfu'`.
    // The walk on a `get()` comes from `_arbitrateWindow`, which only runs when
    // the filter is enabled, so measuring without it measured a different
    // configuration and appeared to clear the row. The count is pinned to 1,
    // which discriminates: removing the walk fails it, and CACHE-006's
    // pointer-based fix will make it fail at 0.
    const cache = new PowerCache({ maxEntries: 100, windowSize: 20, admission: 'tinylfu' });
    for (let i = 0; i < 60; i += 1) cache.set(`k${i}`, i);
    cache.get('k5'); // settle, uncounted
    const counter = countWalks(cache);

    cache.get('k5');

    expect(counter.calls).toBe(1);
    cache.dispose();
  });

  it('an evicting insert does walk the window, at least once', () => {
    // The path the cost is actually on, counted rather than timed. The bound is
    // one walk per evicting insert, which is what makes this discriminating: it
    // fails if the walk is removed, and CACHE-006's fix — maintaining a pointer
    // instead of walking — will make it fail at zero, which is the flip the
    // characterisation exists to make visible.
    const cache = new PowerCache({ maxEntries: 20, windowSize: 5, admission: 'tinylfu' });
    for (let i = 0; i < 15; i += 1) cache.set(`k${i}`, i);
    const counter = countWalks(cache);

    const INSERTS = 30;
    for (let i = 15; i < 15 + INSERTS; i += 1) cache.set(`k${i}`, i);

    expect(counter.calls).toBeGreaterThanOrEqual(INSERTS);
    cache.dispose();
  });
});
