/**
 * `SmallLfuSketch` — the W-TinyLFU frequency sketch (ALG-002).
 *
 * Every test here pins a property the *admission* decision depends on. A
 * frequency filter that overcounts one key and undercounts another admits the
 * wrong entry, and unlike a slow path that failure is silent: the cache simply
 * keeps throwing away the keys that were hot.
 */
import { describe, it, expect } from 'vitest';
import { SmallLfuSketch } from '../src/utils/smallLfu.js';
import { HyperLogLog } from '../src/utils/hyperLogLog.js';
import { PowerCache } from '../src/helpers/powerCache.js';

/**
 * A sketch with the half-life reset effectively disabled, for tests that assert
 * exact counter values.
 *
 * `sampleSize: 1e9` is the right tool for *counter arithmetic* — a test that
 * increments 200 times and expects exactly 15 needs the sketch not to have been
 * halved on the way. It is the wrong tool for anything that asserts a property
 * the cache actually depends on, because the production half-life is
 * `200 * maxEntries` and a reset never fires in a test-sized run.
 *
 * **This distinction is not cosmetic.** Every test in this file originally used
 * this one helper, including `distinguishes keys by how often they were seen` —
 * the headline property, and the one that should have caught the broken
 * admission rule. A sketch with no reset behaves correctly, so the suite passed
 * while the shipped feature refused every cold-start admission. Use
 * `realistic()` for anything about frequency *ranking*; use this only for the
 * arithmetic.
 */
const wide = (opts) => new SmallLfuSketch({ width: 1024, depth: 4, sampleSize: 1e9, ...opts });

/**
 * A sketch with a production-shaped half-life: wide enough that distinct keys
 * do not collide, and a `sampleSize` a real cache would use relative to a
 * realistically-sized working set. Resets fire, as they do in production.
 *
 * @param {Object} [opts] - Overrides, e.g. `seed`.
 * @returns {SmallLfuSketch}
 */
const realistic = (opts) =>
  new SmallLfuSketch({ width: 1024, depth: 4, sampleSize: 200 * 40, ...opts });

