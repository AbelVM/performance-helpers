/**
 * OBS-007: the three numbers that made a stall invisible.
 *
 * Before this row, `stats()` described only ticks that **fired**. `max` and
 * `blockedOver10ms` are both derived from recorded samples, so a period during
 * which the monitor was not sampling — stopped, never started, or suspended past
 * the timer entirely — left no trace in any field. A 30 s stall and one late tick
 * were the same observation, because the only record of a stall is the tick that
 * eventually landed late.
 *
 * Three additive counters, none of which changes an existing field:
 *
 * - **`blockedMs`** — the same population as `blockedOver10ms`, in milliseconds.
 *   A 30 s stall and a 12 ms hiccup are both `blockedOver10ms: 1`; only one of
 *   them is `blockedMs: 30000`. Counting is right for alert *rate* and the wrong
 *   shape for *severity*, which is the question being asked when a loop is in
 *   trouble.
 * - **`droppedSamples`** — readings refused because the clock moved backwards. They
 *   were already dropped, because a negative sample poisons the histogram, but a
 *   dropped sample is still an event and an event with no counter is
 *   indistinguishable from an event that did not happen.
 * - **`coverage`** — what fraction of wall-clock time since construction the
 *   sampling schedule accounts for. **A lifetime figure that trends down**; the
 *   test below pins that behaviour deliberately, because the tempting reading
 *   ("low coverage means a sick loop") is the wrong one.
 *
 * `_record` is driven directly throughout. Timing a real stall means a real stall,
 * and this repository measures a 28 % median min/max spread on its timing harness —
 * a duration assertion here would be decoration.
 */
import { describe, it, expect } from 'vitest';
import { PowerEventLoopMonitor } from '../src/index.js';

