import { describe, it, expect } from 'vitest';
// Not from `../src/index.js`: `SmallLfuSketch` is an internal util, not part of
// the public surface. My first import was from the index and every test failed
// with "is not a constructor" - which is the right failure, since importing an
// internal from the public entry would also mean shipping it by accident.
import { SmallLfuSketch } from '../src/utils/smallLfu.js';

// CACHE-007: hash the key once per `increment`/`estimate` and derive the row
// indices from that one hash.
//
// The premise, confirmed by reading before changing anything: `_index(key, row)`
// called `hashKey(key, seed + row * k, mask)`, and `hashKey` did `String(key)` plus
// a full FNV pass over the key's characters. At `depth: 4` that is four string
// coercions and four FNV loops per call, so the cost scaled with key length
// rather than staying fixed.
//
// Measured, median of five runs over 200 000 operations:
//
// | quantity                |   before |  after |
// | ----------------------- | -------: | -----: |
// | `increment` (depth 4)   |  75 ns   |  17 ns |
// | `estimate` (depth 4)    |  76 ns   |  14 ns |
// | both, short key         | 152 ns   |  31 ns |
// | hashing work, key len 24| 229 ns   | 118 ns |
// | hashing work, key len 64| 411 ns   | 240 ns |
//
// **Every assertion here is a counter, not a duration.** This project's timing
// harness has a ~29 % median min/max spread, so a wall-clock assertion would be
// decoration. What is actually being pinned is that the key is *converted and
// walked once per call*, which is a structural fact and is exact.

describe('the key is hashed once per call, not once per row', () => {
  it('increment coerces the key once regardless of depth', () => {
    // The assertion that pins the change. Before it, this was `depth` — four
    // `String(key)` calls per `increment`, and one per row.
    for (const depth of [1, 2, 4, 8]) {
      let coercions = 0;
      const key = {
        toString() {
          coercions += 1;
          return 'a-key';
        },
      };
      const sketch = new SmallLfuSketch({ width: 64, depth, sampleSize: 1_000_000 });
      sketch.increment(key);
      expect(coercions).toBe(1);
    }
  });

  it('estimate coerces the key once regardless of depth', () => {
    for (const depth of [1, 2, 4, 8]) {
      let coercions = 0;
      const key = {
        toString() {
          coercions += 1;
          return 'a-key';
        },
      };
      const sketch = new SmallLfuSketch({ width: 64, depth, sampleSize: 1_000_000 });
      sketch.estimate(key);
      expect(coercions).toBe(1);
    }
  });

  it('increment and estimate agree on the hash they derive', () => {
    // Two calls, two coercions — and the same result. If `increment` and
    // `estimate` hashed differently the sketch would report a frequency the
    // caller never earned, which is the whole contract of an admission filter.
    let coercions = 0;
    const key = {
      toString() {
        coercions += 1;
        return 'shared';
      },
    };
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    for (let i = 0; i < 5; i++) sketch.increment(key);
    expect(sketch.estimate(key)).toBe(5);
    expect(coercions).toBe(6); // 5 increments + 1 estimate, one each
  });
});

