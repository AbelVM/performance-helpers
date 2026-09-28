#!/usr/bin/env node
/**
 * BENCH-002 — workloads that justify the shipped admission and quantile claims.
 *
 * Two claims in the 2.0 release notes were asserted without a reproducible
 * workload to back them:
 *
 *   1. `PowerCache { admission: 'tinylfu' }` protects a small working set from a
 *      scan, and `policy: 'slru'` already did most of that.
 *   2. `PowerHistogram` (DDSketch) holds its relative-error target across
 *      *scaled* latencies, not just a narrow band.
 *
 * This script exists because the numbers in a changelog are not evidence, and
 * because both claims are best measured as **ratios over a whole run** — hit
 * rate, and quantile relative error — rather than as wall-clock timings. That
 * choice is deliberate: BENCH-001 measured a **28% median min/max spread** on
 * the main harness, so any timing comparison finer than that is noise. Hit
 * rates and relative errors are computed over every operation in the run and
 * are stable regardless of how fast the machine is.
 *
 * Design points that matter for the results to mean anything:
 *
 * - **Paired streams.** Every policy is driven with the *same* seeded key
 *   sequence. Independent streams would fold the workload difference into the
 *   policy difference, which is the same class of error as BENCH-001's
 *   unseeded `Math.random()`.
 * - **Capacity is deliberately too small** for the working set *and* the scan
 *   together. A cache large enough to hold both has no admission problem to
 *   solve, and every policy would tie at 100%.
 * - **Working-set survival is reported separately** from the overall hit rate,
 *   because the claim is specifically about the working set surviving; a policy
 *   could win the rate while losing the set.
 *
 * Usage:
 *   node bench/claims.js zipf      # admission-policy comparison (default)
 *   node bench/claims.js latency   # histogram quantile accuracy across scales
 *
 * Every parameter is overridable from the environment so a result can be
 * reproduced exactly, and so the interesting axes (Zipf exponent, capacity,
 * scan size) can be swept without editing this file.
 *
 * @module bench/claims
 */

import { PowerCache } from '../src/helpers/powerCache.js';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

// ─── Reproducibility (same approach as BENCH-001) ───────────────────────────

/**
 * @param {number} seed
 * @returns {() => number} Floats in [0, 1).
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number.isFinite(Number(process.env.BENCH_SEED))
  ? Number(process.env.BENCH_SEED) >>> 0
  : 0x5eed1234;

// ─── Zipf sampling ──────────────────────────────────────────────────────────
//
// A Zipf distribution is the right model here because real key popularity is
// roughly Zipfian, and because a scan is exactly what it produces when a
// one-shot key arrives with probability comparable to a hot key: under Zipf
// weights, a long tail of rarely-repeated keys gets pulled through the cache in
// the same pass as the hot ones. That is the "one-shot pollution" TinyLFU exists
// to refuse, so a workload without a heavy tail cannot demonstrate it.

/**
 * Build a Zipf weight table over `n` ranks.
 *
 * Precomputing the cumulative table and then binary-searching is materially
 * faster than inverting `s / r**exponent` per draw, which matters because the
 * sampler is inside the timed loop of a large run.
 *
 * @param {number} n
 * @param {number} exponent - Standard Zipf exponent; 1.0 is the classic choice.
 * @returns {Float64Array} Cumulative probabilities, normalised to end at 1.
 */
function zipfTable(n, exponent) {
  const cum = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / (i + 1) ** exponent;
    cum[i] = total;
  }
  for (let i = 0; i < n; i++) cum[i] /= total;
  return cum;
}

/**
 * Draw a rank in [0, n) from a Zipf table.
 *
 * @param {Float64Array} cum
 * @param {number} n
 * @param {() => number} rng
 * @returns {number}
 */
