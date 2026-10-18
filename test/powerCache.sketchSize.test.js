/**
 * The TinyLFU admission sketch was not sized to the cache it was protecting.
 *
 * `PowerCache` built its sketch with only `sampleSize` set, so `width` and
 * `depth` kept the sketch's own defaults — a fixed 64x4 = 256 counters, 128
 * bytes — whatever the cache's capacity. Counters per cache entry, measured:
 *
 *     maxEntries      16 ->  16.00 counters/entry
 *     maxEntries      64 ->   4.00
 *     maxEntries    1000 ->   0.256      <- 63x short of Caffeine's 16
 *     maxEntries  1000000 ->   0.00026    <- 62 500x short
 *
 * The accuracy of an admission filter depending on nothing about the cache is
 * not a tuning question; at 1 000 entries it stops working at all. Measured,
 * with a working set at capacity:
 *
 *     maxEntries 1000, 256 counters:  hot keys all read 15
 *                                      a key NEVER inserted also read 15
 *                                      -> 1 distinct estimate across 6 keys
 *
 * One estimate for everything means the filter cannot refuse a scan key, which
 * is the entire reason a filter is in the admission path. Caffeine's recipe is
 * 16 counters per entry — a 4-bit CountMinSketch "growing at 8 bytes per cache
 * entry" — with a power-of-two table.
 *
 * The second half was a **defect that read as a refinement**, and it is recorded
 * here because the test that pinned it had to be inverted. The sample counter
 * used to advance only on an *effective* increment — one that actually moved a
 * counter — on the reasoning that a saturated sketch should not reset "with no
 * change to anything a reader could observe". Caffeine does advance only on an
 * effective increment (`incrementAt` returns false once saturated), so the
 * reasoning had a precedent behind it.
 *
 * The consequence is that a fully saturated sketch **never resets at all**, and
 * a sketch that never resets can never forget. Halving is the only thing that
 * lets a counter fall below the 4-bit maximum of 15, and the admission rule
 * refuses on `estimate(incumbent) >= estimate(challenger)`, so a counter pinned
 * at 15 is unbeatable by construction. Combined with the `set()` refusal branch
 * not recording a refused key, a cache whose working set had shifted could
 * never admit the new one: measured, 60 000 requests, `rejectedAdmission`
 * 60 000, `evictions` 0, hit rate falling from 99 % to 24.8 % with no recovery.
 * The clock now counts operations, which is what a half-life is.
 *
 * The sizing assertions are **thresholds and ratios**, never a pinned width.
 * A pinned number here would be a claim about one machine's arithmetic that
 * breaks the moment the target ratio or the depth changes, and the review that
 * asked for this work recorded that a previous attempt's exact figures could
 * not be reproduced by the person who filed it.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';
import { SmallLfuSketch } from '../src/utils/smallLfu.js';

/** @param {number} maxEntries @returns {SmallLfuSketch} */
const sketchFor = (maxEntries, seed) =>
  /** @type {any} */ (new PowerCache({ maxEntries, admission: 'tinylfu', seed })._sketch);

/** Counters in the sketch's table. @param {any} s */
const counters = (s) => s.width * s.depth;

