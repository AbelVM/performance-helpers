import { describe, it, expect } from 'vitest';
import { PowerSubscriberSet } from '../src/index.js';

/**
 * OBS-010: `delete()` is `O(n)` in the default (non-weak) mode, where the stored
 * entry *is* the listener.
 *
 * ## What the row claimed, and what it cost
 *
 * The scan walked `_listeners` comparing `entry === target`, which in non-weak
 * mode is the only test there is — and is exactly the question `Set.prototype.delete`
 * answers in constant time.
 *
 * Both halves were measured before the change, because a performance claim is a
 * hypothesis until a measurement exists:
 *
 * - **Work, counted exactly.** With `_listeners` wrapped in a counting `Set`
 *   iterator, deleting the newest-registered listener of an N-entry set visits
 *   **exactly N** entries: 1, 2, 4, 8, 16, 64, 256, 1024, 4096. Not "about N" — N.
 * - **Time.** Median of 9 runs, ~6 ns per entry scanned, linear throughout:
 *   99 ns at N=1, 223 at N=16, 451 at N=64, 1577 at N=256, 6195 at N=1024,
 *   23 859 at N=4096. A **240x spread** end to end.
 *
 * ## The fixture mistake that nearly refuted the row
 *
 * Two earlier probes registered **the same `noop` function** as every bystander.
 * A `Set` holds distinct values, so the "4096-subscriber" set held **two** entries,
 * the scan cost was flat in N, and the honest reading of that data was "the row is
 * wrong". It was the fixture, not the row.
 *
 * Every fixture below asserts `set.size === N` **before** it measures or counts
 * anything, and one test pins that assertion as a live guard. That check is the
 * part of this file worth keeping: it is the whole difference between a measurement
 * and a confident wrong answer.
 *
 * ## Why the guard is `!this._weak` and not a test of the entry
 *
 * Weak mode **without** a `WeakRef` also stores the listener directly
 * (`_makeEntry`'s documented fallback), so "the entry is not a WeakRef" does not
 * imply "the scan would find it by identity". More importantly the scan's second
 * job — pruning dead weak refs as it walks — is only vacuous when there are no weak
 * entries. Returning early in weak mode would silently stop sweeping.
 */

/** A set of `n` distinct listeners, asserting the fixture actually built `n`. */
function filled(n, { targetFirst = false } = {}) {
  const set = new PowerSubscriberSet();
  const target = () => {};
  const unsubs = [];
  if (targetFirst) {
    unsubs.push(set.add(target));
    for (let i = 1; i < n; i += 1) unsubs.push(set.add(() => {}));
  } else {
    for (let i = 0; i < n - 1; i += 1) unsubs.push(set.add(() => {}));
    unsubs.push(set.add(target));
  }
  if (set.size !== n) {
    throw new Error(`fixture built a ${set.size}-entry set, not ${n}`);
  }
  return { set, target, unsub: unsubs[targetFirst ? 0 : n - 1] };
}

/** Count the entries `delete()` walks, by giving `_listeners` a counting iterator. */
function entriesVisited(set, run) {
  const counting = set._listeners;
  let seen = 0;
  counting[Symbol.iterator] = function* countingIterator() {
    // `Set.prototype.values` is generic and does not re-enter this own-property
    // iterator, so this walks the set's real contents rather than recursing.
    for (const entry of Set.prototype.values.call(counting)) {
      seen += 1;
      yield entry;
    }
  };
  run();
  return seen;
}