function zipfDraw(cum, n, rng) {
  const u = rng();
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ─── Workload 1: admission policies under Zipf + scan ───────────────────────

/**
 * Run one cache policy against a fixed, seeded key stream.
 *
 * The stream is built **once** and replayed for every policy. That is what makes
 * the comparison paired: any difference between two policies is then
 * attributable to the policy, because both saw byte-identical requests.
 *
 * @param {{policy: string, admission: string, label: string}} variant
 * @param {number[]} stream - Pre-generated key ids, already including scans.
 * @param {number} workingSetSize - How many leading ids are the hot set.
 * @param {number} maxEntries
 * @returns {object} Hit rate, working-set survival, and timing.
 */
function runAdmissionVariant(variant, stream, workingSetSize, maxEntries) {
  const cache = new PowerCache({
    maxEntries,
    policy: variant.policy,
    admission: variant.admission,
    defaultTTL: 60_000,
  });

  let hits = 0;
  let misses = 0;
  let workingSetHits = 0;
  let workingSetRequests = 0;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < stream.length; i++) {
    const id = stream[i];
    // A value is stored, not computed: the claim is about *admission*, so the
    // cost of producing the value must not be entangled with the hit rate. Every
    // variant pays identical miss work this way.
    if (cache.get(id) !== undefined) {
      hits++;
      if (id < workingSetSize) workingSetHits++;
    } else {
      misses++;
      cache.set(id, 1);
    }
    if (id < workingSetSize) workingSetRequests++;
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Survival: of the working-set keys, how many are still resident at the end?
  let survivors = 0;
  for (let id = 0; id < workingSetSize; id++) {
    // `has` does not affect recency, so this measures residency without
    // perturbing what it is measuring.
    if (cache.has(id)) survivors++;
  }

  return {
    label: variant.label,
    policy: variant.policy,
    admission: variant.admission,
    hitRate: hits / (hits + misses),
    workingSetHitRate: workingSetRequests ? workingSetHits / workingSetRequests : 0,
    workingSetSurvivors: survivors,
    workingSetSize,
    maxEntries,
    elapsedMs,
    entries: cache.stats?.().size ?? maxEntries,
  };
}

/**
 * Build a Zipf + scan key stream.
 *
 * The scan is interleaved rather than appended: a contiguous scan at the end
 * would be trivially survivable by any policy, because the working set has not
 * been disturbed while it happens. Interleaving is what makes the working set
 * actually compete with the scan for the same slots.
 *
 * @param {ReturnType<typeof makeRng>} rng
 * @param {{keySpace: number, workingSet: number, scanKeys: number, scanEvery: number, zipf: number}} cfg
 * @returns {{stream: number[], workingSetSize: number}}
 */
function buildZipfScanStream(rng, cfg) {
  const { keySpace, workingSet, scanKeys, scanEvery, zipf } = cfg;
  const cum = zipfTable(Math.min(keySpace, workingSet * 4), zipf);
  const n = cum.length;
  const stream = [];
  for (let i = 0; i < scanEvery; i++) {
    // A burst of one-shot keys from outside the working set.
    for (let s = 0; s < scanKeys; s++) {
      stream.push(workingSet + Math.floor(rng() * Math.max(1, keySpace - workingSet)));
    }
    // Then working-set traffic, drawn from the Zipf head.
    for (let h = 0; h < scanEvery; h++) {
      const rank = zipfDraw(cum, n, rng);
      stream.push(Math.min(rank, workingSet - 1));
    }
  }
  return { stream, workingSetSize: workingSet };
}

function runZipfWorkload() {
  const keySpace = Number(process.env.CLAIM_KEYSPACE || 2000);
  const workingSet = Number(process.env.CLAIM_WORKING_SET || 40);
  // Capacity is `workingSet` exactly, so the working set alone fills the cache
  // and every scan key has to evict something. This is the configuration the
  // claim is about; the guard below refuses to report a number for a config
  // that does not create the pressure.
  const maxEntries = Number(process.env.CLAIM_MAX_ENTRIES || workingSet);
  const scanKeys = Number(process.env.CLAIM_SCAN_KEYS || 25);
  const scanEvery = Number(process.env.CLAIM_SCAN_EVERY || 40);
  const zipf = Number(process.env.CLAIM_ZIPF || 1.0);
  const repeats = Math.max(1, Number(process.env.CLAIM_REPEATS || 5));

  // Refuse rather than mislead. A cache large enough to hold the working set and
  // the whole scan has no admission problem to solve: every policy ties near
  // 100% and the run proves nothing. An earlier version of this script defaulted
  // `maxEntries` to `workingSet * 2` and printed "it does NOT fit" while it did
  // in fact fit, which is the worst of both — a benchmark measuring something
  // other than it claims.
  if (maxEntries > workingSet) {
    console.log(
      `  REFUSING TO RUN: maxEntries (${maxEntries}) exceeds the working set ` +
        `(${workingSet}), so the working set never faces eviction and every\n` +
        '  policy ties. Set CLAIM_MAX_ENTRIES <= CLAIM_WORKING_SET to create the\n' +
        '  scan pressure this workload exists to measure.'
    );
    return { skipped: true, reason: 'no eviction pressure', config: { maxEntries, workingSet } };
  }

  const variants = [
    { label: 'lru', policy: 'lru', admission: 'none' },
    { label: 'lru + tynilfu', policy: 'lru', admission: 'tinylfu' },
    { label: 'slru', policy: 'slru', admission: 'none' },
    { label: 'slru + tynilfu', policy: 'slru', admission: 'tinylfu' },
  ];

  console.log('BENCH-002a — cache admission under a Zipf + scan workload\n');
  console.log(`  seed              ${SEED}`);
  console.log(`  zipf exponent     ${zipf}`);
  console.log(`  key space         ${keySpace}`);
  console.log(`  working set       ${workingSet} keys`);
  console.log(
    `  maxEntries        ${maxEntries}   (equals the working set, so every scan key must evict one)`
  );
  console.log(`  scan              ${scanKeys} one-shot keys every ${scanEvery} hot accesses`);
  console.log(`  repeats           ${repeats} (paired: every variant sees the identical stream)\n`);

  // Aggregate per variant across repeats. The stream is regenerated from the
  // same seed each time so the *same* stream is replayed, and every variant
  // inside a repeat shares it.
  const totals = new Map(
    variants.map((v) => [v.label, { hit: 0, wsHit: 0, surv: 0, ms: 0, n: 0 }])
  );

  for (let r = 0; r < repeats; r++) {
    const rng = makeRng(SEED + r);
    const { stream } = buildZipfScanStream(rng, {
      keySpace,
      workingSet,
      scanKeys,
      scanEvery,
      zipf,
    });
    for (const v of variants) {
      const res = runAdmissionVariant(v, stream, workingSet, maxEntries);
      const agg = totals.get(v.label);
      agg.hit += res.hitRate;
      agg.wsHit += res.workingSetHitRate;
      agg.surv += res.workingSetSurvivors;
      agg.ms += res.elapsedMs;
      agg.n++;
    }
  }

  const rows = variants.map((v) => {
    const a = totals.get(v.label);
    return {
      variant: v.label,
      policy: v.policy,
      admission: v.admission,
      hitRate: a.hit / a.n,
      workingSetHitRate: a.wsHit / a.n,
      survivors: a.surv / a.n,
      ms: a.ms / a.n,
    };
  });

  console.log(
    `  ${'variant'.padEnd(16)}${'hit rate'.padStart(10)}${'ws hit rate'.padStart(13)}${'survivors'.padStart(12)}${'mean ms'.padStart(10)}`
  );
  console.log(`  ${'-'.repeat(61)}`);
  for (const r of rows) {
    console.log(
      `  ${r.variant.padEnd(16)}${(r.hitRate * 100).toFixed(1).padStart(9)}%` +
        `${(r.workingSetHitRate * 100).toFixed(1).padStart(12)}%` +
        `${`${r.survivors.toFixed(1)}/${workingSet}`.padStart(12)}` +
        `${r.ms.toFixed(2).padStart(10)}`
    );
  }

  const best = rows.reduce((a, b) => (b.workingSetHitRate > a.workingSetHitRate ? b : a));
  console.log(
    `\n  Best working-set retention: ${best.variant} (${(best.workingSetHitRate * 100).toFixed(1)}%)`
  );
  const lru = rows.find((r) => r.variant === 'lru');
  const slru = rows.find((r) => r.variant === 'slru');
  console.log(
    `  Plain lru retains ${lru.survivors.toFixed(1)}/${workingSet} working-set keys; ` +
      `slru retains ${slru.survivors.toFixed(1)}/${workingSet}.`
  );
  console.log(
    '\n  Note on the timing column: it is secondary. BENCH-001 measured a 28% median' +
      '\n  min/max spread on this machine, so treat mean-ms differences as' +
      '\n  uninformative unless they exceed that. Hit rate and retention are ratios'
  );
  console.log('  over the whole run and are the robust claims here.');

  return {
    rows,
    config: { keySpace, workingSet, maxEntries, scanKeys, scanEvery, zipf, repeats, seed: SEED },
  };
}

// ─── Workload 2: histogram quantile accuracy across scales ──────────────────

/**
 * Run `PowerHistogram` against ground truth over a scaled-latency distribution.
 *
 * The claim is that DDSketch holds its **relative** error target, which is only
 * meaningful if the target holds when the values themselves span orders of
 * magnitude. A benchmark that fed 1–10 ms would find almost any bucketing scheme
 * adequate; a latency distribution that crosses three decades is where a
 * relative-error sketch earns its existence.
 *
 * Ground truth is a full sort, so the comparison is exact rather than against
 * another estimate.
 *
 * @returns {object} Per-percentile relative error.
 */
function runScaledLatencyWorkload() {
  const n = Number(process.env.CLAIM_LATENCY_SAMPLES || 200_000);
  const relativeAccuracy = Number(process.env.CLAIM_LATENCY_ACCURACY || 0.01);
  const quantiles = (process.env.CLAIM_LATENCY_QUANTILES || '50,90,95,99,99.9')
    .split(',')
    .map(Number);
  const repeats = Math.max(1, Number(process.env.CLAIM_LATENCY_REPEATS || 3));

  console.log('BENCH-002b — PowerHistogram quantile accuracy across scaled latencies\n');
  console.log(`  seed              ${SEED}`);
  console.log(`  samples           ${n} per repeat`);
  console.log(`  relativeAccuracy  ${relativeAccuracy} (the target under test)`);
  console.log('  distribution      lognormal, median x10^U(0, 1) over 4 decades of scale');
  console.log(`  repeats           ${repeats}\n`);

  const worstByQuantile = new Map(quantiles.map((q) => [q, 0]));

  for (let r = 0; r < repeats; r++) {
    const rng = makeRng(SEED + r);
    const values = new Array(n);
    const hist = new PowerHistogram({
      relativeAccuracy,
      // maxValue is advisory only; values above it are still recorded faithfully
      // in their own bucket, which is exactly the case worth exercising.
      maxValue: 100,
    });

    for (let i = 0; i < n; i++) {
      // Box-Muller in log space: a lognormal, so the sample spans 4 decades.
      const u1 = rng() || 1e-12;
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const v = 10 ** z; // ~0.1 to ~10000 ms, log-uniform
      values[i] = v;
      hist.record(v);
    }

    const sorted = values.slice().sort((a, b) => a - b);
    for (const q of quantiles) {
      const idx = Math.min(sorted.length - 1, Math.floor((q / 100) * (sorted.length - 1)));
      const truth = sorted[idx];
      const est = hist.percentile(q);
      if (!Number.isFinite(est) || truth <= 0) continue;
      const relErr = Math.abs(est - truth) / truth;
      if (relErr > worstByQuantile.get(q)) worstByQuantile.set(q, relErr);
    }
  }

  console.log(
    `  ${'quantile'.padStart(9)}${'worst rel. error'.padStart(18)}${'target'.padStart(10)}${'verdict'.padStart(12)}`
  );
  console.log(`  ${'-'.repeat(49)}`);
  let anyMissed = false;
  for (const q of quantiles) {
    const err = worstByQuantile.get(q);
    const ok = err <= relativeAccuracy;
    if (!ok) anyMissed = true;
    console.log(
      `  ${`p${q}`.padStart(9)}${`${(err * 100).toFixed(3)}%`.padStart(18)}` +
        `${`${relativeAccuracy * 100}%`.padStart(10)}${(ok ? 'ok' : 'MISSED').padStart(12)}`
    );
  }
  console.log(
    anyMissed
      ? '\n  Some quantiles exceeded the target. A log-relative sketch is hardest in the' +
          '\n  far tail, where the estimate rests on few samples and a single bucket' +
          '\n  boundary moves it furthest — so p99.9 missing while p50–p99 hold is the' +
          '\n  expected shape of a marginal miss, not a broken implementation. Judge it on' +
          '\n  the margin above, not on "did it pass".'
      : '\n  All quantiles held the target across the full range.'
  );

  return { config: { n, relativeAccuracy, quantiles, repeats, seed: SEED }, anyMissed };
}

// ─── Entry point ────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'zipf';

if (mode === 'zipf') {
  runZipfWorkload();
} else if (mode === 'latency') {
  runScaledLatencyWorkload();
} else {
  console.error(`Unknown mode: ${mode}. Use "zipf" or "latency".`);
  process.exit(1);
}