describe('the admission sketch is sized from the cache capacity', () => {
  it("holds at least Caffeine's 16 counters per entry across the range", () => {
    // A ratio, not a width. The old table was 256 counters at every capacity,
    // so the ratio collapses as the cache grows; the fix is a ratio that holds.
    for (const maxEntries of [16, 64, 1000, 100_000]) {
      const s = sketchFor(maxEntries);
      const perEntry = counters(s) / maxEntries;
      expect(
        perEntry,
        `maxEntries ${maxEntries}: ${counters(s)} counters is ${perEntry.toFixed(4)} per entry`
      ).toBeGreaterThanOrEqual(16);
    }
  });

  it('grows with the cache instead of being a fixed table', () => {
    // The shape of the old defect, stated directly. Every one of these used to
    // report `width` 64 and 128 bytes.
    const small = sketchFor(16);
    const large = sketchFor(1000);
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.size()).toBeGreaterThan(small.size());
  });

  it('rounds the table up to a power of two, never down', () => {
    // The sketch indexes with `mask = width - 1`, so the width must be a power
    // of two. Rounding down would land below the target budget at exactly the
    // capacities where the ratio is tightest, which would re-create the defect
    // in the range most likely to be used.
    for (const maxEntries of [17, 100, 999, 1000, 4097]) {
      const { width } = sketchFor(maxEntries);
      expect(
        Number.isInteger(Math.log2(width)),
        `width ${width} for maxEntries ${maxEntries} is not a power of two`
      ).toBe(true);
    }
  });

  it('does not try to size a table for an unbounded cache', () => {
    // `maxEntries` defaults to `Infinity`, so this is not a formality: a
    // formula of `16 * Infinity` is not a width. It is also harmless, because
    // an unbounded cache never consults the filter — `_admit` only arbitrates
    // once `size >= maxEntries`.
    const unbounded = new PowerCache({ admission: 'tinylfu' });
    const s = /** @type {any} */ (unbounded._sketch);
    expect(Number.isFinite(s.width)).toBe(true);
    expect(s.width).toBeGreaterThanOrEqual(2);
    // And it stays at the ceiling rather than growing without bound.
    expect(s.width).toBe(sketchFor(1e6).width);
  });

  it('leaves the sketch absent unless tinylfu admission was asked for', () => {
    // The fix must not turn a cost onto the default path. A plain LRU cache
    // allocates no table at all.
    expect(new PowerCache({ maxEntries: 1000 })._sketch).toBeNull();
    expect(new PowerCache({ maxEntries: 1000, admission: 'lru' })._sketch).toBeNull();
    // Nor when the sketch cannot arbitrate anything.
    expect(new PowerCache({ maxEntries: 1000, policy: 'slru' })._sketch).toBeNull();
  });
});

describe('a correctly sized sketch discriminates at capacity', () => {
  it('scores a never-inserted key below a hot one at maxEntries 1000', () => {
    // The mechanism CACHE-005 describes, at the capacity where the old
    // 256-counter table could not do it. Before the fix every one of these
    // read 15 and a never-inserted key read 15 as well: one estimate across the
    // whole key space, so a one-shot scan key was indistinguishable from the
    // working set and the filter carried no information at all.
    const s = sketchFor(1000);
    for (let round = 0; round < 20; round += 1) {
      for (let k = 0; k < 1000; k += 1) s.increment(`hot-${k}`);
    }

    const hot = [0, 1, 2, 3, 4].map((k) => s.estimate(`hot-${k}`));
    const cold = s.estimate('never-inserted-key');

    expect(hot).toEqual([15, 15, 15, 15, 15]);
    expect(cold).toBeLessThan(Math.min(...hot));
    // The property that was lost, stated as a count of distinct estimates.
    expect(new Set([...hot, cold]).size).toBeGreaterThan(1);
  });

  it('still discriminates at small capacities, which it always did', () => {
    // Pinned so the resize cannot be "fixed" by widening until everything
    // collides. At 16 entries the old table was already adequate (16
    // counters/entry) and must stay adequate.
    //
    // **Seeded, over several seeds.** `smallLfu.js:138` draws a random
    // per-instance seed when none is given, so this assertion was a coin flip: a
    // Count-Min sketch never underestimates, so a cold key that happens to collide
    // with a hot key in *every* row reports the same estimate. Observed failing
    // at exactly `expected 15 to be less than 15`, where 15 is the saturated
    // minimum — the collision, not a regression. One fixed seed would only replace
    // a random failure with a lucky pass unless the seed were chosen for passing,
    // which is how a guard becomes decoration, so the property is checked across
    // five. Each is a real seed the sketch can draw, not a value tuned to collide.
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = sketchFor(16, seed);
      for (let round = 0; round < 20; round += 1) {
        for (let k = 0; k < 16; k += 1) s.increment(`hot-${k}`);
      }
      expect(
        s.estimate('never-inserted-key'),
        `a never-inserted key must read below a hot one at seed ${seed}`
      ).toBeLessThan(s.estimate('hot-0'));
    }
  });
});