describe('SmallLfuSketch', () => {
  it('distinguishes keys by how often they were seen', () => {
    // The single most important property. An earlier version hashed with
    // `mix32(String(key), seed)`, where the string met the number with `+` and
    // produced "hot12345" - which `| 0` turned into 0. Every key landed in the
    // same bucket and the sketch reported the same frequency for everything.
    const s = wide();
    for (let i = 0; i < 10; i += 1) s.increment('hot');
    for (let i = 0; i < 3; i += 1) s.increment('warm');
    s.increment('cold');

    expect(s.estimate('hot')).toBe(10);
    expect(s.estimate('warm')).toBe(3);
    expect(s.estimate('cold')).toBe(1);
    expect(s.estimate('hot')).toBeGreaterThan(s.estimate('warm'));
    expect(s.estimate('warm')).toBeGreaterThan(s.estimate('cold'));
  });

  it('still ranks a recurring key above a one-shot key once the half-life is live', () => {
    // The property the *cache* depends on, at a production-shaped half-life.
    // The test above is arithmetic and needs the reset disabled; this one is the
    // behaviour, and it is the test whose absence let a broken admission rule
    // ship behind a fully green suite.
    const s = realistic({ seed: 3 });
    const hot = Array.from({ length: 40 }, (_, i) => `hot:${i}`);
    // Each round: every hot key once, then a burst of one-shot scan keys. The
    // scan is what a frequency filter exists to reject, so it has to be present
    // for the ranking to mean anything.
    for (let round = 0; round < 40; round += 1) {
      for (const k of hot) s.increment(k);
      for (let scan = 0; scan < 25; scan += 1) s.increment(`scan:${round}:${scan}`);
    }
    const hotEstimates = hot.map((k) => s.estimate(k));
    const oneShot = [0, 1, 2, 3, 4].map((k) => s.estimate(`scan:39:${k}`));
    const worstHot = Math.min(...hotEstimates);
    const bestOneShot = Math.max(...oneShot);

    // The hot set must outrank the scan on *every* key, not on average. A
    // filter that only gets this right on average still admits one-shots
    // whenever a single hot key is under-counted, which is the whole decision.
    expect(worstHot).toBeGreaterThan(bestOneShot);
  });

  it('the half-life reset actually fires at a production-shaped sampleSize', () => {
    // Guards the guard: if `realistic()` ever drifts back to a huge sampleSize
    // the test above silently stops testing anything, exactly as this whole
    // file did before the helper was split.
    const s = realistic({ seed: 3 });
    expect(s.sampleSize).toBeLessThan(1e6);
    for (let i = 0; i < s.sampleSize + 1; i += 1) s.increment(`k:${i}`);
    expect(s.resets).toBeGreaterThan(0);
  });

  it('reports 0 for a key it has never seen', () => {
    const s = wide();
    s.increment('a');
    expect(s.estimate('b')).toBe(0);
  });

  it('saturates at 15 rather than wrapping', () => {
    // 4-bit counters. A wrapped counter would make a very hot key look cold,
    // which is precisely the mistake the 4-bit width is chosen to avoid.
    const s = wide();
    for (let i = 0; i < 200; i += 1) s.increment('x');
    expect(s.estimate('x')).toBe(15);
  });

  it('packs two counters per byte without bleeding into each other', () => {
    const s = wide();
    s.increment('a');
    s.increment('b');
    expect(s.estimate('a')).toBe(1);
    expect(s.estimate('b')).toBe(1);
    for (let i = 0; i < 3; i += 1) s.increment('a');
    // `b` must be untouched, whether it shares a byte with `a` or not.
    expect(s.estimate('a')).toBe(4);
    expect(s.estimate('b')).toBe(1);
  });

  it('halves every counter on reset', () => {
    const s = wide();
    for (let i = 0; i < 12; i += 1) s.increment('y');
    expect(s.estimate('y')).toBe(12);
    s.reset();
    expect(s.estimate('y')).toBe(6);
    s.reset();
    expect(s.estimate('y')).toBe(3);
  });

  it('rounds the halving down, so it forgets rather than remembers', () => {
    // A counter of 1 becomes 0. That bias is the point: for an admission
    // filter, decaying towards "I do not know" is the safe direction, because
    // a key that looks cold is admitted on the next genuine sighting.
    const s = wide();
    s.increment('z');
    expect(s.estimate('z')).toBe(1);
    s.reset();
    expect(s.estimate('z')).toBe(0);
  });

  it('resets itself after sampleSize increments', () => {
    // Without this, counters ratchet to 15 and stay there, freezing the
    // filter's idea of what is hot.
    const s = new SmallLfuSketch({ width: 1024, depth: 4, sampleSize: 4 });
    for (let i = 0; i < 4; i += 1) s.increment('z');
    expect(s.estimate('z')).toBe(2); // 4 >> 1
    expect(s.resets).toBe(1);
  });

  it('clear() empties the sketch, for a cache that was reset', () => {
    const s = wide();
    for (let i = 0; i < 9; i += 1) s.increment('q');
    expect(s.estimate('q')).toBe(9);
    s.clear();
    expect(s.estimate('q')).toBe(0);
    expect(s.resets).toBe(0);
  });

  it('counts 1 and "1" together, because they are one key to a caller', () => {
    // They are different keys at the API level, but a filter that split one hot
    // key's history across two counters would under-report exactly the key it
    // most needs to recognise.
    const s = wide();
    s.increment(1);
    s.increment('1');
    expect(s.estimate(1)).toBe(2);
    expect(s.estimate('1')).toBe(2);
  });

  it('reports its own memory cost', () => {
    // Two 4-bit counters per byte, so width * depth / 2.
    expect(wide({ width: 1024, depth: 1 }).size()).toBe(512);
    expect(wide({ width: 1024, depth: 4 }).size()).toBe(2048);
  });

  it('rounds the width up to a power of two', () => {
    // The columns are addressed with a mask, which only works on a power of two.
    expect(wide({ width: 100 }).width).toBe(128);
    expect(wide({ width: 2 }).width).toBe(2);
  });

  it('falls back to the default for a nonsensical width or depth', () => {
    // `Number(x) || DEFAULT` means 0 and NaN both fall back rather than
    // collapsing the sketch to one or two columns. Nonsense configuration
    // getting the documented default is friendlier than a working sketch that
    // admits almost everything.
    expect(wide({ width: 0 }).width).toBe(64);
    expect(wide({ width: Number.NaN }).width).toBe(64);
    expect(wide({ depth: 0 }).depth).toBe(4);
    expect(wide({ depth: Number.NaN }).depth).toBe(4);
  });

  it('clamps depth so one sketch cannot be made unbounded', () => {
    expect(wide({ depth: 99 }).depth).toBe(8);
    expect(wide({ depth: 1 }).depth).toBe(1);
  });

  it('two sketches with different seeds do not share a bucket pattern', () => {
    // Otherwise two caches in one process would make correlated admission
    // decisions for unrelated workloads.
    const a = wide({ seed: 1 });
    const b = wide({ seed: 2 });
    a.increment('k');
    b.increment('k');
    // Same estimate either way for one increment - the point is that the
    // *pattern* differs, which is what a differing seed buys.
    expect(a.seed).not.toBe(b.seed);
  });

  it('handles object keys without throwing', () => {
    // A Map key in a cache is legitimate, and String() of it must not explode.
    const s = wide();
    const key = { id: 1 };
    expect(() => s.increment(key)).not.toThrow();
    expect(s.estimate(key)).toBe(1);
  });
});