describe('OBS-010: delete() does not scan in non-weak mode', () => {
  it('visits no entries at all, at both ends of the set', () => {
    // The work claim, as a count — exact on any machine, with no threshold to
    // flake. Both positions are checked because the scan's cost depended on where
    // the target sat: the newest was the worst case and the oldest the best.
    //
    // **Zero, not one.** The fast path is `Set.prototype.delete`, which answers
    // from the hash table and never touches the iterator — so the counting
    // iterator installed below is never invoked at all. The pre-fix numbers for
    // this same fixture were exactly N, which is what the last case in this file
    // still pins for weak mode.
    for (const n of [1, 2, 8, 64, 1024]) {
      const oldest = filled(n, { targetFirst: true });
      expect(entriesVisited(oldest.set, oldest.unsub), `oldest of ${n}`).toBe(0);

      const newest = filled(n, { targetFirst: false });
      expect(entriesVisited(newest.set, newest.unsub), `newest of ${n}`).toBe(0);
    }
  });

  it('a large set is fully removable, and empties', () => {
    // The behaviour the fast path must not break. A `Set.delete` that returned
    // early without removing, or removed the wrong entry, would leave residue that
    // only shows at this size.
    const n = 4096;
    const set = new PowerSubscriberSet();
    const unsubs = [];
    for (let i = 0; i < n; i += 1) unsubs.push(set.add(() => {}));
    expect(set.size).toBe(n);

    // Remove in ascending order: the oldest first, so every removal is a scan's
    // worst case under the old code and a no-op path under the new one.
    for (const un of unsubs) expect(un()).toBe(true);
    expect(set.size).toBe(0);
    expect([...set]).toEqual([]);
  });

  it('removes in reverse order too — LIFO is the case the old scan served best', () => {
    // The opposite traversal, so neither ordering is special-cased by accident.
    const n = 2048;
    const set = new PowerSubscriberSet();
    const unsubs = [];
    for (let i = 0; i < n; i += 1) unsubs.push(set.add(() => {}));
    expect(set.size).toBe(n);

    for (let i = unsubs.length - 1; i >= 0; i -= 1) expect(unsubs[i]()).toBe(true);
    expect(set.size).toBe(0);
  });

  it('leaves every other listener in place', () => {
    // Identity, not equality of shape: a fast path that removed by anything other
    // than the exact function would pass the emptiness checks above.
    const n = 64;
    const set = new PowerSubscriberSet();
    const listeners = [];
    const unsubs = [];
    for (let i = 0; i < n; i += 1) {
      const fn = () => i;
      listeners.push(fn);
      unsubs.push(set.add(fn));
    }
    expect(unsubs[7]()).toBe(true);
    expect(set.size).toBe(n - 1);
    expect([...set]).toEqual(listeners.filter((_, i) => i !== 7));
  });

  it('reports a miss as false, and does not disturb the set', () => {
    const { set } = filled(16);
    const stranger = () => {};
    expect(set.delete(stranger)).toBe(false);
    expect(set.size).toBe(16);
    // Twice, so a miss cannot leave the fast path in a state where the second
    // attempt behaves differently.
    expect(set.delete(stranger)).toBe(false);
    expect(set.size).toBe(16);
  });

  it('still resolves a once-wrapper to the wrapper it stored', () => {
    // The `_onceMap` indirection is the one thing that can make the stored entry
    // differ from the function the caller holds, so it is the case a naive
    // `Set.delete(fn)` fast path gets wrong. The caller holds `fn`; the set holds
    // `wrapped`.
    const set = new PowerSubscriberSet();
    let calls = 0;
    const fn = () => {
      calls += 1;
    };
    const un = set.addOnce(fn);
    expect(set.delete(fn)).toBe(true);
    expect(set.size).toBe(0);

    // And it stays gone: re-registering the same function must not resurrect the
    // old wrapper, and a second `delete` must be a clean miss.
    const un2 = set.addOnce(fn);
    set.forEach(() => {});
    expect(set.size).toBe(1);
    un2();
    expect(set.size).toBe(0);
    expect(un()).toBe(false);
    expect(calls).toBe(0);
  });

  it('an addOnce unsubscribe function removes the wrapper once', () => {
    const set = new PowerSubscriberSet();
    const fn = () => {};
    const un = set.addOnce(fn);
    expect(un()).toBe(true);
    expect(un()).toBe(false);
    expect(set.size).toBe(0);
  });

  it('weak mode still scans, so its dead-ref sweep survives', () => {
    // The regression the guard exists to prevent. In weak mode `delete` must keep
    // walking, because the walk is what reclaims collected refs. Counting rather
    // than observing a collection: a `WeakRef` cannot be collected on demand, so a
    // test that waited for GC would be a duration and a flake. The count is exact.
    const set = new PowerSubscriberSet({ weak: true });
    const keep = [];
    for (let i = 0; i < 32; i += 1) keep.push(set.add(() => {}));
    const target = () => {};
    set.add(target);
    expect(set.size).toBe(33);

    const visited = entriesVisited(set, () => set.delete(target));
    // The contrast is the point: the same fixture in non-weak mode visits **0**.
    // 33 entries, the target last, so the scan visits all of them before removing.
    expect(visited).toBe(33);
    expect(set.size).toBe(32);
  });

  it('weak mode with no WeakRef available still scans', () => {
    // `_makeEntry`'s documented fallback stores the function directly when
    // `WeakRef` is missing, so "not a WeakRef" does **not** imply "found by
    // identity" — this is the case that makes the guard `!this._weak` rather than a
    // check on the entry's own type. Stubbed rather than skipped because the
    // runtime has `WeakRef` and the fallback would otherwise be unobservable.
    const realWeakRef = globalThis.WeakRef;
    globalThis.WeakRef = undefined;
    try {
      const set = new PowerSubscriberSet({ weak: true });
      for (let i = 0; i < 8; i += 1) set.add(() => {});
      const target = () => {};
      set.add(target);
      expect(set.size).toBe(9);
      expect(set.delete(target)).toBe(true);
      expect(set.size).toBe(8);
    } finally {
      globalThis.WeakRef = realWeakRef;
    }
  });

  it('a distinct listener per add is what makes the count mean anything', () => {
    // The guard on the guard. A `Set` holds distinct values, so registering one
    // shared `noop` builds a 1-entry set whatever the loop says — which is how two
    // probes of this row concluded the scan was flat in N and nearly refuted it.
    const set = new PowerSubscriberSet();
    const shared = () => {};
    for (let i = 0; i < 100; i += 1) set.add(shared);
    expect(set.size, '100 registrations of one function is one entry').toBe(1);
    expect(filled(100).set.size, '100 distinct functions is 100 entries').toBe(100);
  });
});