describe('the half-life counts operations, so a saturated sketch can still age', () => {
  it('keeps the clock moving once every counter is saturated', () => {
    // A sketch with a huge `sampleSize`, driven to saturation. Every increment
    // after that point is a no-op on the data — `estimate` cannot move, since
    // the minimum across rows is already 15.
    //
    // **This test used to assert the opposite**, and the assertion it replaced
    // was the direct cause of a permanent cache freeze. It read
    // `expect(s.sample).toBe(sampleAtSaturation)` — the clock stops when the
    // table saturates — on the reasoning that a reset at that point would halve
    // the table "with no change to anything a reader could observe".
    //
    // That is exactly backwards. The reset is the *only* thing that changes
    // anything: halving is what lets a saturated counter fall below 15, and a
    // counter that never falls below 15 can never be beaten by a newcomer,
    // because the admission rule refuses on `estimate(incumbent) >=
    // estimate(challenger)` and 15 is the maximum. So a clock that stops at
    // saturation is a sketch that can never forget, and the measured
    // consequence was a 200-entry cache frozen on a retired working set for
    // 60 000 requests — `rejectedAdmission` 60 000, `evictions` 0, hit rate
    // falling from 99 % to 24.8 % with no recovery. See the `set()` refusal
    // branch in `cache/core.js` for the other half of that deadlock.
    //
    // The clock now counts operations, which is what a half-life *is*: time
    // passes whether or not the data moved.
    const s = new SmallLfuSketch({ sampleSize: 1e9, width: 64, depth: 4 });
    // 4000 distinct keys through 256 counters drives every counter to 15.
    for (let i = 0; i < 4000; i += 1) s.increment(`flood-${i}`);
    expect(s.estimate('flood-0')).toBe(15);
    expect(s.resets).toBe(0);

    const sampleAtSaturation = s.sample;

    // More increments of the same saturated keys. Nothing can move in the
    // estimates, but the clock must keep running.
    for (let i = 0; i < 1000; i += 1) s.increment('flood-0');

    expect(s.estimate('flood-0')).toBe(15);
    expect(s.sample).toBe(sampleAtSaturation + 1000);
    expect(s.resets).toBe(0);
  });

  it('un-saturates on reset, which is what lets a newcomer win', () => {
    // The behavioural point of the clock, stated at the sketch level: once the
    // table has been halved, a key that was pinned at 15 is no longer
    // unbeatable. Without this the previous test is a counter assertion with
    // no consequence attached.
    //
    // The shape is the one that matters: `old` is *retired* — it stops being
    // requested — while `new` keeps being requested. Halving is the only thing
    // that moves a counter off the 4-bit maximum, and it moves the retired key
    // down every time while the active one climbs straight back. A key merely
    // *tied* at 15 is not the interesting case, because the admission rule
    // refuses on a tie; what has to be possible is the retired key falling
    // below the active one.
    const s = new SmallLfuSketch({ sampleSize: 200, width: 64, depth: 4 });
    // Saturate `old`. 40 increments against a sampleSize of 200, so no reset
    // fires and it stays pinned at the maximum.
    for (let i = 0; i < 40; i += 1) s.increment('old');
    expect(s.estimate('old')).toBe(15);

    for (let i = 0; i < 4; i += 1) s.increment('new');
    expect(s.estimate('new')).toBeLessThan(s.estimate('old'));

    // `old` is never touched again. `new` keeps being requested, which is what
    // drives the clock and therefore the resets.
    for (let i = 0; i < 1000; i += 1) s.increment('new');

    expect(s.resets).toBeGreaterThan(0);
    expect(s.estimate('old')).toBeLessThan(15);
    expect(s.estimate('new')).toBeGreaterThan(s.estimate('old'));
  });

  it('still resets on schedule while increments remain effective', () => {
    // The counterpart, and the reason the first test is not a loosening. A
    // sketch that never reset would satisfy "the clock stopped" perfectly.
    const s = new SmallLfuSketch({ sampleSize: 4, width: 64, depth: 4 });
    for (let i = 0; i < 20; i += 1) s.increment(`key-${i}`);
    expect(s.resets).toBeGreaterThan(0);
  });

  it('a reset halves the counters, so saturation is not permanent', () => {
    // Closes the loop: if saturation were terminal, the effective-increment
    // rule would freeze the sketch forever. It cannot, because the half-life
    // drops every counter below 15 and counting resumes.
    const s = new SmallLfuSketch({ sampleSize: 1e9, width: 64, depth: 4 });
    for (let i = 0; i < 4000; i += 1) s.increment(`flood-${i}`);
    expect(s.estimate('flood-0')).toBe(15);
    const frozen = s.sample;

    // Saturation stops the clock; it does not freeze the sketch. `reset()` is
    // the same half-life the clock would have triggered, halved through the
    // public method rather than by reaching a `sampleSize` of 1e9.
    s.reset();

    expect(s.estimate('flood-0')).toBeLessThan(15);
    // And counting resumed, because the counters are below 15 again.
    s.increment('flood-0');
    expect(s.sample).not.toBe(frozen);
  });
});
