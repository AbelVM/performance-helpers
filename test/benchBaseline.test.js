/**
 * The decision logic behind `bench/baseline.js` — TEST-006, option (c).
 *
 * `compare()` is a pure function, so every verdict it can reach is testable
 * without running a benchmark or waiting three minutes for one. The bench
 * harness itself is exercised by the mutation checks described at the bottom of
 * this file; what is pinned here is the part that decides what a set of numbers
 * *means*.
 *
 * The statuses exist because a timing gate has three honest answers, not two.
 * "No regression" and "this run cannot tell" are different claims, and a gate
 * that only has the first one is a gate that fails on a busy machine — which is
 * what the specified ±20 % design would have been, against a measured 28.71 %
 * median spread.
 */
import { describe, it, expect } from 'vitest';
import { compare, percentile, bandsOf, machineKey } from '../bench/baseline.js';

/** A harness report carrying the given per-site bands. */
const report = (bands) => ({ measurement: { bands } });
const band = (label, median, spreadPct) => ({ label, median, spreadPct, samples: 9 });
/**
 * A baseline document whose aggregate p95 is derived from its own bands.
 *
 * Hardcoding it produced a fixture that contradicted itself — bands at 80 %
 * spread beside a recorded p95 of 20 % — and the noise check then fired on it
 * for reasons that had nothing to do with the verdict under test.
 */
const baselineOf = (bands) => ({
  p95SpreadPct: percentile(
    bands.map((b) => b.spreadPct),
    95
  ),
  bands,
});

describe('percentile', () => {
  it('interpolates between neighbours', () => {
    expect(percentile([0, 10], 50)).toBe(5);
    expect(percentile([0, 10, 20, 30], 50)).toBe(15);
  });

  it('returns the single value for a one-element array', () => {
    expect(percentile([7], 95)).toBe(7);
  });

  it('returns 0 for an empty array rather than NaN', () => {
    // An empty run must not produce NaN, which would compare false against
    // everything and make an empty report look like a passing one.
    expect(percentile([], 95)).toBe(0);
  });
});

describe('bandsOf', () => {
  it('returns an empty list for a report with no measurement block', () => {
    expect(bandsOf({})).toEqual([]);
    expect(bandsOf(null)).toEqual([]);
  });
});

describe('compare: a clean run passes', () => {
  it('passes when every site is at its recorded median', () => {
    const bands = [band('a', 10, 20), band('b', 5, 30), band('c', 1, 10)];
    const verdict = compare(report(bands), baselineOf(bands));
    expect(verdict.status).toBe('pass');
    expect(verdict.checked).toBe(3);
  });

  it('passes when a site moved inside its own recorded spread', () => {
    // spreadPct 20 with a 1.5 tolerance gives a 10% threshold, so +8% is
    // inside it. This is the case the whole design exists for: a clean tree
    // moves, and a gate that cannot tolerate that fails on itself.
    const before = [band('a', 10, 20)];
    const verdict = compare(report([band('a', 10.8, 20)]), baselineOf(before));
    expect(verdict.status).toBe('pass');
  });
});

describe('compare: a regression fails', () => {
  it('fails when one site is past its recorded threshold', () => {
    // Six sites, so the machine-shift check has enough data to be meaningful and
    // is not silently skipped: five hold steady while one moves.
    const before = [
      band('a', 10, 20),
      band('b', 5, 20),
      band('c', 7, 20),
      band('d', 9, 20),
      band('e', 6, 20),
      band('f', 8, 20),
    ];
    const verdict = compare(report([band('a', 30, 20), ...before.slice(1)]), baselineOf(before));
    expect(verdict.status).toBe('fail');
    expect(verdict.reasons.join(' ')).toContain('a:');
    expect(verdict.reasons.join(' ')).toMatch(/\+\d+(\.\d+)?%/);
  });

  it('the threshold is the recorded spread, not a chosen constant', () => {
    // A wide band gets a wide threshold; a narrow one gets a narrow threshold.
    // This is the per-machine half of the design, and it is why a site
    // calibrated at 80% spread is not held to the same bar as one at 8%.
    // The identical +20% move, against a site calibrated at 80% spread and one
    // calibrated at 8%. A wide band gets a wide threshold, which is the
    // per-machine half of the design: a site that has always been noisy is not
    // held to the same bar as a precise one.
    const wide = compare(
      report([band('a', 12, 80), band('b', 8, 80), band('c', 3, 80)]),
      baselineOf([band('a', 10, 80), band('b', 8, 80), band('c', 3, 80)])
    );
    const narrow = compare(
      report([band('a', 12, 8), band('b', 8, 8), band('c', 3, 8)]),
      baselineOf([band('a', 10, 8), band('b', 8, 8), band('c', 3, 8)])
    );
    expect(wide.status).toBe('pass');
    expect(narrow.status).toBe('fail');
  });

  it('ignores sites the baseline has never seen', () => {
    const verdict = compare(report([band('new', 999, 5)]), baselineOf([band('a', 10, 20)]));
    expect(verdict.checked).toBe(0);
    expect(verdict.status).toBe('pass');
  });
});

describe('compare: an unjudgeable run is inconclusive, not a failure', () => {
  it('is inconclusive when the machine level shifted', () => {
    // Every site 50% slower is the machine, not the code. Failing here is the
    // coin flip: measured on a clean tree after a mutation check, six
    // unrelated helpers came back 44-48% slower than a baseline recorded
    // minutes earlier, and a gate that failed would have been wrong.
    // Six sites: below the minimum the shift check needs, the median of two or
    // three points is not a median and the check is skipped by design.
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 10, 10));
    const after = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 15, 10));
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.reasons.join(' ')).toContain('level moved');
  });

  it('is inconclusive when the harness got noisier than it was calibrated', () => {
    const before = [band('a', 10, 10), band('b', 10, 10)];
    const after = [band('a', 10, 10), band('b', 10, 60)];
    const verdict = compare(report(after), { p95SpreadPct: 10, bands: before });
    expect(verdict.status).toBe('inconclusive');
  });

  it('a single genuine regression is not hidden by the shift check', () => {
    // The shift signal is the *median* delta, so one site moving while the
    // median holds still is still a failure. If this ever becomes a pass, the
    // median has swallowed the regression the gate exists to catch.
    const before = [band('a', 10, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const after = [band('a', 40, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.status).toBe('fail');
  });

  it('reports how much of the run moved, so one regression is distinguishable from a busy machine', () => {
    const before = [band('a', 10, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const after = [band('a', 40, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.reasons.join(' ')).toContain('1 of 4');
  });
});

describe('machineKey', () => {
  it('is stable within a process', () => {
    expect(machineKey()).toBe(machineKey());
  });

  it('is a short opaque hash, not a hostname', () => {
    // The baseline files are gitignored but still end up in CI artifacts, and
    // a raw hostname in one is a small leak for no benefit.
    const key = machineKey();
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});
