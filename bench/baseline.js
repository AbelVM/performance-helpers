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
 * `bench/results.json`, beside `bench/results.md`, resolved from the **current
 * working directory** — the harness writes both with paths relative to the
 * directory it was invoked from, so this follows the same convention rather than
 * resolving against `bench/` itself. The gate must be run from the repository
 * root, and says so if it was not.
 *
 * @returns {string}
 */
const resultsPath = () => resolve(process.cwd(), 'bench/results.json');

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

  // The machine's own *median* recorded spread, used as a floor below. A site is
  // not a quieter machine than the machine it was measured on: a site that
  // happened to record 14.4% while the median site recorded 17.63% is not
  // capable of being held to 14.4%, it just got lucky once. Without the floor
  // such a site gets a threshold *finer* than the demonstrated noise floor of
  // the box, and then fires on ordinary run-to-run drift - which is the same
  // failure as the `* 100` bug documented below, in the opposite direction:
  // that one made the gate incapable of failing, this one makes it fail without
  // anything having changed. A gate that cries wolf gets ignored, and an ignored
  // gate is the same as no gate.
  const machineSpreadPct = Number(baseline?.medianSpreadPct ?? 0);

  let checked = 0;
  const regressions = [];
  // GATE-012. Sites whose band widened past what they were calibrated at. They
  // were `continue`d, which is a silent drop: a site that became *noisier* was
  // removed from the comparison and nothing said so.
  //
  // **The class of regression this gate is least able to see is the one this
  // hides.** An added allocation, a Map that grows, a megamorphic call site —
  // these do not make a site reliably slower, they make its *band* wider first.
  // A site that got slower *and* more variable lands in this list rather than in
  // `regressions`, so the run reports "the machine moved" or "nothing to report"
  // and the change that caused it is invisible. It is still excluded from the
  // median comparison, because a band too wide to judge cannot support a verdict
  // — but it is named, with both spreads, so "could not judge" is distinguishable
  // from "nothing moved".
  const noisy = [];
  for (const band of current) {
    const before = recorded.get(band.label);
    if (!before) continue;
    checked += 1;
    // Condition 1: a site whose own band widened past what it was calibrated
    // at is telling us about the machine, not about the code.
    if (before.spreadPct > 0 && band.spreadPct > before.spreadPct * spreadTolerance) {
      noisy.push({ label: band.label, before: before.spreadPct, after: band.spreadPct });
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
    const thresholdPct = Math.max(before.spreadPct, machineSpreadPct) * (slowdownTolerance - 1);
    if (before.median > 0 && band.median > before.median * (1 + thresholdPct / 100)) {
      regressions.push({
        label: band.label,
        before: before.median,
        after: band.median,
        delta: (band.median / before.median - 1) * 100,
        deltaPct: ((band.median / before.median - 1) * 100).toFixed(1),
        thresholdPct: thresholdPct.toFixed(1),
      });
    }
  }

  const noisyLines = noisy
    .map(
      (n) =>
        `${n.label}: spread ${n.before.toFixed(1)}% -> ${n.after.toFixed(1)}%, past the ` +
        `${spreadTolerance}x widening this site was calibrated at, so its median was NOT compared`
    )
    .sort((a, b) => widenRatio(b) - widenRatio(a));

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
  const shiftedLine = shifted
    ? `the machine's level moved ${medianDelta > 0 ? '+' : ''}${medianDelta.toFixed(1)}% ` +
      `against the baseline (median across ${deltas.length} sites, tolerance ` +
      `${(shiftTolerance * 100).toFixed(0)}%). Nothing below can be attributed to the code. ` +
      'Re-run on a calmer machine, or re-record the baseline if this one has genuinely changed.'
    : null;

  const noiseWorseLine = noiseWorse
    ? `run noise p95 ${currentP95.toFixed(2)}% exceeds the recorded ${baselineP95.toFixed(2)}% ` +
      `by more than ${noiseTolerance}x; the harness itself is less repeatable than when it was calibrated`
    : null;

  // **GATE-012: a machine shift must not be able to delete a failure.** The status
  // used to be assigned in two unconditional steps — `if (regressions.length)
  // status = 'fail'`, then `if (shifted || noiseWorse) status = 'inconclusive'` —
  // so the second overwrote the first. A run with sites past their own recorded
  // thresholds *and* a machine shift reported `inconclusive`, which the CLI prints
  // as "Not a failure" and exits 0 on. The gate could be silenced by making the
  // machine busier, which is the cheapest way to hide a change and the easiest to
  // do by accident.
  //
  // **"Fail wins" on its own would have been wrong too, and a pinned test says
  // so.** `is inconclusive when the machine level shifted` drives all six sites
  // +50 % and expects `inconclusive`, because that is a *measured* observation: a
  // clean tree once reported six unrelated helpers 44–48 % slower than a baseline
  // recorded minutes earlier. Every one of those six sites is past its threshold,
  // so a blanket "fail wins" turns that observation into a permanent red gate —
  // the coin flip this whole design exists to avoid, arriving from the other
  // direction.
  //
  // What separates the two cases is not the presence of a shift, it is whether a
  // site moved *further than the machine did*. "The machine moved +50 %" is a
  // statement about the median; six sites at +50 % is that statement, six times
  // over. One site at +200 % in a run whose median moved +50 % is not, and no
  // amount of thermal drift accounts for it.
  //
  // So a shift filters the regression list rather than replacing the verdict, and
  // the sites it filters out are reported as filtered — nothing is dropped
  // silently, which is the same rule the noisy-site half of this row is about.
  const shiftPct = Math.abs(medianDelta);
  const beyondShift = shifted
    ? regressions.filter((r) => Math.abs(r.delta) > shiftPct)
    : regressions;
  const explainedByShift = regressions.length - beyondShift.length;
  const explainedLine =
    explainedByShift > 0
      ? `${explainedByShift} of ${regressions.length} site(s) past their threshold moved no further ` +
        `than the machine's own ${medianDelta > 0 ? '+' : ''}${medianDelta.toFixed(1)}%, so they are ` +
        'attributed to the machine and not counted as regressions.'
      : null;

  // Rank by how far past its own threshold the site moved, so the headline is
  // the thing that actually changed rather than whichever label sorted first.
  // A deliberate regression in `PowerCache.get` also drags the rest of the run
  // with it — it allocates more, and the harness measures helpers in sequence
  // without a heap reset between them — so the same mutation reports five or six
  // sites. Ordering by delta puts the real one at the top.
  //
  // The sort is over the site's own lines rather than over the assembled
  // `reasons`, because the headlines are added afterwards. Sorting `reasons`
  // directly demoted the summary to the bottom: it carries no `+%`, so it scored
  // 0 and sorted last, below the very lines it was summarising.
  const regressionLines = beyondShift
    .map(regressionLine)
    .sort((a, b) => deltaOfReason(b) - deltaOfReason(a));

  // Say how much of the run moved. "One of 25 sites" is a regression; "19 of
  // 25" is a machine that was busy, and the per-site deltas in that case are
  // measuring the same thing twenty-five times. Reporting the count is the
  // difference between a gate a reader trusts and one they learn to ignore.
  //
  // Counted over `beyondShift`, so the share describes what is being *reported*
  // as a regression. A run where the machine explains 18 of 19 sites should not
  // print "19 of 19 past their threshold" above a single line — that headline
  // describes a different set of sites than the ones under it.
  //
  // The wording follows `shifted`. Below `minSitesForShift` the shift check is
  // skipped entirely, so there is no machine move to be "beyond", and saying so
  // would name a condition the gate never evaluated.
  const movedShareLines = beyondShift.length
    ? [
        `${beyondShift.length} of ${checked} sites past their threshold` +
          (shifted ? " and beyond the machine's own move" : '') +
          ` (${Math.round((beyondShift.length / Math.max(1, checked)) * 100)}%). ` +
          (beyondShift.length / Math.max(1, checked) >= 0.6
            ? 'That is most of the run, so the machine was probably slower as well: re-run on a ' +
              'calmer machine before believing any single line below.'
            : 'A minority of sites, so this looks like a change in the code rather than the machine.'),
      ]
    : [];

  // Assembled in one place, in the order a reader needs: what could not be
  // trusted first, then how much of the run moved, then the sites themselves,
  // then the sites that could not be judged at all. Each headline carries the
  // caveat that stops the lines under it being read as verdicts about the code.
  const reasons = [
    ...(noiseWorse ? [noiseWorseLine] : []),
    ...(shifted ? [shiftedLine] : []),
    ...movedShareLines,
    ...(explainedLine ? [explainedLine] : []),
    ...regressionLines,
    ...noisyLines,
  ];

  // The verdict reads `beyondShift` and nothing else, so the reasoning above
  // applies here directly: a shift can narrow what counts as a regression, never
  // widen it into a pass.
  let status = 'pass';
  if (shifted || noiseWorse) status = 'inconclusive';
  if (beyondShift.length) status = 'fail';
  return { status, reasons, checked };
}

