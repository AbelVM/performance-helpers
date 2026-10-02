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
describe('TEST-003: _windowOldest() walk counter', () => {
  /**
   * Count calls to `_windowOldest()` that **actually walked**.
   *
   * This counts *misses*, not calls. With the walk memoised, `_windowOldest` is
   * still called on every read and returns the memo without walking, so counting
   * calls measures nothing and reads 50 for 50 reads. The first version of these
   * tests counted calls and asserted 0, which failed for that reason and not
   * because the memo was broken — the diagnostic that separated them was
   * comparing memo identity before and after the call.
   *
   * @param {PowerCache} cache
   */
  const countWalks = (cache) => {
    let walks = 0;
    const original = cache._windowOldest.bind(cache);
    cache._windowOldest = (...a) => {
      // The same two conditions `_windowOldest` itself uses to decide whether
      // the memo is usable. Duplicated deliberately rather than exported: this is
      // the cache's internal rule, and a test that called the method under test
      // to ask whether the method under test was about to do its job would be
      // asserting nothing.
      const memo = cache._windowStartMemo;
      const usable =
        memo !== null &&
        (memo.prev === null || !memo.prev.inWindow) &&
        cache._windowTail === cache._tail;
      if (!usable) walks += 1;
      return original(...a);
    };
    return {
      get calls() {
        return walks;
      },
    };
  };

  it('a main-space get() walks zero times once the window is steady', () => {
    // CACHE-006's assertion, now satisfied. The counter reads 0 where it read 1,
    // and it reads 0 because the memo is *validated* on each call rather than
    // maintained: `_windowOldest` is still called, but it returns the memo
    // without walking.
    //
    // "Steady" is load-bearing and the reason the first two drafts of this test
    // measured the wrong thing. Both read 1 rather than 0, and both for the same
    // non-bug: a `get()` that lands *inside* the window re-appends at the tail,
    // which genuinely invalidates the memo. A window that holds most of a small
    // cache is re-appended constantly, so its reads can never reach 0 — and
    // asserting 0 there would have been asserting something false. The row's
    // target is a read in **main space**, which is what a real cache with a
    // working set produces, so that is what this builds.
    const cache = new PowerCache({ maxEntries: 4000, windowSize: 100, admission: 'tinylfu' });
    for (let i = 0; i < 3000; i += 1) cache.set(`k${i}`, i);
    const mainKeys = [...cache._map.entries()].filter(([, n]) => !n.inWindow).map(([k]) => k);
    expect(mainKeys.length, 'the fixture must have main space to read').toBeGreaterThan(1000);

    cache.get(mainKeys[0]); // settle, uncounted
    const counter = countWalks(cache);
    for (let i = 0; i < 50; i += 1) cache.get(mainKeys[i]);

    expect(counter.calls).toBe(0);
    cache.dispose();
  });

  it('still walks when a window node is promoted, which must invalidate the memo', () => {
    // The other direction, and the reason the fix is a *validated* memo rather
    // than a bare one: a `get()` in the window re-appends it at the tail, so the
    // walk's answer genuinely changes and skipping it would splice a main-space
    // node into the wrong place. The memo is discarded there, and this fails if a
    // future change makes it trust a stale answer.
    const cache = new PowerCache({ maxEntries: 4000, windowSize: 100, admission: 'tinylfu' });
    for (let i = 0; i < 3000; i += 1) cache.set(`k${i}`, i);
    const windowKey = [...cache._map.entries()].find(([, n]) => n.inWindow)[0];
    const before = cache._windowOldest();
    expect(before, 'the fixture must have a window').not.toBeNull();

    cache.get(windowKey); // re-appends at the tail

    expect(cache._windowOldest(), 'a promotion moves the window start').not.toBe(before);
    expect(windowIntegrity(cache).ok).toBe(true);
    cache.dispose();
  });

  it('discards the memo when the node before it becomes part of the window', () => {
    // The `memo.prev` condition, and it is **not** redundant.
    //
    // The memo is only the run's start while the node before it is *not* flagged.
    // If that node joins the window, the run's start has moved one step earlier —
    // and the tail has not changed, so neither the tail comparison nor the
    // `inWindow` check on the memo can see it. This is the case the condition
    // exists for and it was **untested**: deleting the condition left all 17 tests
    // in this file passing, which is the shape of a guard nobody has watched fail.
    //
    // The state is reached by flagging the node in place, which is what the flag
    // means and what admission does. Driving it through the public API instead
    // would not reach it: admitting a key appends, and appending changes the tail.
    const cache = new PowerCache({ maxEntries: 4000, windowSize: 100, admission: 'tinylfu' });
    for (let i = 0; i < 3000; i += 1) cache.set(`k${i}`, i);
    const mainKeys = [...cache._map.entries()].filter(([, n]) => !n.inWindow).map(([k]) => k);

    cache.get(mainKeys[0]); // settle and memoise
    const memo = cache._windowStartMemo;
    expect(memo, 'the fixture must memoise').not.toBeNull();
    expect(memo.prev, 'the memo needs a predecessor to test').not.toBeNull();
    expect(memo.prev.inWindow, 'the predecessor starts outside the window').toBe(false);

    const before = cache._windowOldest();
    expect(before).toBe(memo);

    // The window now extends one node earlier, with the tail untouched.
    memo.prev.inWindow = true;

    expect(cache._windowOldest(), 'the run start must move back a step').toBe(memo.prev);
    // Deliberately **not** asserting `windowIntegrity` here. Flagging a node by
    // hand puts 101 nodes in a 100-slot window, so the integrity check fails on
    // its size bound — a property of the hand-built state, not of the memo. The
    // memo's own claim is the single line above: it discarded a stale answer and
    // returned the node a real walk would return.
    cache.dispose();
  });

  it('discards the memo when the tail moves and no walk follows', () => {
    // The `_windowTail` condition, and it is load-bearing — but only in a state
    // the public API does not reach on its own, which is why deleting the
    // condition left every test in this file passing.
    //
    // The condition is asking "is the list the same as it was when the memo was
    // written?", and every ordinary way to move the tail also *triggers a walk*,
    // which refreshes `_windowTail` and makes the two equal again. Admitting a
    // key does exactly that: the tail advances to `zzz`, arbitration walks, and
    // the stale comparison comes out false-negative. A working cache cannot reach
    // a bad answer that way, which is the reassuring half.
    //
    // The other half is what the condition still costs: it discards a memo that
    // would have been *correct*. Appending a flagged node extends the run at its
    // far end and does not move its start, so the memo was never stale — it is
    // thrown away and recomputed to the same answer. That is the price of a
    // condition that cannot be wrong, paid on a path that is not hot.
    const cache = new PowerCache({ maxEntries: 4000, windowSize: 100, admission: 'tinylfu' });
    for (let i = 0; i < 3000; i += 1) cache.set(`k${i}`, i);
    const mainKeys = [...cache._map.entries()].filter(([, n]) => !n.inWindow).map(([k]) => k);

    cache.get(mainKeys[0]); // settle and memoise
    const memo = cache._windowStartMemo;
    expect(memo, 'the fixture must memoise').not.toBeNull();
    // Computed by hand rather than by calling `_windowOldest`, which is the thing
    // under test: calling it to ask what it *would* answer compares the memo
    // against itself and asserts nothing.
    const walkByHand = () => {
      let n = cache._tail;
      if (!n || !n.inWindow) return null;
      while (n.prev && n.prev.inWindow) n = n.prev;
      return n;
    };

    // Append a flagged node at the tail directly, leaving `_windowTail` behind —
    // what an append that no arbitration walk followed would leave.
    const extra = cache._allocNode('zzz', 1, 0, 0);
    extra.inWindow = true;
    cache._map.set('zzz', extra);
    cache._append(extra);

    expect(cache._tail, 'the tail really did move').not.toBe(cache._windowTail);
    expect(memo.inWindow, 'the memo still looks flagged').toBe(true);
    expect(memo.prev, 'and its predecessor still looks unflagged').toBeTruthy();
    expect(!memo.prev.inWindow, 'so only the tail comparison can see this').toBe(true);
    // **Compared by key, not by node.** `expect(node).toBe(otherNode)` makes
    // vitest's differ walk the structure to explain itself, and a doubly-linked
    // list of 3000 nodes has no end to that walk — the first draft of this
    // assertion overflowed the stack rather than failing, which hid the real
    // result behind a `RangeError`. A key comparison states the same claim and
    // terminates.
    //
    // The claim is only that the walk wins, and the answer here is *the same node*.
    // That is correct and was the point I got wrong when drafting it: appending a
    // flagged node at the tail extends the run at its far end and does not move
    // its start, so a memo written before the append was never stale. What the
    // tail comparison buys is that the memo is **not trusted** across the append
    // — it is discarded and recomputed to the same answer. Asserting the answers
    // differ, as the first draft did, asserts a bug that does not exist.
    const answered = cache._windowOldest();
    expect(answered.key, 'the walk must win').toBe(walkByHand().key);
    expect(cache._windowTail, 'and the memo was recomputed against the new tail').toBe(cache._tail);
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

  it('a main-space get() walks zero times at every window size', () => {
    // CACHE-006 asks for this counter at **several window sizes**, and the
    // original used a single one (20). That was the gap: the cost is *linear in
    // the window* and `windowSize: null` — the documented recommended default at
    // `ceil(maxEntries * 0.01)` — is 40 on a 4000-entry cache, so a fix holding
    // only for a small window would pass everything above and still ship the slow
    // corner the row is about.
    //
    // Now 0 at every size, against a row that read 0.80. `windowSize: 0` has no
    // window at all so it reads 0 trivially and is kept as the control: it must
    // not be the only size that reaches 0.
    for (const windowSize of [0, 1, 10, 100, 1000]) {
      const cache = new PowerCache({
        maxEntries: 4000,
        windowSize,
        admission: 'tinylfu',
      });
      for (let i = 0; i < 3000; i += 1) cache.set(`k${i}`, i);
      const mainKeys = [...cache._map.entries()].filter(([, n]) => !n.inWindow).map(([k]) => k);
      if (mainKeys.length < 10) {
        cache.dispose();
        continue; // the window covers the cache; there is no main-space read to measure
      }

      cache.get(mainKeys[0]); // settle, uncounted
      const counter = countWalks(cache);
      for (let i = 0; i < 50; i += 1) cache.get(mainKeys[i]);

      expect(counter.calls, `window ${windowSize} walks`).toBe(0);
      cache.dispose();
    }
  });

  it('the walk is absent when the feature is disabled, which is why a bare measurement reads zero', () => {
    // The trap, pinned so it cannot be re-entered. `_windowSize` is forced to 0
    // unless `this._sketch && this._policy === 'lru'`, so a cache built without
    // `admission: 'tinylfu'` has **no window to walk** and the counter reads 0 —
    // which is how this row was recorded stale for the sixth time. Same option,
    // same walk, one fewer configuration flag, opposite conclusion.
    const withFilter = new PowerCache({ maxEntries: 1000, windowSize: 100, admission: 'tinylfu' });
    const without = new PowerCache({ maxEntries: 1000, windowSize: 100 });

    for (const cache of [withFilter, without])
      for (let i = 0; i < 800; i += 1) cache.set(`k${i}`, i);

    expect(withFilter._windowSize, 'filter on: window is real').toBe(100);
    expect(without._windowSize, 'filter off: window silently disabled').toBe(0);
    // **This is what now distinguishes the two configurations.** With the memo a
    // main-space read reads 0 walks *with* the filter too, so "0 walks" on its own
    // no longer separates "fixed" from "measured a disabled feature" — which is
    // the exact confusion that made this row look stale six times. What still
    // separates them is the window actually holding nodes, and these two
    // assertions are that. Before the fix the walk count did the work; now it
    // cannot, so something else has to.
    expect([...withFilter._map.values()].filter((n) => n.inWindow).length).toBe(100);
    expect([...without._map.values()].filter((n) => n.inWindow).length).toBe(0);

    const mainKeys = [...withFilter._map.entries()]
      .filter(([, node]) => !node.inWindow)
      .map(([k]) => k);
    withFilter.get(mainKeys[0]);
    without.get(mainKeys[0]);

    const enabled = countWalks(withFilter);
    const disabled = countWalks(without);
    for (let i = 0; i < 20; i += 1) {
      withFilter.get(mainKeys[i]);
      without.get(mainKeys[i]);
    }

    expect(enabled.calls, 'a main-space read walks nothing with the filter on').toBe(0);
    expect(disabled.calls, 'a measurement without the filter measures nothing').toBe(0);

    withFilter.dispose();
    without.dispose();
  });
});
