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

describe('compare: the machine noise floor', () => {
  // A baseline whose aggregate p95 is derived from its bands *and* which records
  // the median spread, since the floor reads it. Deriving only the p95 left the
  // median at undefined and the floor inert.
  const floored = (bands, medianSpreadPct) => ({
    ...baselineOf(bands),
    medianSpreadPct,
  });

  it('does not guard a site more tightly than the machine it was measured on', () => {
    // The site recorded 14.4 while the machine's median was 17.63, so its own
    // spread sets a 7.2% threshold - finer than this box can repeat itself. A
    // +8% move is ordinary drift here and must not fail.
    const before = [band('tight', 100, 14.4)];
    const verdict = compare(report([band('tight', 108, 14.4)]), floored(before, 17.63));
    expect(verdict.status).toBe('pass');
  });

  it('still fails that site on a move past the floor', () => {
    // The floor must not become a blanket amnesty: the threshold is the floor
    // (17.63 * 0.5 = 8.8), so +20% is well past it.
    const before = [band('tight', 100, 14.4)];
    const verdict = compare(report([band('tight', 120, 14.4)]), floored(before, 17.63));
    expect(verdict.status).toBe('fail');
  });

  it('leaves a site that is already noisier than the machine alone', () => {
    // 30.4 exceeds the 17.63 floor, so its own spread still governs: the
    // threshold stays at 30.4 * 0.5 = 15.2%, and the floor changed nothing.
    const before = [band('wide', 100, 30.4)];
    expect(compare(report([band('wide', 114, 30.4)]), floored(before, 17.63)).status).toBe('pass');
    expect(compare(report([band('wide', 117, 30.4)]), floored(before, 17.63)).status).toBe('fail');
  });

  it('an older baseline without a median spread keeps the old thresholds', () => {
    // Baselines recorded before the floor existed have no `medianSpreadPct`.
    // Reading it as 0 makes `Math.max` a no-op, so those files still judge by
    // their own bands rather than silently re-basing on a missing field.
    const before = [band('tight', 100, 14.4)];
    const verdict = compare(report([band('tight', 108, 14.4)]), baselineOf(before));
    expect(verdict.status).toBe('fail');
  });
});

describe('compare: a site too noisy to judge is reported, not dropped (GATE-012)', () => {
  // The defect this pins: a site whose band widened past `spreadTolerance` was
  // `continue`d, so it vanished from the output with nothing said about it. **The
  // class of regression this gate is least able to see is the one that hid** — an
  // added allocation or a growing Map does not make a site reliably slower, it
  // makes its band wider first, and a wider band meant the site stopped being
  // compared at all.
  const widening = (beforeSpread, afterSpread) => ({
    before: [band('calm', 10, beforeSpread), band('noisy', 10, beforeSpread)],
    after: [band('calm', 10, beforeSpread), band('noisy', 10, afterSpread)],
  });

  it('names the site it could not judge, with both spreads', () => {
    const { before, after } = widening(10, 30);
    const verdict = compare(report(after), baselineOf(before));
    const line = verdict.reasons.find((r) => r.startsWith('noisy:'));
    expect(line).toBeDefined();
    // Both numbers, because "it got noisier" is not actionable on its own - a
    // reader needs to see how far past the calibration it went.
    expect(line).toContain('10.0%');
    expect(line).toContain('30.0%');
    expect(line).toContain('NOT compared');
  });

  it('still excludes that site from the verdict rather than judging it', () => {
    // Reporting is not judging. A band too wide to support a verdict still cannot
    // support one, so a noisy site that is also much slower must not be reported
    // as a regression - otherwise the fix would reintroduce the coin flip this
    // gate exists to avoid, just in the other direction.
    //
    // The verdict here is `inconclusive`, and for a second reason worth pinning:
    // one site tripling its spread pushes the run's p95 to 25% against a recorded
    // 10%, which is the harness-wide noise check firing. Both are correct, and
    // neither is a regression - which is the claim.
    const before = ['calm', 'b', 'c', 'd', 'e'].map((l) => band(l, 10, 10));
    const after = [...before.map((b) => ({ ...b })), band('noisy', 40, 30)];
    const verdict = compare(report(after), baselineOf([...before, band('noisy', 10, 10)]));

    expect(verdict.status).toBe('inconclusive');
    // Named, with the reason it was set aside.
    expect(verdict.reasons.join(' ')).toContain('noisy: spread 10.0% -> 30.0%');
    // And *not* judged: no regression line for it, so it is not in the count
    // either. `checked` includes it, because it was compared - the outcome was
    // "unjudgeable", which is not the same as "not looked at".
    expect(verdict.reasons.join(' ')).not.toMatch(/noisy: [\d.]+ ms/);
    expect(verdict.reasons.join(' ')).not.toContain('sites past their threshold');
    expect(verdict.checked).toBe(6);
  });

  it('reports both a noisy site and a real regression in one run', () => {
    // The two lists are independent, and a change that makes one helper noisier
    // often makes another slower. If reporting the noisy sites had replaced the
    // regression path rather than joined it, this is the case that would break.
    const before = [band('calm', 10, 10), band('slow', 10, 10), band('noisy', 10, 10)];
    const after = [band('calm', 10, 10), band('slow', 40, 10), band('noisy', 10, 30)];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.status).toBe('fail');
    expect(verdict.reasons.join(' ')).toContain('slow:');
    expect(verdict.reasons.join(' ')).toContain('noisy:');
  });

  it('a clean run says nothing about noise it did not find', () => {
    // The other direction: reporting must not manufacture a line. A gate that
    // always prints a noise section trains its readers to skip it.
    const bands = [band('a', 10, 20), band('b', 5, 30)];
    const verdict = compare(report(bands), baselineOf(bands));
    expect(verdict.reasons).toEqual([]);
  });
});

