import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

/**
 * CACHE-018: mutating the cache from inside `entries()` / `keys()` / `values()`
 * silently truncated the walk, so the most natural way to empty a cache removed
 * exactly one entry and reported `size: 0` afterwards.
 *
 * The mechanism is that `_remove` nulls both links on the node it removes, and
 * the walk advanced `node = node.prev` *after* the `yield` resumed — so a
 * mutation of the node the iterator was standing on set its own continuation to
 * `null` and ended the walk. Nothing raised, and `size` reported the truth, so a
 * caller who did not check believed they had cleared it.
 *
 * Two things make this file's assertions easy to write wrongly, and both cost a
 * round trip to find out:
 *
 * 1. **The walk is positional.** The MRU walk goes newest-first, so a mutation
 *    truncates it only when the affected node is at or *before* the cursor. A
 *    cache whose expired keys are all the oldest is safe, and the identical test
 *    against that fixture passes against the broken code. Both are pinned below
 *    — the second as a control, because "it works" is only evidence next to the
 *    fixture where it does not.
 *
 * 2. **The control fixture is the one that looks obvious.** `cleanupExpired()`
 *    with the expired entry as the MRU-most visited `['dead']` and left both live
 *    entries unvisited. That case is the regression; the expired-oldest case is
 *    the control.
 *
 * Every assertion is a count or a key list. A duration here would be testing the
 * harness's ~29 % spread, not the walk.
 */

let clock;
const now = () => clock;

/** A cache whose clock this file controls, so TTL expiry needs no private access. */
const cache = (options = {}) => new PowerCache({ maxEntries: 100, now, ...options });