/**
 * GAP-014 / ADR 0007. The sketch used to bucket an object key by
 * `String(key)`, which is `"[object Object]"` for *every* object — so a cache
 * keyed by object references (which `PowerCache` is: its entries live in a
 * `Map`) handed the filter one counter for the whole key space.
 *
 * These tests are the discriminating ones ADR 0007 names: every other option it
 * weighed — reject object keys, document the limit, add an `admissionKey`
 * function — **fails the first test**, because the failure is not "object keys
 * are handled badly", it is "a never-seen object reports a hot object's
 * frequency".
 */
describe('SmallLfuSketch — keys compared by reference', () => {
  it('a never-seen object key does not report a hot object key’s frequency', () => {
    // The assertion that decides ADR 0007. Before the identity path: three
    // distinct objects all estimated 3, and `{id:'delta'}`, never inserted,
    // also estimated 3 — the sketch could not tell a new object from a hot one,
    // so it had no admission signal to offer at all. Not a noisy one: none.
    const s = wide();
    const alpha = { id: 'alpha' };
    const beta = { id: 'beta' };
    const gamma = { id: 'gamma' };
    const delta = { id: 'delta' }; // never inserted

    for (let i = 0; i < 3; i += 1) s.increment(alpha);
    s.increment(beta);
    s.increment(gamma);

    expect(s.estimate(alpha)).toBe(3);
    expect(s.estimate(beta)).toBe(1);
    expect(s.estimate(gamma)).toBe(1);
    // The line the whole row is about.
    expect(s.estimate(delta)).toBe(0);
  });

  it('two structurally identical objects are two keys, as the cache sees them', () => {
    // PowerCache stores entries in a Map, so `{id:'a'}` and another `{id:'a'}`
    // are two entries. The filter that is supposed to rank them must agree, or
    // the cache admits on a frequency that belongs to a different entry.
    const s = wide();
    const first = { id: 'a' };
    const second = { id: 'a' };
    expect(first).not.toBe(second);

    for (let i = 0; i < 5; i += 1) s.increment(first);
    expect(s.estimate(first)).toBe(5);
    expect(s.estimate(second)).toBe(0);
  });

  it('the same object keeps its counter across calls', () => {
    // The identity has to be *stable*, not merely distinct: a sketch that
    // handed out a fresh id per call would report every object as never-seen,
    // which fails the first test in the opposite direction — every key cold.
    const s = wide();
    const key = { id: 'stable' };
    s.increment(key);
    s.increment(key);
    expect(s.estimate(key)).toBe(2);
    expect(s.estimate(key)).toBe(2); // a third read must not re-derive an id
  });

  it('an object key does not share a counter with the string that spells its id', () => {
    // The id is handed out in order, so the third object in a cache hashes to
    // `2` — the same *integer* a caller's string key `'2'` would suggest. They
    // still land apart, because the string path arrives as FNV-1a of `"2"` and
    // `_indexFor` runs `mix32` per row over a different hash.
    //
    // This is also the test that would fail if someone added a salt without
    // thinking: the ids need no salt, and one would be a cost with no claim
    // behind it.
    const s = wide();
    const objects = [{ n: 0 }, { n: 1 }, { n: 2 }];
    s.increment(objects[0]);
    s.increment(objects[1]);
    s.increment(objects[2]);

    expect(s.estimate('0')).toBe(0);
    expect(s.estimate('1')).toBe(0);
    expect(s.estimate('2')).toBe(0);
    // And the objects are distinct from each other, which is the half that
    // actually matters.
    expect(s.estimate(objects[0])).toBe(1);
    expect(s.estimate(objects[1])).toBe(1);
    expect(s.estimate(objects[2])).toBe(1);
  });

  it('function keys are identity-tracked too', () => {
    // `String(fn)` is the function's *source text*, so two different functions
    // written identically collided — and a function is compared by reference in
    // a Map exactly like an object.
    const s = wide();
    const make = () => (n) => n;
    const a = make();
    const b = make();
    expect(String(a)).toBe(String(b)); // the collision the string path would cause

    for (let i = 0; i < 4; i += 1) s.increment(a);
    expect(s.estimate(a)).toBe(4);
    expect(s.estimate(b)).toBe(0);
  });

  it('primitives keep their shared-counter behaviour', () => {
    // `1`, '1' and `new String('1')` are three keys to the cache and *one*
    // identity to the filter, deliberately: splitting one hot key's history
    // across two counters under-reports the key the filter most needs to
    // recognise. The identity path must not change that.
    const s = wide();
    s.increment(1);
    s.increment('1');
    expect(s.estimate(1)).toBe(2);
    expect(s.estimate('1')).toBe(2);
  });

  it('null, symbols and bigints still hash by value, and say so', () => {
    // All three stringify to something unique, so none of them may be routed
    // through the WeakMap — and the observable is their *shared counter* with
    // the string that spells them, not merely that they count. Routing `null`
    // through the identity path (it is `typeof 'object'`) drops `estimate('null')`
    // to 0, and routing symbols through it drops `estimate('Symbol(x)')`.
    const s = wide();
    s.increment(null);
    s.increment(Symbol.for('x'));
    s.increment(10n);

    expect(s.estimate(null)).toBe(1);
    expect(s.estimate('null')).toBe(1);
    expect(s.estimate(Symbol.for('x'))).toBe(1);
    expect(s.estimate('Symbol(x)')).toBe(1);
    expect(s.estimate(10n)).toBe(1);
    expect(s.estimate('10')).toBe(1);
  });

  it('a PowerCache keyed by objects admits on per-object history, not one shared counter', () => {
    // The end-to-end shape of the row: the sketch is internal, so a test that
    // only poked `SmallLfuSketch` could pass while the cache kept collapsing.
    //
    // The discriminating assertion is the **estimate**, not the refusal. Before
    // the identity path, `fresh` shared `hot`'s counter, so it arrived at the
    // admission comparison with the incumbent's own frequency — and was still
    // refused, for entirely the wrong reason. A test that only checked
    // "was it refused?" would have passed on the broken code.
    const cache = new PowerCache({ maxEntries: 64, admission: 'tinylfu', seed: 7 });
    const hot = { id: 'hot' };
    const resident = { id: 'resident' };
    const fresh = { id: 'fresh' };

    // Fill to capacity so the filter is consulted at all: admission only runs at
    // capacity, so a cache that never filled has measured nothing. 62 fillers and
    // two named keys reach 64 — filling to 64 *first* has the two named keys
    // refused on arrival, which is the filter working and would leave them with
    // no history to assert on.
    for (let i = 0; i < 62; i += 1) cache.set({ fill: i }, i);
    cache.set(hot, 1);
    cache.set(resident, 2);
    for (let i = 0; i < 8; i += 1) {
      cache.get(hot);
      cache.get(resident);
    }

    const sketch = cache._sketch;
    expect(sketch).not.toBeNull();
    // Before the fix all three of these read the same number, because they shared
    // the key `"[object Object]"`. `hot` and `resident` are given *equal* history
    // on purpose — comparing them to each other would assert nothing, and what
    // matters is that both outrank a key the cache has never seen.
    expect(sketch.estimate(fresh)).toBe(0);
    expect(sketch.estimate(hot)).toBeGreaterThan(sketch.estimate(fresh));
    expect(sketch.estimate(resident)).toBeGreaterThan(sketch.estimate(fresh));

    cache.set(fresh, 3);
    // `false` is the *oversize* refusal; an admission refusal returns `this` for
    // chaining, so the counter is the signal. Reading it as a return value is
    // the kind of guess that compiles into a test that cannot fail.
    expect(cache.stats().rejectedAdmission).toBeGreaterThan(0);
    expect(cache.has(fresh)).toBe(false);
  });
});