describe('compare: a machine shift cannot delete a failure (GATE-012)', () => {
  // The second half of the row. The status used to be assigned in two
  // unconditional steps, `fail` then `inconclusive`, so the second overwrote the
  // first: a run with sites past their thresholds *and* a machine shift reported
  // `inconclusive`, which the CLI prints as "Not a failure" and exits 0 on.

  it('keeps `fail` when a site moved further than the machine did', () => {
    // The row's scenario. Five sites ride the machine up +40%, one goes to +300%.
    // The shift is real and it is not the explanation: 300% is not 40%, and no
    // amount of thermal drift is.
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 10, 10));
    const after = [
      band('a', 14, 10),
      band('b', 14, 10),
      band('c', 14, 10),
      band('d', 14, 10),
      band('e', 14, 10),
      band('f', 40, 10),
    ];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.status).toBe('fail');
    expect(verdict.reasons.join(' ')).toContain('f:');
  });

  it('attributes the sites the shift does explain, and says how many', () => {
    // Same run, and the report has to be honest about both halves: `f` is a
    // regression, the other five are the machine, and the reader can see that
    // rather than having to recompute it.
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 10, 10));
    const after = [
      band('a', 14, 10),
      band('b', 14, 10),
      band('c', 14, 10),
      band('d', 14, 10),
      band('e', 14, 10),
      band('f', 40, 10),
    ];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.reasons.join(' ')).toContain('5 of 6 site(s)');
    expect(verdict.reasons.join(' ')).toContain('attributed to the machine');
  });

  it('still calls a uniform shift inconclusive, because every site is explained', () => {
    // **The row's literal wording - "keep `fail` when per-site regressions
    // coexist with a machine shift" - was implemented and rejected.** Six sites at
    // +50% are all past their 5% thresholds, so a blanket "fail wins" reads that
    // as six regressions. The measurement behind
    // `is inconclusive when the machine level shifted` is exactly this shape: a
    // clean tree once reported six unrelated helpers 44-48% slower than a baseline
    // recorded minutes earlier. A gate that fails there is a permanently red gate.
    //
    // So the shift filters the regression list rather than replacing the verdict,
    // and this test is what holds the filter honest in the other direction.
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 10, 10));
    const after = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 15, 10));
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.reasons.join(' ')).toContain('6 of 6 site(s)');
  });

  it('counts the moved-share headline over what is reported, not over what tripped', () => {
    // Otherwise the headline describes a different set of sites than the lines
    // under it: "6 of 6 past their threshold" above a single reported site is a
    // contradiction, and it is the contradiction a reader is most likely to trust.
    const before = ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => band(l, 10, 10));
    const after = [
      band('a', 14, 10),
      band('b', 14, 10),
      band('c', 14, 10),
      band('d', 14, 10),
      band('e', 14, 10),
      band('f', 40, 10),
    ];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.reasons.join(' ')).toContain('1 of 6 sites past their threshold and beyond');
  });

  it('a noisy site does not hide a real regression elsewhere in the run', () => {
    // The interaction the two lists share a loop for: a change that makes one
    // helper noisier often makes another slower, and the widening must not
    // swallow the site that can still be judged.
    const before = ['a', 'b', 'c', 'd', 'e'].map((l) => band(l, 10, 10));
    const after = [
      band('a', 14, 10),
      band('b', 14, 10),
      band('c', 14, 10),
      band('d', 14, 10),
      band('e', 40, 30),
    ];
    const verdict = compare(report(after), baselineOf([...before, band('e', 10, 10)]));
    expect(verdict.reasons.join(' ')).toContain('e: spread');
    // `e` is unjudgeable, so nothing here is beyond the +40% the other four show -
    // the machine explains the whole run.
    expect(verdict.status).toBe('inconclusive');
    expect(verdict.reasons.join(' ')).toContain('level moved');
  });
});

describe('compare: the report is assembled in a readable order', () => {
  it('puts the summary above the lines it summarises', () => {
    // The sort used to run over the whole `reasons` array, so the summary line -
    // which carries no `+%` of its own - scored 0 and sorted *last*, below the
    // sites it was describing. An ordering nobody reads is an ordering nobody
    // should have to fix twice.
    const before = [band('a', 10, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const after = [band('a', 40, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const verdict = compare(report(after), baselineOf(before));
    expect(verdict.reasons[0]).toContain('1 of 4 sites');
  });

  it('ranks the site that moved furthest to the top', () => {
    // A deliberate regression drags the rest of the run with it - it allocates
    // more, and the harness measures helpers in sequence with no heap reset - so
    // one mutation reports several sites. Ordering by delta is what makes the
    // headline the real one.
    const before = [band('a', 10, 10), band('b', 10, 10), band('c', 10, 10), band('d', 10, 10)];
    const after = [band('a', 14, 10), band('b', 16, 10), band('c', 40, 10), band('d', 10, 10)];
    const verdict = compare(report(after), baselineOf(before));
    const siteLines = verdict.reasons.filter((r) => /^\w+:/.test(r));
    expect(siteLines[0]).toMatch(/^c:/);
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