describe('OBS-007: blockedMs, droppedSamples and coverage', () => {
  it('sums the milliseconds of the ticks it also counted', () => {
    // The pair is the point: same population, one counted and one weighed.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m._record(5);
    m._record(50);
    m._record(12);
    m._record(30000);

    const s = m.stats();
    expect(s.blockedOver10ms, 'three ticks over 10ms').toBe(3);
    expect(s.blockedMs, 'and their total').toBe(50 + 12 + 30000);
    expect(s.eventLoopPressure).toBeCloseTo(0.75);
    // The control: a tick *under* the threshold contributes to neither. If
    // `blockedMs` summed all drift this would be 5 higher, which is the mutant
    // that most looks right.
    expect(s.blockedMs).not.toBe(50 + 12 + 30000 + 5);
  });

  it('distinguishes a 30 s stall from a 12 ms hiccup, which blockedOver10ms cannot', () => {
    const stall = new PowerEventLoopMonitor({ intervalMs: 10 });
    stall._record(30000);
    const hiccup = new PowerEventLoopMonitor({ intervalMs: 10 });
    hiccup._record(12);

    // The reason this row exists: identical on the old shape.
    expect(stall.stats().blockedOver10ms).toBe(hiccup.stats().blockedOver10ms);
    // And distinguishable on the new one.
    expect(stall.stats().blockedMs).toBe(30000);
    expect(hiccup.stats().blockedMs).toBe(12);
  });

  it('counts a reading refused because the clock moved backwards', () => {
    // `NaN` is the second case that `!(drift >= 0)` refuses: a provider that
    // returns `NaN` is refused by the same guard, and it must be counted the same
    // way or the counter is measuring only half of what it drops.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m._record(-1);
    m._record(Number.NaN);
    m._record(5);

    const s = m.stats();
    expect(s.droppedSamples).toBe(2);
    // And neither was recorded: the histogram is not poisoned.
    expect(s.samples).toBe(1);
    expect(s.max).toBe(5);
    expect(s.last).toBe(5);
  });

  it('reports coverage as null before the first sample, not 0', () => {
    // Same rule `mean` follows: "not measured yet" and "measured, accounted for
    // nothing" are different facts and 0 conflates them.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    expect(m.stats().coverage).toBe(null);
    m._record(1);
    expect(typeof m.stats().coverage).toBe('number');
  });

  it('coverage is a lifetime figure that trends down, and is not a health signal', () => {
    // **The deliberate counter-reading.** A monitor whose ticks all land on time
    // still covers a shrinking share of a growing wall clock, so a low number here
    // says "my sampling resolution is coarse for how long I have been running",
    // not "my loop is sick". Pinning it stops a future reader from turning it into
    // an alert.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m._record(0);
    m._record(0);
    const until = Date.now() + 30;
    while (Date.now() < until) {
      /* burn wall clock */
    }
    const early = m.stats().coverage;
    const until2 = Date.now() + 60;
    while (Date.now() < until2) {
      /* burn more */
    }
    const later = m.stats().coverage;
    expect(early).not.toBe(null);
    expect(later).not.toBe(null);
    // **The clock has to actually move.** My first version of this test drove
    // `_record` in a tight loop and asserted coverage fell; it read 0 then 1
    // instead, because `accounted` grows by one `intervalMs` per sample while
    // `elapsed` barely moved — so more samples made the ratio *rise*. The ratio is
    // against the wall clock, not against the sample count.
    expect(later).toBeLessThan(early);
    // Not a health signal: these are all perfectly on-time ticks.
    expect(m.stats().blockedOver10ms).toBe(0);
    expect(m.stats().max).toBe(0);
  });

  it('coverage drops when time passes with no sample recorded', () => {
    // **The one case every pre-existing field gets wrong.** A tick that never
    // fires records no drift, so `max`, `blockedOver10ms` and `samples` cannot see
    // it. Coverage is the only number here that moves.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    // **Two samples, not one.** `accounted` is `(samples - 1) * intervalMs + drift`,
    // so a single sample accounts for *nothing* and coverage is pinned at 0 forever —
    // the ratio is only meaningful once a span exists to account for. My first
    // version recorded one and asserted a fall that could not happen.
    m._record(0);
    m._record(0);
    const before = m.stats().coverage;
    expect(before).toBeGreaterThan(0);
    // Burn wall clock without sampling, the way a suspension or a stop would.
    const until = Date.now() + 40;
    while (Date.now() < until) {
      /* block */
    }
    const after = m.stats().coverage;
    expect(after).toBeLessThan(before);
    // And the old shape is blind to exactly this: the sample count and the maximum
    // are **identical** before and after 40 ms passed unobserved.
    expect(m.stats().samples, 'no sample was recorded during the gap').toBe(2);
    expect(m.stats().max, 'so max cannot report the gap').toBe(0);
    expect(m.stats().blockedOver10ms, 'nor can the blocked count').toBe(0);
    // Only coverage moved.
    expect(m.stats().coverage).toBeLessThan(1);
  });

  it('coverage never exceeds 1, even if the clock jumps backwards', () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m._record(500);
    // A backwards clock makes `elapsed` negative; without a clamp this reports a
    // ratio above 1, i.e. more accounted-for time than exists.
    const s = m.stats();
    expect(s.coverage).toBeLessThanOrEqual(1);
    expect(s.coverage).toBeGreaterThanOrEqual(0);
  });

  it('reset() clears all three and re-bases the coverage window', () => {
    // The re-base is the part that is easy to miss: without it, coverage would
    // divide a fresh sample count by the whole life of the monitor and report
    // near-zero for an interval that is perfectly covered.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m._record(50);
    m._record(-1);
    expect(m.stats().blockedMs).toBe(50);
    expect(m.stats().droppedSamples).toBe(1);

    m.reset();
    const s = m.stats();
    expect(s.blockedMs).toBe(0);
    expect(s.droppedSamples).toBe(0);
    expect(s.coverage, 'no samples after a reset').toBe(null);
    expect(s.samples).toBe(0);
    // `blockedOver10ms` already reset; this pins that the new field travels with it.
    expect(s.blockedOver10ms).toBe(0);

    // **The re-base, which the assertions above do not reach.** They only see
    // `coverage === null`, and that is null because the sample count is zero — so a
    // `reset()` that forgot to re-base would pass every one of them. This is the
    // case that separates the two: a long life *before* the reset, then two samples
    // after it. Without the re-base those two are divided by the whole lifetime, so
    // coverage reads near zero for an interval that is fully covered.
    const until = Date.now() + 40;
    while (Date.now() < until) {
      /* burn, so the pre-reset lifetime is long */
    }
    m.reset();
    m._record(0);
    m._record(0);
    const after = m.stats().coverage;
    expect(after, 'a fresh interval is measured against a fresh window').not.toBe(null);
    expect(after, 'not divided by the lifetime that preceded the reset').toBeGreaterThan(0.5);
  });

  it('leaves every pre-existing field exactly as it was', () => {
    // "Additive only" is the row's constraint, so it is the assertion. A monitor
    // fed a known sequence must produce byte-identical old-shape output.
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    for (const d of [3, 0, 42, 1, 11]) m._record(d);
    const s = m.stats();
    expect(s.samples).toBe(5);
    expect(s.max).toBe(42);
    // `last` is the most recent reading, not the largest and not the first.
    expect(s.last).toBe(11);
    expect(s.mean).toBe((3 + 0 + 42 + 1 + 11) / 5);
    expect(s.blockedOver10ms).toBe(2);
    expect(s.active).toBe(false);
    expect(s.intervalMs).toBe(10);
    // The quantiles still come from the histogram, which was not touched.
    expect(s.p50).not.toBe(null);
  });

  it('getStats() carries the new fields, since it delegates to stats()', () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m._record(30);
    expect(m.getStats().blockedMs).toBe(30);
    expect(m.getStats()).toEqual(m.stats());
  });
});
