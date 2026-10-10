import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

describe('PowerCache S3-FIFO (ALG-002)', () => {
  it('accepts s3fifo policy and defaults to lru', () => {
    expect(new PowerCache()._policy).toBe('lru');
    expect(new PowerCache({ policy: 's3fifo' })._policy).toBe('s3fifo');
  });

  it('places new entries in Small', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1);
    expect(c._smallMap.has('a')).toBe(true);
    expect(c._map.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(false);
    expect(c.size).toBe(1);
  });

  it('promotes Small hits to Main', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1);
    expect(c._smallMap.has('a')).toBe(true);
    c.get('a');
    expect(c._map.has('a')).toBe(true);
    expect(c._smallMap.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(false);
  });

  // Rewritten for AUD-003. This test used to assert that a `get()` on a ghost
  // key re-admitted it straight to Main — which is only possible because the
  // ghost node *retained its evicted value* and `_fetchValidNode` served it.
  // That is the stale-value defect: a caller that evicted and refetched got the
  // old value back, silently. A ghost hit is a miss; the refetch is the whole
  // point of the miss. Re-admission still happens, on the write path, which is
  // what the second half of this test pins.
  it('treats a Ghost hit as a miss and re-admits on the next set', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Insert 'a' and promote to Main.
    c.set('a', 1);
    c.get('a');
    expect(c._map.has('a')).toBe(true);
    // Overfill Main to evict 'a' to Ghost.
    for (let i = 0; i < 10; i++) {
      c.set(`k${i}`, 1);
      c.get(`k${i}`);
    }
    expect(c._ghostMap.has('a')).toBe(true);
    // A read of a ghost key is a MISS: the ghost holds a key, not a value, so
    // there is nothing to serve and nothing to promote.
    expect(c.get('a')).toBeUndefined();
    expect(c.has('a')).toBe(false);
    expect(c.peek('a')).toBeUndefined();
    expect(c._map.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(true);
    // The write path is where re-admission belongs: `set` finds the ghost node,
    // writes the fresh value into it, and promotes it to Main.
    c.set('a', 'FRESH');
    expect(c._map.has('a')).toBe(true);
    expect(c._smallMap.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(false);
    expect(c.get('a')).toBe('FRESH');
  });

  it('evicts Small to Ghost when Small is full', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Small max size is 10% of 10 = 1.
    expect(c._smallMaxSize).toBe(1);
    c.set('a', 1);
    expect(c._smallSize).toBe(1);
    c.set('b', 1);
    // 'a' should have been evicted to Ghost.
    expect(c._smallSize).toBe(1);
    expect(c._ghostMap.has('a')).toBe(true);
    expect(c._smallMap.has('b')).toBe(true);
  });

  // Rewritten for AUD-005. This used to pin `expect(c._map.size).toBe(9)` after
  // promoting a 10th entry into Main — i.e. it pinned the off-by-one. The
  // eviction loop compared `_map.size >= maxEntries`, so Main settled at
  // `maxEntries - 1` and the *total* live set reached `maxEntries + 10 %`
  // (109 entries against a declared limit of 100, measured). `maxEntries` bounds
  // the whole live set, so the comparison is now against
  // `_map.size + _smallSize > maxEntries`.
  //
  // The consequence for the numbers below: with Small empty at the moment of the
  // check, Main may hold all 10; with Small holding its one entry, Main may hold
  // 9. Both are asserted rather than one, because the bound is on the sum.
  it('evicts Main to Ghost when the live set is over capacity', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Fill Main to capacity by promoting from Small.
    for (let i = 0; i < 9; i++) {
      c.set(`k${i}`, 1);
      c.get(`k${i}`); // promote to Main
    }
    expect(c._map.size).toBe(9);
    expect(c._smallSize).toBe(0);
    // Insert a new key and promote it to Main. Small is empty, so the whole
    // `maxEntries` budget is Main's and nothing is evicted yet.
    c.set('extra', 1);
    c.get('extra');
    expect(c._map.size).toBe(10);
    expect(c.size).toBe(10);
    expect(c._ghostMap.has('k0')).toBe(false);
    // The 11th live entry is what forces the eviction, and it evicts the Main
    // head — which is `k0`, the oldest promotion.
    c.set('one-more', 1);
    c.get('one-more');
    expect(c._map.size).toBe(10);
    expect(c.size).toBe(10);
    expect(c._ghostMap.has('k0')).toBe(true);
    expect(c._map.has('extra')).toBe(true);
    expect(c._map.has('one-more')).toBe(true);
  });

  it('drops evicted entries when Ghost is full', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Ghost max size is 20% of 10 = 2.
    expect(c._ghostMaxSize).toBe(2);
    // Fill Ghost.
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    c.set('d', 1);
    // 'a' and 'b' should be in Ghost, 'c' and 'd' should have been dropped.
    expect(c._ghostSize).toBe(2);
    expect(c._ghostMap.has('a')).toBe(true);
    expect(c._ghostMap.has('b')).toBe(true);
  });

  it('handles delete for all three queues', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1); // Small
    c.get('a'); // Main
    c.set('b', 1); // Small
    // Evict 'b' to Ghost.
    c.set('c', 1);
    expect(c._ghostMap.has('b')).toBe(true);
    // Delete from each queue.
    expect(c.delete('a')).toBe(true);
    expect(c._map.has('a')).toBe(false);
    expect(c.delete('b')).toBe(true);
    expect(c._ghostMap.has('b')).toBe(false);
    expect(c.delete('missing')).toBe(false);
  });

  it('clears all queues', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1);
    c.get('a');
    c.set('b', 1);
    c.set('c', 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c._map.size).toBe(0);
    expect(c._smallMap.size).toBe(0);
    expect(c._ghostMap.size).toBe(0);
    expect(c._smallSize).toBe(0);
    expect(c._ghostSize).toBe(0);
  });

  it('retains hot entries under scan (characterisation)', () => {
    const run = (policy) => {
      const c = new PowerCache({ maxEntries: 100, policy });
      const hot = Array.from({ length: 40 }, (_, i) => `hot-${i}`);
      for (let round = 0; round < 5; round++) {
        for (const k of hot) {
          c.set(k, 1);
          c.get(k);
        }
      }
      for (let i = 0; i < 500; i++) c.set(`scan-${i}`, 1);
      return hot.filter((k) => c.has(k)).length;
    };
    const lruHits = run('lru');
    const s3fifoHits = run('s3fifo');
    expect(s3fifoHits).toBeGreaterThanOrEqual(lruHits);
  });

  // --- AUD-003/004/005: the three S3-FIFO defects --------------------------
  // Each of these fails on the code as it was before the fix, which is the only
  // thing that makes it a test rather than a description.

  it('does not serve a stale evicted value off the ghost queue (AUD-003)', () => {
    // The audit's own repro. `_fetchValidNode` fell back to the ghost map, and
    // the ghost node still carried its evicted value, so `get()` returned it.
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 'ORIGINAL');
    c.get('a'); // promote to Main
    for (let i = 0; i < 12; i++) {
      c.set(`k${i}`, i);
      c.get(`k${i}`);
    }
    expect(c._ghostMap.has('a')).toBe(true);
    // A ghost hit is a miss. Serving 'ORIGINAL' here is silent data corruption:
    // the caller evicted and refetched, and got the value it already had.
    expect(c.get('a')).toBeUndefined();
  });

  it('releases the evicted value when a node moves to the ghost queue (AUD-004)', () => {
    // The ghost queue is an admission hint, so it holds keys. Retaining the
    // value kept up to `_ghostMaxSize` — 20 % of `maxEntries` — evicted objects
    // reachable indefinitely, which is the memory eviction was meant to free.
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    const big = { payload: new Array(1000).fill('x') };
    c.set('a', big);
    c.get('a');
    for (let i = 0; i < 12; i++) {
      c.set(`k${i}`, i);
      c.get(`k${i}`);
    }
    const ghost = c._ghostMap.get('a');
    expect(ghost).toBeDefined();
    expect(ghost.value).toBeUndefined();
    // Weight and expiry go with it: the node is no longer an entry, so carrying
    // either would make `_currentWeight` and the expiry sweep account for
    // something that is not resident.
    expect(ghost.weight).toBe(0);
    expect(ghost.expiresAt).toBe(0);
  });

  it('excludes ghost entries from size and exposes them separately (AUD-005a)', () => {
    // `size` counted `_ghostSize`, so a cache with `maxEntries: 100` reported
    // 119 — 99 live plus 20 ghost — for a cache holding 99 values.
    const c = new PowerCache({ maxEntries: 100, policy: 's3fifo' });
    for (let i = 0; i < 250; i++) {
      c.set(`k${i}`, i);
      c.get(`k${i}`);
    }
    expect(c._ghostSize).toBeGreaterThan(0);
    expect(c.size).toBe(c._map.size + c._smallSize);
    expect(c.size).toBeLessThanOrEqual(100);
    // The ghost count is still readable, because "is the admission hint being
    // populated at all" is a real diagnostic question.
    expect(c.ghostSize).toBe(c._ghostSize);
    expect(c.stats().ghostSize).toBe(c._ghostSize);
  });

  it('bounds the live set by maxEntries, not Main alone (AUD-005b)', () => {
    // The Main loop compared `_map.size >= maxEntries`, so Main settled at
    // `maxEntries - 1` and the total live set reached `maxEntries + 10 %`:
    // 109 entries against a declared limit of 100, measured.
    //
    // The workload matters. Reading every key promotes it out of Small, so Small
    // stays empty and the total is Main alone — which the old bound already kept
    // under the limit, and a test written that way passes either way. So only
    // every third key is read: the rest stay in Small, which is the queue whose
    // 10 % share the old bound forgot to subtract.
    const c = new PowerCache({ maxEntries: 100, policy: 's3fifo' });
    for (let i = 0; i < 500; i++) {
      c.set(`k${i}`, i);
      if (i % 3 === 0) c.get(`k${i}`); // promote to Main; the rest stay in Small
    }
    expect(c._smallSize).toBeGreaterThan(0);
    expect(c.size).toBeLessThanOrEqual(100);
    expect(c._map.size + c._smallSize).toBeLessThanOrEqual(100);
  });

  it('keeps _currentWeight balanced when Small entries are dropped (AUD-005c)', () => {
    // Found while fixing AUD-004/005, in the same function. The Small eviction
    // loop's *drop* branch — taken when the ghost queue is full — bypassed
    // `_unlinkNode`, which is where the Main path subtracts the weight, so every
    // dropped Small entry leaked its weight into `_currentWeight` permanently.
    // Measured at 58 against 10 resident entries after 60 inserts, which under
    // `maxWeight` evicts on the strength of weight the cache is not holding.
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo', maxWeight: 100 });
    for (let i = 0; i < 60; i++) c.set(`k${i}`, i, { weight: 1 });
    // Every resident entry weighs 1, so the running total is the resident count.
    expect(c._currentWeight).toBe(c._map.size + c._smallSize);
    expect(c._currentWeight).toBeLessThanOrEqual(100);
  });

  it('keeps _currentWeight balanced when Small entries move to Ghost (AUD-005c)', () => {
    // The other half of the same gap: the Small→Ghost branch also bypassed
    // `_unlinkNode`, which is where the Main path gets its subtraction. Both
    // branches now subtract, and `_s3fifoAppendGhost` zeroes the field so a
    // later `delete()` of the ghost key cannot subtract it twice.
    //
    // The keys are deliberately **not read**: a read promotes out of Small
    // immediately, so a workload of set-then-get never reaches this branch and
    // the test would pass either way.
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo', maxWeight: 100 });
    for (let i = 0; i < 5; i++) c.set(`k${i}`, i, { weight: 2 });
    // Small holds the last key; the two before it are ghosts; the first two were
    // dropped because the ghost queue (20 % of 10, so 2) was already full.
    expect(c._smallSize).toBe(1);
    expect(c._ghostSize).toBe(2);
    expect(c._currentWeight).toBe(2);
    const before = c._currentWeight;
    // Deleting a ghost key must not move the total: its weight was already
    // subtracted when it was ghosted, and the field is zero now.
    const ghostKey = [...c._ghostMap.keys()][0];
    expect(c.delete(ghostKey)).toBe(true);
    expect(c._currentWeight).toBe(before);
  });
});