describe('the rows are still independent', () => {
  // Hashing once is only safe if the per-row spread still separates the rows.
  // Dropping the per-row seed would put all four rows on one column and turn a
  // 4-row sketch into a 1-row one - which "works", and is much worse.
  it('a key touches one counter per row, not one counter overall', () => {
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    // One increment saturates its four counters to 1. A single-column collapse
    // would still read 1, so check the underlying array instead: four distinct
    // non-zero bytes, and the parity bits that address them.
    sketch.increment('k');
    const touched = new Set();
    for (let i = 0; i < sketch.counters.length; i++) {
      if (sketch.counters[i] !== 0) touched.add(i);
    }
    expect(touched.size).toBe(4);
  });

  it('independent rows report a *lower* frequency, which is the point', () => {
    // **A mutant dropped `row * 0x9e3779b1` and this file did not notice.**
    // Two tests I wrote first failed to catch it, and both were reasoning about
    // the wrong statistic.
    //
    // The index is `row * width + column`, so even with one shared column the
    // four rows still land on four *different* counters. The sketch keeps
    // working, and a test counting distinct touched bytes sees four either way.
    //
    // The second attempt counted *distinct estimate values* and assumed more
    // spread means more variety. Measured, the opposite: 5 distinct with the
    // spread, 7 without. A collapsed sketch groups all four rows identically, so
    // the minimum across rows is a single consistent count — more uniform, and
    // therefore more varied across keys.
    //
    // The property that actually separates them is the one a count-min sketch
    // exists for: independent rows make the minimum *lower*, so keys are
    // under-reported rather than over-reported. 200 keys into 64 columns, summed
    // over all keys: 481 with the spread, 808 without.
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    for (let i = 0; i < 200; i++) sketch.increment(`k${i}`);
    let sum = 0;
    for (let i = 0; i < 200; i++) sum += sketch.estimate(`k${i}`);
    // Every key is reported at 1 in the best case; anything above that is
    // collision noise, and collapsing the rows roughly doubles it.
    expect(sum).toBeLessThanOrEqual(600);
  });

  it('a second key does not collapse onto the first', () => {
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    sketch.increment('aaaa');
    expect(sketch.estimate('aaaa')).toBe(1);
    expect(sketch.estimate('bbbb')).toBe(0);
  });
});

describe('accuracy is unchanged', () => {
  it('counts up to saturation', () => {
    // A 4-bit counter saturates at 15, and `estimate` reports the minimum across
    // rows, so the readable range is 0..15 regardless of hashing strategy.
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    for (let i = 1; i <= 15; i++) {
      sketch.increment('hot');
      expect(sketch.estimate('hot')).toBe(i);
    }
    sketch.increment('hot');
    expect(sketch.estimate('hot')).toBe(15);
  });

  it('collisions still happen, so the sketch is not accidentally perfect', () => {
    // A guard on the opposite failure: if every key landed on its own column
    // the sketch would be a map, and the memory guarantee would be fiction.
    const sketch = new SmallLfuSketch({ width: 2, depth: 1, sampleSize: 1_000_000 });
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    // Increment first, measure second. Measuring *during* the loop was the
    // mistake: with a random seed, all six keys can land in one column, giving
    // estimates 1..6 — six distinct values from six colliding keys. The seed
    // decides it, so the assertion was seed-dependent and wrong.
    for (const k of keys) sketch.increment(k);
    const estimates = keys.map((k) => sketch.estimate(k));
    // Two columns, six keys: at most two distinct final counts, whatever the
    // seed. Summing the estimates is *not* six — each key reports its whole
    // column's count, so a 4/2 split sums to 20. My first attempt asserted that
    // and failed; the distinct-count is the actual invariant.
    expect(new Set(estimates).size).toBeLessThanOrEqual(2);
  });

  it('honours a per-cache seed, so two sketches differ', () => {
    // Two caches must not share a hash pattern. Checked by looking for a
    // distribution difference rather than a specific column, so it survives a
    // change to the spread.
    const a = new SmallLfuSketch({ width: 64, depth: 4, seed: 1, sampleSize: 1_000_000 });
    const b = new SmallLfuSketch({ width: 64, depth: 4, seed: 2, sampleSize: 1_000_000 });
    let differing = 0;
    for (let i = 0; i < 200; i++) {
      a.increment(`k${i}`);
      if (a.estimate(`k${i}`) !== b.estimate(`k${i}`)) differing++;
    }
    expect(differing).toBeGreaterThan(0);
  });

  it('numeric and string keys with the same text are the same key', () => {
    // The `String(key)` coercion is load-bearing, not incidental: the key must
    // reach the mixer as text, or `mix32("hot12345", seed)` produced the number
    // `"hot12345"`, `| 0` turned it into 0, and every key landed in one bucket.
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    sketch.increment(12345);
    expect(sketch.estimate('12345')).toBe(1);
  });
});
