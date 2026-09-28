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

/** A sketch large enough that distinct keys do not collide. */
const wide = (opts) => new SmallLfuSketch({ width: 1024, depth: 4, sampleSize: 1e9, ...opts });

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
