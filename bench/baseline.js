#!/usr/bin/env node
/**
 * A per-machine performance-regression gate — TEST-006, option (c).
 *
 * ## Why this is not a ±20 % wall-clock gate
 *
 * The obvious version of this item was "assert `PowerCache.get` and
 * `PowerThrottle.tryConsume` are within ±20 % of a committed baseline". It was
 * not built because it cannot work: BENCH-001 measured a **28.71 % median
 * min/max spread** across 22 timed variants (p95 113 %) on this machine. A gate
 * at ±20 % would fail on a clean tree about as often as it would pass, and the
 * fastest way to get a flaky gate muted is to ship one.
 *
 * The threshold is therefore not chosen. It is **derived from a measured p95**,
 * per machine, and recorded rather than committed — because a committed absolute
 * baseline is wrong for every machine that is not the one that recorded it.
 *
 * ## What it actually checks
 *
 * Three conditions, in order, and the first two are about whether the
 * measurement means anything at all:
 *
 * 1. **Is the machine calm enough today?** A site's current spread must not
 *    exceed the spread recorded for it. A busy CI runner produces a wide band
 *    in which any comparison is meaningless, so the run reports *inconclusive*
 *    rather than failing. This is the condition that stops the gate being a
 *    coin flip, and it is the one a hand-rolled ±20 % gate cannot express.
 * 2. **Did a site get slower than the recorded threshold?** The threshold for a
 *    site is its *recorded* p95 spread, so a clean tree passes by construction
 *    and a regression has to be larger than the noise to be reported.
 * 3. **Did the whole run's noise floor move?** A harness that suddenly reports
 *    a 200 % spread is itself a regression — someone made a measurement much
 *    less repeatable — and that is visible even when no individual site failed.
 *
 * ## Usage
 *
 * ```sh
 * node bench/baseline.js record   # measure this machine, write its baseline
 * node bench/baseline.js check    # measure and compare; exit 1 on a regression
 * node bench/baseline.js show     # print the recorded baseline
 * ```
 *
 * Baselines live in `bench/baselines/<machine-key>.json` and are **gitignored**:
 * a committed baseline is a claim about every other machine's hardware, which is
 * exactly the mistake this design exists to avoid. CI reuses an artifact if one
 * is present, and says so plainly when it is not, rather than failing a run it
 * cannot judge.
 *
 * @module bench/baseline
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = here;
const baselineDir = resolve(benchDir, 'baselines');

/**
 * Where `bench/run.js` writes its JSON report.
 *
 * Relative to the **current working directory**, not to `bench/` — the harness
 * writes `results.json` and `bench/results.md` as relative paths and assumes it
 * was invoked from the repository root. Reading from `bench/` instead would
 * find nothing and report "the harness did not write its report", which is a
 * confusing way to learn about a working-directory assumption.
 *
 * @returns {string}
 */
const resultsPath = () => resolve(process.cwd(), 'results.json');

/**
 * A stable-ish identifier for the machine a baseline belongs to.
 *
 * Deliberately not the hostname alone: a developer machine is often the same
 * host across a RAM upgrade or a Node version change, and a baseline recorded
 * under the old conditions is not comparable to the new ones. CPU model, core
 * count, OS, architecture and the Node major version all change what a
 * microbenchmark resolves, so all of them go in.
 *
 * Hashed because the raw string contains a hostname, which is not something to
 * commit even to a gitignored file that will end up in a CI artifact.
 *
 * @returns {string}
 */