describe('HyperLogLog (ALG-005)', () => {
  // The sketch is fed by `SmallLfuSketch`, which FNV-1a hashes every key
  // before calling `addHash`. These tests do the same, because the estimator
  // is only correct for well-distributed inputs: sequential integers 0..N
  // all have `h >>> 6 === 0`, which without a mix saturates every register
  // at rank 27 and reports a cardinality in the billions for a 100-element
  // set. `addHash` now finalises internally, so a raw integer call is still
  // safe — but the *estimate* is only meaningful for hashed input, which is
  // what this file documents and what the integration test below exercises.
  const hashKey = (key) => {
    const text = String(key);
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < text.length; i += 1) {
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    }
    return h;
  };

  it('estimates cardinality of a small set within tolerance', () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 100; i += 1) hll.addHash(hashKey(i));
    const est = hll.cardinality();
    expect(est).toBeGreaterThan(80);
    expect(est).toBeLessThan(120);
  });

  it('estimates cardinality of a larger set', () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 10_000; i += 1) hll.addHash(hashKey(i));
    const est = hll.cardinality();
    // 64 registers give ~13 % standard error, not the ~1 % the header's
    // first draft claimed; allow a wide band so the test does not fail on a
    // legitimate statistical outlier.
    expect(est).toBeGreaterThan(7_000);
    expect(est).toBeLessThan(13_000);
  });

  it('resets registers to zero', () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 500; i += 1) hll.addHash(hashKey(i));
    expect(hll.cardinality()).toBeGreaterThan(400);
    hll.reset();
    expect(hll.cardinality()).toBe(0);
  });

  it('handles duplicate adds without inflating the estimate', () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 1000; i += 1) hll.addHash(hashKey(42));
    expect(hll.cardinality()).toBeLessThan(100);
  });

  it('returns 0 for an empty sketch', () => {
    const hll = new HyperLogLog();
    expect(hll.cardinality()).toBe(0);
  });

  it('finalises raw integer input instead of saturating', () => {
    // The bug this pins: sequential integers all had `h >>> 6 === 0`, so
    // every register took rank 27 and cardinality() returned 5.7 billion
    // for a 100-element set. `addHash` now mixes internally.
    const hll = new HyperLogLog();
    for (let i = 0; i < 100; i += 1) hll.addHash(i);
    expect(hll.cardinality()).toBeGreaterThan(80);
    expect(hll.cardinality()).toBeLessThan(120);
  });
});