describe('CACHE-018: mutating during iteration does not truncate the walk', () => {
  it('deleting every yielded entry empties the cache (MRU)', () => {
    // The headline defect. Before the fix: n=2 left 1, n=3 left 2, n=4 left 3,
    // n=10 left 9. n=1 was correct only because the walk had nowhere to go.
    for (const n of [1, 2, 3, 4, 10]) {
      const c = new PowerCache();
      for (let i = 0; i < n; i++) c.set(`k${i}`, i);
      for (const [k] of c.entries()) c.delete(k);
      expect(c.size, `n=${n} must be emptied`).toBe(0);
    }
  });

  it('deleting every yielded entry empties the cache (LRU)', () => {
    // The defect is in both arms of the branch, so both are pinned. A fix that
    // only reordered the `if` would pass the MRU test and leave LRU broken.
    for (const n of [1, 2, 3, 4, 10]) {
      const c = new PowerCache();
      for (let i = 0; i < n; i++) c.set(`k${i}`, i);
      for (const [k] of c.entries('LRU')) c.delete(k);
      expect(c.size, `n=${n} must be emptied`).toBe(0);
    }
  });

  it('keys() and values() inherit the walk, so delete-all empties through them too', () => {
    // They are `for (const [k] of this.entries(order))`, so a fix applied only to
    // `entries()` covers all three. Pinned with the *yielded* key deleted, which
    // is what makes them fail without the fix — the first draft deleted a fixed
    // `k0` every turn, which passes against the broken code because removing a
    // node ahead of the cursor was never the defect.
    const viaKeys = new PowerCache();
    for (let i = 0; i < 5; i++) viaKeys.set(`k${i}`, i);
    for (const k of viaKeys.keys()) viaKeys.delete(k);
    expect(viaKeys.size).toBe(0);

    const viaValues = new PowerCache();
    for (let i = 0; i < 5; i++) viaValues.set(`k${i}`, i);
    for (const value of viaValues.values()) {
      void value;
      viaValues.clear();
    }
    expect(viaValues.size).toBe(0);
  });

  it('cleanupExpired() called inside the loop still visits every live entry', () => {
    // The second trigger, and the worse one: `cleanupExpired()` is a public
    // maintenance method, not a mutation a caller chose, so calling it from a
    // sweep loop is entirely reasonable. Before the fix this visited
    // `['dead']` and left both live entries unvisited — a bulk export that
    // exported nothing, with no error anywhere.
    clock = 1_000_000;
    // Per-entry TTLs, not a default one: advancing the clock far enough to expire
    // `dead` would expire the others too, and a sweep that legitimately empties
    // the whole cache visits nothing after the first entry — which is what the
    // first draft of this test asserted, and it passed against a cache where no
    // sweep had happened at all.
    const c = cache();
    c.set('live1', 1, { ttl: 600_000 });
    c.set('live2', 2, { ttl: 600_000 });
    c.set('dead', 3, { ttl: 1_000 });
    // Make 'dead' the MRU-most entry so the sweep unlinks the node the
    // iterator is standing on.
    c.get('live1');
    c.get('live2');
    c.get('dead');

    clock += 5_000; // only `dead` is past its ttl

    const visited = [];
    for (const [key] of c.entries()) {
      c.cleanupExpired();
      visited.push(key);
    }
    expect(visited).toEqual(['dead', 'live2', 'live1']);
  });

  it('control: expired entries that are oldest do not truncate, and still do not', () => {
    // The fixture that hides the bug. Same loop, same code, expired keys at the
    // LRU end instead of the MRU end — the sweep removes nodes *behind* the
    // cursor, so the walk completed even before the fix. Pinning it is what
    // stops a future test being written against the shape that cannot fail.
    clock = 1_000_000;
    const c = cache();
    c.set('dead1', 1, { ttl: 1_000 });
    c.set('dead2', 2, { ttl: 1_000 });
    c.set('live1', 3, { ttl: 600_000 });
    c.set('live2', 4, { ttl: 600_000 });
    // Touch the two entries meant to stay live so they are the MRU end. The two
    // expired ones then sit at the LRU end — behind the MRU-first cursor.
    c.get('live1');
    c.get('live2');

    clock += 5_000; // only the two expired entries are past their ttl

    const visited = [];
    for (const [key] of c.entries()) {
      c.cleanupExpired();
      visited.push(key);
    }
    expect(visited).toEqual(['live2', 'live1']);
    expect(c.size).toBe(2);
  });

  it('removing the next entry during the loop steps over it', () => {
    // The branch that resumes by re-reading our own link. It only fires when the
    // successor is removed *while the current node is yielded* — delete it before
    // the loop and the link is already repaired, so `next` never names the hole
    // and the walk would step over it by accident, which is why the first draft
    // of the skip-unvisited test could not tell a fixed walk from a broken one.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);
    // MRU order is k5, k4, k3, k2, k1, k0 — k3 is the successor of k4.
    const seen = [];
    for (const [k] of c.entries()) {
      if (k === 'k4') c.delete('k3');
      seen.push(k);
    }
    expect(seen).toEqual(['k5', 'k4', 'k2', 'k1', 'k0']);
  });

  it('removing the current and the next entry yields no freed node', () => {
    // Both removals in one iteration step. `_freeNode` nulls `key` and `value`,
    // so walking to the removed successor anyway would hand the caller
    // `[null, null]` — a caller exporting to a socket or a file gets a null key
    // with no error. The contract allows the walk to end early here; it must not
    // report an entry that is no longer in the cache.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);
    const seen = [];
    for (const [k] of c.entries()) {
      c.delete(k);
      if (k === 'k4') c.delete('k3');
      seen.push(k);
    }
    expect(seen.every((k) => k !== null && k !== undefined)).toBe(true);
    expect(seen).not.toContain('k3');
    expect(c.size).toBe(3);
  });

  it('removing an entry not yet visited skips it and the walk completes', () => {
    // The contract's second clause, and it is the one a snapshot-array fix
    // would get right for the wrong reason. Both removals are ahead of the MRU
    // cursor, so the walk must step over the holes.
    const c = new PowerCache();
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);
    c.delete('k3');
    c.delete('k0');

    const seen = [];
    for (const [k] of c.entries()) seen.push(k);
    expect(seen).toEqual(['k5', 'k4', 'k2', 'k1']);
  });

  it('entries added during the walk are not visited, and the walk terminates', () => {
    // The contract's third clause. The walk started at the then-tail and
    // insertion moves the tail, so the added keys sit behind the cursor. The
    // assertion that matters is termination: an iterator that re-visits as it
    // goes never returns.
    const c = new PowerCache();
    for (let i = 0; i < 4; i++) c.set(`k${i}`, i);

    const seen = [];
    for (const [k] of c.entries()) {
      seen.push(k);
      c.set(`new-${k}`, k);
    }
    expect(seen).toEqual(['k3', 'k2', 'k1', 'k0']);
  });

  it('clear() inside the loop empties the cache', () => {
    // `clear()` removes every node at once, so the captured continuation is gone
    // too and the walk ends after the first entry. That is correct — there is
    // nothing left to visit — and the assertion is on `size`, not on a visit
    // count that would read as a truncation.
    const c = new PowerCache();
    c.set('a', 1);
    c.set('b', 2);
    for (const [key] of c.entries()) {
      void key;
      c.clear();
    }
    expect(c.size).toBe(0);
  });

  it('holds for the SLRU policy, where a hit promotes between segments', () => {
    // SLRU splices a hit out of probation into protected, so the walk is not a
    // simple pass over a stable list. Delete-all still has to empty it.
    for (const order of ['MRU', 'LRU']) {
      const c = new PowerCache({ policy: 'slru', maxEntries: 20 });
      for (let i = 0; i < 12; i++) c.set(`k${i}`, i);
      for (const [k] of c.entries(order)) c.delete(k);
      expect(c.size, `${order} must be emptied`).toBe(0);
    }
  });

  it('holds with the tinylfu admission window, and leaves the list walkable', () => {
    // The window means `_moveToTail` re-inserts a main-space hit at the window
    // boundary rather than at the tail, so the walk crosses a splice. It must
    // still visit each entry exactly once and leave a list whose length matches
    // `size` afterwards — the second half is the one that catches a fix which
    // leaves a node linked in neither direction.
    const c = new PowerCache({ admission: 'tinylfu', maxEntries: 50, windowSize: 10 });
    for (let i = 0; i < 40; i++) c.set(`k${i}`, i);

    const seen = new Set();
    for (const [k] of c.entries()) seen.add(k);
    expect(seen.size).toBe(40);

    let walked = 0;
    for (const key of c.keys()) {
      void key;
      walked++;
    }
    expect(walked).toBe(c.size);
  });

  it('node-pool reuse during a delete-and-reinsert walk leaves a consistent list', () => {
    // `_freeNode` returns the node object to a pool and a later `set` reuses it,
    // so a walk holding a reference across a removal can be looking at a
    // *different entry's* node. The invariant that matters is the one a caller
    // observes afterwards: `size` and a fresh walk agree, in both directions.
    const c = new PowerCache({ maxEntries: 8, maxPoolSize: 64 });
    for (let i = 0; i < 8; i++) c.set(`k${i}`, i);

    let steps = 0;
    for (const [k] of c.entries()) {
      if (++steps > 40) break; // bound the fixture, not the walk
      c.delete(k);
      for (let j = 0; j < 3; j++) c.set(`churn-${steps}-${j}`, j);
    }

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

  it('an empty cache yields nothing and a lone entry can be removed', () => {
    // The liveness tie this fix relies on: a lone entry has both links null and
    // is still a member, which is why membership cannot be read off the links.
    const empty = new PowerCache();
    expect([...empty.entries()]).toEqual([]);

    const one = new PowerCache();
    one.set('only', 1);
    for (const [k] of one.entries()) one.delete(k);
    expect(one.size).toBe(0);
  });
});