export function machineKey() {
  const cpus = os.cpus();
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    String(cpus.length),
    cpus[0]?.model ?? 'unknown',
    process.version,
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** @returns {string} */
export function baselinePath() {
  return resolve(baselineDir, `${machineKey()}.json`);
}

/**
 * Run the benchmark harness and return its parsed report.
 *
 * The harness is run in a child process rather than imported so the gate cannot
 * be affected by — or accidentally affect — the harness's module-level state,
 * which includes the very measurement bands being read.
 *
 * @returns {object} The parsed `results.json`.
 */
export function measure(mode = 'helpers') {
  // The `helpers` mode only, deliberately. The full harness exercises 22 timed
  // variants plus the pool scenarios and takes the better part of an hour —
  // long enough that nobody runs a gate on a change they are about to land.
  // The helper micro-benchmarks are also the sites a constant-factor regression
  // in one helper shows up in, which is the case this gate exists for; the
  // pool scenarios are dominated by worker start-up and message transport, and
  // their spread is far wider, so gating on them buys noise rather than signal.
  // Override with BENCH_GATE_MODE for the full harness when a change is big
  // enough to want the slower run.
  const runMode = process.env.BENCH_GATE_MODE || mode;
  execFileSync(process.execPath, ['--expose-gc', resolve(benchDir, 'run.js'), runMode], {
    stdio: 'inherit',
    env: process.env,
  });
  const out = resultsPath();
  if (!existsSync(out)) {
    throw new Error(
      `bench/run.js did not write ${out}. Run the gate from the repository root: ` +
        'the harness writes its report relative to the current working directory.'
    );
  }
  return JSON.parse(readFileSync(out, 'utf8'));
}

/**
 * Pull the per-site bands out of a harness report.
 *
 * @param {object} report
 * @returns {Array<{label: string, median: number, min: number, max: number, spreadPct: number, samples: number}>}
 */
export function bandsOf(report) {
  return report?.measurement?.bands ?? [];
}

/**
 * The p-th percentile of a numeric array, linearly interpolated.
 *
 * @param {number[]} values
 * @param {number} p - 0–100.
 * @returns {number}
 */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Compare a run against a baseline and decide what it means.
 *
 * Kept pure and exported so the decision can be unit-tested against
 * synthetic reports. Every threshold that matters is a parameter with a
 * documented default rather than a literal buried in a branch.
 *
 * @param {object} report - Current harness report.
 * @param {object} baseline - Recorded baseline for this machine.
 * @param {Object} [options]
 * @param {number} [options.spreadTolerance=1.25] - How much *wider* than its
 *   recorded spread a site may be today before the run is called inconclusive.
 *   Below 1 would be a gate that fails when a machine is *calmer* than when it
 *   was calibrated, which is not a regression.
 * @param {number} [options.slowdownTolerance=1.5] - Multiplier on a site's
 *   recorded p95 spread, above which the site is reported as a regression.
 * @param {number} [options.noiseTolerance=2] - Multiplier on the recorded
 *   overall p95 spread, above which the harness itself is reported as having
 *   become less repeatable.
 * @param {number} [options.minSitesForShift=5] - How many compared sites are
 *   needed before the machine-shift check can fire. Below this a median is not
 *   a median, and a single regression among a few sites would be misread as the
 *   machine changing speed and downgraded to inconclusive.
 * @param {number} [options.shiftTolerance=0.1] - How far the machine's overall
 *   level may drift, as a fraction, before the run is called inconclusive
 *   rather than failed. The signal is the *median* relative delta across every
 *   compared site, so one genuine regression cannot hide inside it.
 * @returns {{status: 'pass'|'inconclusive'|'fail', reasons: string[], checked: number}}
 */
export function compare(report, baseline, options = {}) {
  const {
    spreadTolerance = 1.25,
    slowdownTolerance = 1.5,
    noiseTolerance = 2,
    shiftTolerance = 0.1,
    minSitesForShift = 5,
  } = options;
  const reasons = [];
  const current = bandsOf(report);
  const recorded = new Map((baseline?.bands ?? []).map((b) => [b.label, b]));

  // Condition 3 first: if the whole run is noisier than the baseline recorded,
  // per-site comparisons are not worth reporting at all, and saying so is more
  // useful than a list of sites that all moved together.
  const currentP95 = percentile(
    current.map((b) => b.spreadPct),
    95
  );
  const baselineP95 = Number(baseline?.p95SpreadPct ?? 0);
  const noiseWorse = baselineP95 > 0 && currentP95 > baselineP95 * noiseTolerance;

  let checked = 0;
  const regressions = [];
  for (const band of current) {
    const before = recorded.get(band.label);
    if (!before) continue;
    checked += 1;
    // Condition 1: a site whose own band widened past what it was calibrated
    // at is telling us about the machine, not about the code.
    if (before.spreadPct > 0 && band.spreadPct > before.spreadPct * spreadTolerance) {
      continue;
    }
    // Condition 2: the threshold is the site's *recorded* p95 spread, so a
    // clean tree passes by construction.
    //
    // `spreadPct` is already a percentage (60 means 60%), so the threshold is
    // that number scaled, not a fraction converted to one. An earlier version
    // wrote `spreadPct * (slowdownTolerance - 1) * 100`, which turned a 60%
    // band into a 3000% threshold and made the gate incapable of failing: it
    // passed a deliberate 64% regression in `PowerCache.get` and reported
    // `PASS`. The mutation check below is the only reason that was caught, and
    // it is the reason a gate is mutation-checked before it is trusted.
    const thresholdPct = before.spreadPct * (slowdownTolerance - 1);
    if (before.median > 0 && band.median > before.median * (1 + thresholdPct / 100)) {
      regressions.push({
        label: band.label,
        before: before.median,
        after: band.median,
        deltaPct: ((band.median / before.median - 1) * 100).toFixed(1),
        thresholdPct: thresholdPct.toFixed(1),
      });
    }
  }

  for (const r of regressions) {
    reasons.push(
      `${r.label}: ${r.before.toFixed(3)} ms -> ${r.after.toFixed(3)} ms ` +
        `(+${r.deltaPct}%, threshold +${r.thresholdPct}%)`
    );
  }
  // Rank by how far past its own threshold the site moved, so the headline is
  // the thing that actually changed rather than whichever label sorted first.
  // A deliberate regression in `PowerCache.get` also drags the rest of the run
  // with it — it allocates more, and the harness measures helpers in sequence
  // without a heap reset between them — so the same mutation reports five or six
  // sites. Ordering by delta puts the real one at the top.
  reasons.sort((a, b) => {
    const d = (s) => {
      const m = /\+([\d.]+)%/.exec(s.split(', threshold')[1] ?? s);
      return m ? Number(m[1]) : 0;
    };
    return d(b) - d(a);
  });

  if (regressions.length) {
    // Say how much of the run moved. "One of 25 sites" is a regression; "19 of
    // 25" is a machine that was busy, and the per-site deltas in that case are
    // measuring the same thing twenty-five times. Reporting the count is the
    // difference between a gate a reader trusts and one they learn to ignore.
    const movedShare = Math.round((regressions.length / Math.max(1, checked)) * 100);
    reasons.unshift(
      `${regressions.length} of ${checked} sites past their threshold (${movedShare}%). ` +
        (movedShare >= 60
          ? 'That is most of the run, so the machine was probably slower rather than the ' +
            'code: re-run on a calmer machine before believing any single line above.'
          : 'A minority of sites, so this looks like a change in the code rather than the machine.')
    );
  }

  // Condition 4, and the one that makes the gate usable at all: has the
  // *machine's level* moved?
  //
  // Comparing one run against one recorded baseline assumes the machine is
  // doing the same amount of work per nanosecond as when it was calibrated.
  // It is not — thermal state, a neighbour on the host, a container CPU quota
  // and the phases of the run itself all move that level, and a site that was
  // 8% slow is 50% slow once the level has moved far enough.
  //
  // Measured here: a clean tree, restored from a mutation check, reported six
  // unrelated helpers between 44% and 48% slower than a baseline recorded a few
  // minutes earlier. Nothing had changed. A gate that failed on that would be
  // the coin flip TEST-006 was written to avoid, and the fix for a flaky gate
  // nobody has is to not fail.
  //
  // The signal is the *median* relative delta across every compared site. One
  // site moving while the rest hold still is a code change. Everything moving
  // together is the machine. Median rather than mean, so a single genuine
  // regression cannot drag the figure and hide itself.
  const deltas = [];
  for (const band of current) {
    const before = recorded.get(band.label);
    if (before && before.median > 0) deltas.push(band.median / before.median - 1);
  }
  // A median over two points is the mean of two points, and the mean of
  // [3x, 1x] is 2x — so a single regression among a handful of sites reads
  // as a machine that doubled in speed, and a real failure is downgraded to
  // 'inconclusive'. The check needs enough sites for the median to mean
  // something; the harness records 25.
  const medianDelta = percentile(deltas, 50) * 100;
  const shifted = deltas.length >= minSitesForShift && Math.abs(medianDelta) > shiftTolerance * 100;
  if (shifted) {
    reasons.unshift(
      `the machine's level moved ${medianDelta > 0 ? '+' : ''}${medianDelta.toFixed(1)}% ` +
        `against the baseline (median across ${deltas.length} sites, tolerance ` +
        `${(shiftTolerance * 100).toFixed(0)}%). Nothing below can be attributed to the code. ` +
        'Re-run on a calmer machine, or re-record the baseline if this one has genuinely changed.'
    );
  }

  if (noiseWorse) {
    reasons.unshift(
      `run noise p95 ${currentP95.toFixed(2)}% exceeds the recorded ${baselineP95.toFixed(2)}% ` +
        `by more than ${noiseTolerance}x; the harness itself is less repeatable than when it was calibrated`
    );
  }

  // A shifted or noisy machine means this run cannot distinguish a regression
  // from the hardware, so the honest verdict is "no verdict" — and "no verdict"
  // is never a failure. A gate that fails because the machine was busy is the
  // coin flip this whole design exists to avoid, and the first version of it
  // failed exactly that way on a clean tree.
  let status = 'pass';
  if (regressions.length) status = 'fail';
  if (shifted || noiseWorse) status = 'inconclusive';
  return { status, reasons, checked };
}

/**
 * Build a baseline document from a harness report.
 *
 * @param {object} report
 * @returns {object}
 */
export function buildBaseline(report) {
  const bands = bandsOf(report);
  const spreads = bands.map((b) => b.spreadPct);
  return {
    machine: machineKey(),
    recordedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    cpus: os.cpus().length,
    // The headline the gate is built on, and the number a reader should look at
    // before trusting any delta the harness reports.
    p95SpreadPct: Number(percentile(spreads, 95).toFixed(2)),
    medianSpreadPct: Number(percentile(spreads, 50).toFixed(2)),
    sites: bands.length,
    bands,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'check';

function save(document) {
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(baselinePath(), JSON.stringify(document, null, 2), 'utf8');
  return baselinePath();
}

function load() {
  const p = baselinePath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function main() {
  if (mode === 'show') {
    const baseline = load();
    if (!baseline) {
      console.error(
        `No baseline recorded for this machine (${machineKey()}).\n` +
          'Run: node bench/baseline.js record'
      );
      process.exit(1);
    }
    console.log(
      `machine ${baseline.machine} | ${baseline.platform} | ${baseline.cpus} cpus | node ${baseline.node}\n` +
        `recorded ${baseline.recordedAt}\n` +
        `sites ${baseline.sites} | median spread ${baseline.medianSpreadPct}% | p95 spread ${baseline.p95SpreadPct}%\n`
    );
    return;
  }

  console.log(`Measuring this machine (${machineKey()})…\n`);
  const report = measure();

  if (mode === 'record') {
    const document = buildBaseline(report);
    const written = save(document);
    console.log(
      `Recorded ${document.sites} sites to ${written}\n` +
        `  median spread ${document.medianSpreadPct}%  p95 spread ${document.p95SpreadPct}%\n` +
        '  gate threshold per site = its own recorded spread, so a clean tree passes by construction.'
    );
    return;
  }

  if (mode !== 'check') {
    console.error(`Unknown mode: ${mode}. Use "record", "check" or "show".`);
    process.exit(1);
  }

  const baseline = load();
  if (!baseline) {
    console.error(
      'No baseline for this machine, so there is nothing to compare against.\n' +
        "A committed absolute baseline would be a claim about every other machine's\n" +
        'hardware, which is why baselines are per-machine and gitignored.\n' +
        'CI: upload bench/baselines/ as an artifact, or run\n' +
        '  node bench/baseline.js record\n' +
        'first and cache the result.'
    );
    // Not a failure. An absent baseline is a missing measurement, not a
    // regression, and exiting 1 would put a red X on a run that told the truth.
    process.exit(0);
  }

  let verdict = compare(report, baseline);
  console.log(
    `compared ${verdict.checked} sites against baseline ${baseline.machine} ` +
      `(recorded ${baseline.recordedAt})`
  );

  // A failure has to be *reproduced* before it is reported as one.
  //
  // Nine samples, symmetrically trimmed one from each end, still admits a
  // single GC pause landing on one measurement: measured on a clean tree, one
  // site out of 25 came back +48.9% against a 7.8% threshold while the other 24
  // held steady. That is a blip, not a regression, and a gate that fails on it
  // is the coin flip TEST-006 exists to prevent.
  //
  // So a first failure re-measures, and only a site that is still past its
  // threshold on the second run is reported. It costs a second pass in the rare
  // case and nothing at all when the tree is clean, and it makes the gate's
  // central claim — a regression must be bigger than the noise *and* survive a
  // re-measurement — true rather than aspirational.
  if (verdict.status === 'fail') {
    console.log('\nA site is past its threshold. Re-measuring to confirm it is reproducible…\n');
    const confirmation = compare(measure(), baseline);
    if (confirmation.status !== 'fail') {
      console.log(
        'INCONCLUSIVE — the regression did not reproduce. A single run past a threshold is a\n' +
          'blip; a real regression is still there on the second measurement.'
      );
      return;
    }
    verdict = confirmation;
    console.log('The regression reproduced.');
  }
  if (verdict.reasons.length) {
    console.log('');
    for (const r of verdict.reasons) console.log(`  - ${r}`);
    console.log('');
  }
  if (verdict.status === 'pass') {
    console.log('PASS — no site slower than its recorded threshold.');
    return;
  }
  if (verdict.status === 'inconclusive') {
    console.log(
      'INCONCLUSIVE — this run cannot be compared to the baseline: the machine\n' +
        'is either noisier or simply running at a different speed than when it was\n' +
        'recorded. Not a failure. Re-run on a calmer machine, or re-record the\n' +
        'baseline if this one has genuinely changed.'
    );
    return;
  }
  console.log('FAIL — at least one site is slower than its recorded threshold.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