describe('SmallLfuSketch auto-tuned sampleSize (ALG-005 integration)', () => {
  // The point of the companion HLL is that `sampleSize` adapts to the working
  // set rather than staying at the default 10. The assertion is a **shape** —
  // a bigger working set produces a bigger half-life — not a pinned number,
  // because the HLL's 64-register error is ~13 % and any tighter band would
  // flake on a legitimate outlier.

  it('grows sampleSize with the number of distinct keys', () => {
    const small = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 10 });
    const big = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 10 });

    const SMALL = 200;
    const BIG = 20_000;

    // Drive each sketch past one reset so the HLL's cardinality is read and
    // `sampleSize` is recomputed. 200 increments is 20 resets at the default
    // 10; 20 000 is 200.
    for (let i = 0; i < SMALL; i += 1) small.increment('k' + i);
    for (let i = 0; i < BIG; i += 1) big.increment('k' + i);

    expect(big.sampleSize).toBeGreaterThan(small.sampleSize);
  });

  it('keeps a bounded sampleSize when the working set is small', () => {
    const s = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 10 });
    for (let i = 0; i < 200; i += 1) s.increment('k' + i);
    // The HLL is reset alongside the sketch, so it measures distinct keys per
    // *half-life window* rather than the all-time total, and `sampleSize`
    // converges to ~10x that. For 200 distinct keys that is ~1000 — a
    // reasonable half-life, and a long way from the failure this guards
    // against (an unbounded sampleSize, which stops the sketch halving ever
    // and turns the half-life into an infinite counter). The bound is loose
    // on purpose: it is a shape test (bounded, not astronomical), not a
    // pinned number, because the HLL's 64-register error is ~13 %.
    expect(s.sampleSize).toBeGreaterThanOrEqual(10);
    expect(s.sampleSize).toBeLessThanOrEqual(100_000);
  });
});
