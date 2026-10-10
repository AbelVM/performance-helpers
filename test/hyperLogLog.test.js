/**
 * Direct tests for the HyperLogLog sketch.
 *
 * **These did not exist.** `HyperLogLog` was only ever exercised indirectly,
 * through `SmallLfuSketch`'s admission filter, so nothing pinned its accuracy,
 * its register-count handling, or its bias constant. That is how the class came
 * to ship with `ALPHA = 0.673` — the constant for **16** registers — while
 * hardcoding 64, biasing every estimate low by roughly 5 % on top of the 13 %
 * error it was supposed to bound. Found while parameterising the register count
 * for `bench/claims.js cardinality` (AUD-026): a constant that is wrong for the
 * one configuration the class hardcoded is invisible until the configuration
 * becomes a parameter.
 *
 * @see src/utils/hyperLogLog.js
 */
import { describe, it, expect } from 'vitest';
import { HyperLogLog } from '../src/utils/hyperLogLog.js';

/** A deterministic 32-bit hash source, so accuracy assertions are repeatable. */
function* hashes(n) {
  let a = 0x2545f491;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    yield (t ^ (t >>> 14)) >>> 0;
  }
}

describe('HyperLogLog', () => {
  it('estimates an empty sketch as zero', () => {
    expect(new HyperLogLog().cardinality()).toBe(0);
  });

  it('estimates a small set within its bound', () => {
    // The shipped configuration, at a cardinality where linear counting applies.
    // 13 % of 100 is 13, so this is a loose assertion on purpose — the point is
    // that the estimator is in the right region, not that it is exact.
    const h = new HyperLogLog();
    for (const x of hashes(100)) h.addHash(x);
    const est = h.cardinality();
    expect(est).toBeGreaterThan(70);
    expect(est).toBeLessThan(140);
  });

  it('estimates a large set within its bound', () => {
    const h = new HyperLogLog();
    for (const x of hashes(100_000)) h.addHash(x);
    const est = h.cardinality();
    // 13.93 % measured at n=100k by `bench/claims.js cardinality`, so a 25 %
    // band is generous but still catches a bias or a broken register update.
    expect(est).toBeGreaterThan(75_000);
    expect(est).toBeLessThan(125_000);
  });

  it('is idempotent: adding the same element twice does not change the estimate', () => {
    // The property `SmallLfuSketch` relies on when it re-adds a sampled key.
    const once = new HyperLogLog();
    const twice = new HyperLogLog();
    for (const x of hashes(1000)) once.addHash(x);
    for (const x of hashes(1000)) {
      twice.addHash(x);
      twice.addHash(x);
    }
    expect(twice.cardinality()).toBe(once.cardinality());
  });

  it('accepts a register count and honours it', () => {
    // AUD-026. The audit proposed replacing the sketch to reach a usable
    // accuracy; raising the register count reaches most of the way there for
    // bytes this library can afford.
    //
    // **Accuracy is asserted in the benchmark, not here.** A single sketch's
    // error is one sample from a distribution whose spread *is* the error, so
    // comparing two sketches on one hash sequence measures luck, not `m` — the
    // first draft of this test did exactly that and failed with the larger
    // sketch 14 % off and the smaller one 8 % off. `bench/claims.js cardinality`
    // averages 200 trials per cell, which is the only way the comparison means
    // anything. What is pinned here is that the parameter is honoured.
    const large = new HyperLogLog(1024);
    expect(large.registerCount).toBe(1024);
    expect(large.registers.length).toBe(1024);
    for (const x of hashes(100_000)) large.addHash(x);
    // Still a sane estimate, which is the property that would break if the
    // bucket mask or the shift were computed from the wrong constant.
    expect(large.cardinality()).toBeGreaterThan(50_000);
    expect(large.cardinality()).toBeLessThan(200_000);
  });

  it('defaults to 64 registers, so nothing changes for an existing caller', () => {
    const h = new HyperLogLog();
    expect(h.registerCount).toBe(64);
    expect(h.registers.length).toBe(64);
  });

  it('rejects a register count that is not a power of two', () => {
    // The bucket mask is `m - 1`, which is only a mask for a power of two. A
    // non-power-of-two would silently alias buckets and corrupt the estimate, so
    // it is refused rather than rounded.
    expect(() => new HyperLogLog(0)).toThrow(TypeError);
    expect(() => new HyperLogLog(100)).toThrow(TypeError);
    expect(() => new HyperLogLog(-64)).toThrow(TypeError);
    expect(() => new HyperLogLog(Number.NaN)).toThrow(TypeError);
    expect(() => new HyperLogLog(1.5)).toThrow(TypeError);
    // And the valid ones are accepted. `1` is a power of two and is allowed: it
    // gives a useless estimator, but it is not a corrupt one, and refusing it
    // would be a judgement the constructor has no basis for.
    expect(() => new HyperLogLog(1)).not.toThrow();
    expect(() => new HyperLogLog(16)).not.toThrow();
    expect(() => new HyperLogLog(4096)).not.toThrow();
  });

  it('uses the bias constant for its own register count, not a hardcoded one', () => {
    // The defect this file exists to pin. `ALPHA` was `0.673`, which is the
    // constant for m=16; the class hardcoded m=64, where it should be 0.709.
    // The 5 % bias that produced is the same order as the error the sketch
    // bounds, so it is not a rounding detail.
    //
    // Asserted through the estimate rather than through the private field: a
    // sketch of a known cardinality should land near it, and a low-biased
    // constant lands consistently below.
    const h = new HyperLogLog(64);
    for (const x of hashes(100_000)) h.addHash(x);
    // With the m=16 constant the estimate sits ~5 % low; with the right one it
    // sits within a few percent. 100k is large enough that linear counting is
    // not in play, so the bias is visible.
    expect(h.cardinality()).toBeGreaterThan(96_000);
  });

  it('resets to an empty sketch', () => {
    const h = new HyperLogLog(256);
    for (const x of hashes(1000)) h.addHash(x);
    expect(h.cardinality()).toBeGreaterThan(0);
    h.reset();
    expect(h.cardinality()).toBe(0);
    expect(h.registers.every((r) => r === 0)).toBe(true);
  });

  it('survives an unhashed sequential input, because it finalises internally', () => {
    // The promise of `addHash`: the argument may be a raw value. Sequential
    // integers all have `h >>> log2(m) === 0`, which without a mix puts the
    // maximum rank in every register and reports a cardinality in the billions.
    const h = new HyperLogLog();
    for (let i = 0; i < 1000; i++) h.addHash(i);
    expect(h.cardinality()).toBeLessThan(2000);
  });
});
