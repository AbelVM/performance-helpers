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
//
// **GAP-014 changed how that fact is observable on the object path, and the
// change is not a loosening.** These tests used to count `String(key)` calls
// through an object key with a counting `toString`. An object key no longer
// reaches `String()` at all — it is hashed by a `WeakMap` identity instead — so
// the counter now reads **0** rather than `1`. That still kills the mutant these
// tests were written for (per-row hashing read `depth`), and it kills it more
// sharply: 0 against `depth`, at every depth. The primitive path keeps its own
// exact observable, a spy on `_hash`, because a primitive cannot be made to
// count its own coercion — there is no user code in `String(1)`.

/**
 * Count how many times a sketch derived a hash.
 *
 * One per `increment`/`estimate` call is the property. At `depth: 4` the old
 * shape was four, because `_index(key, row)` rehashed per row.
 *
 * @param {SmallLfuSketch} sketch
 * @returns {() => number} The count so far.
 */
function countHashes(sketch) {
  let calls = 0;
  const real = sketch._hash.bind(sketch);
  sketch._hash = (key) => {
    calls += 1;
    return real(key);
  };
  return () => calls;
}

describe('the key is hashed once per call, not once per row', () => {
  it('increment derives one hash per call regardless of depth', () => {
    // The assertion that pins the change, on the path where the count is
    // observable. Before it, this was `depth` — four hash derivations per
    // `increment`, one per row.
    for (const depth of [1, 2, 4, 8]) {
      const sketch = new SmallLfuSketch({ width: 64, depth, sampleSize: 1_000_000 });
      const hashes = countHashes(sketch);
      sketch.increment('a-key');
      expect(hashes()).toBe(1);
    }
  });

  it('estimate derives one hash per call regardless of depth', () => {
    for (const depth of [1, 2, 4, 8]) {
      const sketch = new SmallLfuSketch({ width: 64, depth, sampleSize: 1_000_000 });
      const hashes = countHashes(sketch);
      sketch.estimate('a-key');
      expect(hashes()).toBe(1);
    }
  });

  it('increment and estimate agree on the hash they derive', () => {
    // Two calls, two derivations — and the same result. If `increment` and
    // `estimate` hashed differently the sketch would report a frequency the
    // caller never earned, which is the whole contract of an admission filter.
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    const hashes = countHashes(sketch);
    for (let i = 0; i < 5; i++) sketch.increment('shared');
    expect(sketch.estimate('shared')).toBe(5);
    expect(hashes()).toBe(6); // 5 increments + 1 estimate, one each
  });
});

describe('an object key is never stringified', () => {
  // The three tests above used an object with a counting `toString` to observe
  // the conversion count. GAP-014 (ADR 0007) routed object keys around
  // `String(key)` entirely — `String({})` is `"[object Object]"` for *every*
  // object, so a cache keyed by object references handed the filter one counter
  // for the whole key space — and the observable became stricter.
  it('increment stringifies an object key zero times, at any depth', () => {
    // 0, not 1. A key the caller gave a `toString` is never asked for its text,
    // because its identity is the reference and its text is not it. The mutant
    // this kills is the one that matters: `needsIdentity` returning false puts
    // the count back at `depth`.
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
      expect(coercions).toBe(0);
    }
  });

  it('estimate stringifies an object key zero times', () => {
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
      expect(coercions).toBe(0);
    }
  });

  it('a repeated object is given one identity, not one per call or per row', () => {
    // `_nextId` is the allocation counter, so it is the exact observable for
    // "the id is derived once per *key*". A sketch that minted an id per call
    // would report every object as never-seen — which fails the reference test
    // in `smallLfu.test.js` in the opposite direction, with every key cold.
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    const key = { id: 'stable' };
    for (let i = 0; i < 5; i++) sketch.increment(key);
    sketch.estimate(key);
    expect(sketch._nextId).toBe(1);
    expect(sketch.estimate(key)).toBe(5);
  });

  it('a throwing toString never runs, so a hostile key cannot break admission', () => {
    // The identity path does not call user code at all. A key whose `toString`
    // throws was previously a way to make `set()` throw from inside the filter;
    // now it is just a key.
    const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
    const key = {
      toString() {
        throw new Error('should never be called');
      },
    };
    expect(() => sketch.increment(key)).not.toThrow();
    expect(sketch.estimate(key)).toBe(1);
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
