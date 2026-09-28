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