/**
 * One regression's report line.
 *
 * @param {{label: string, before: number, after: number, deltaPct: string, thresholdPct: string}} r
 * @returns {string}
 */
function regressionLine(r) {
  return (
    `${r.label}: ${r.before.toFixed(3)} ms -> ${r.after.toFixed(3)} ms ` +
    `(+${r.deltaPct}%, threshold +${r.thresholdPct}%)`
  );
}

/**
 * The percentage a reason line reports as a regression, for ranking.
 *
 * Scoped to the text **before** `', threshold'`, which is where the delta is.
 * It used to read the text *after* that separator — the threshold — so every site
 * scored the same number, the sort was a no-op, and the lines came out in
 * measurement order. That is invisible until a run mixes a +40 % site with a
 * +300 % one, which is exactly what a real mutation looks like.
 *
 * @param {string} reason
 * @returns {number}
 */
function deltaOfReason(reason) {
  const m = /\+([\d.]+)%/.exec(reason.split(', threshold')[0]);
  return m ? Number(m[1]) : 0;
}

/**
 * How far past its calibrated spread a site widened, for ranking noisy lines.
 *
 * @param {string} line - A `label: spread a% -> b%, …` line.
 * @returns {number} `b / a`, or 0 when the line does not parse.
 */
function widenRatio(line) {
  const m = /spread ([\d.]+)% -> ([\d.]+)%/.exec(line);
  return m && Number(m[1]) > 0 ? Number(m[2]) / Number(m[1]) : 0;
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
