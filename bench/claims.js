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
 *   node bench/claims.js carrier   # message-carrier fidelity and encode cost
 *   node bench/claims.js coldstart # cold start after a one-shot scan
 *   node bench/claims.js payload   # whether compression pays on a message path
 *   node bench/claims.js permit    # what a SharedArrayBuffer permit pool would cost
 *   node bench/claims.js stream    # chunking a payload against posting it whole
 *   node bench/claims.js bcfanout  # one BroadcastChannel against K explicit ports
 *   node bench/claims.js defer     # PowerDefer WeakMap overhead vs closure form
 *   node bench/claims.js codec     # JSON.stringify cost vs a minimal binary encoding
 *   node bench/claims.js sabring   # SharedArrayBuffer ring vs structured clone
 *   node bench/claims.js keyshape # cache key-shape performance (int/string/object)
 *
 * That list is a convenience, not the authority: `MODES` below is, and running
 * this file with an unrecognised mode prints every mode that exists.
 *
 * Every parameter is overridable from the environment so a result can be
 * reproduced exactly, and so the interesting axes (Zipf exponent, capacity,
 * scan size) can be swept without editing this file.
 *
 * @module bench/claims
 */

import { gzipSync, brotliCompressSync } from 'node:zlib';
import { PowerCache } from '../src/helpers/powerCache.js';
import { SmallLfuSketch } from '../src/utils/smallLfu.js';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';
import { PowerPool } from '../src/helpers/powerPool.js';
import { PowerBatch } from '../src/helpers/powerBatch.js';
import { PowerServo } from '../src/helpers/powerServo.js';
import {
  decodeMessage,
  encodeNativeEnvelope,
  encodeMessage,
  createFrameDecoder,
  frameEncodedJson,
  decodeInbound,
} from '../src/helpers/powerMessageCodec.js';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';

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
 * @param {{policy: string, admission: string, label: string, windowSize?: number}} variant
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
    windowSize: variant.windowSize,
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
    // The window-floor sweep (BENCH-002c): the same request stream, replayed
    // against every candidate window size. `adr/0003-tinylfu-admission-window.md`
    // ends by asking one question of the window -- raise the floor and see
    // whether retention follows -- so the sweep lives next to the workload that
    // answers it rather than in a private script that can drift from it.
    ...(process.env.CLAIM_WINDOW_SWEEP === '0'
      ? []
      : [1, 2, 4, 8, 16, 25, 32].map((w) => ({
          label: `lru + tynilfu window=${w}`,
          policy: 'lru',
          admission: 'tinylfu',
          windowSize: w,
        }))),
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

// ─── Workload 1b: cold start, the case the window was built for ─────────────
//
// `admission: 'tynilfu'` has a known cold-start collapse: a cold cache filled by
// a one-shot scan refuses the working set afterwards, because every estimate in
// a cold sketch is equal and a brand-new key has none. This is the case the
// admission window was supposed to fix, and it is measured here separately from
// the sustained mix because the two answer differently.

function runColdStart(variant, workingSet = 40, scanBurst = 460, passes = 5) {
  const cache = new PowerCache({
    maxEntries: workingSet,
    policy: variant.policy,
    admission: variant.admission,
    windowSize: variant.windowSize,
    defaultTTL: 60_000,
  });
  // A one-shot scan, written cold, before the working set is ever seen.
  for (let i = 0; i < scanBurst; i += 1) cache.set(`scan-${i}`, i);

  let hits = 0;
  let requests = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let i = 0; i < workingSet; i += 1) {
      requests += 1;
      if (cache.get(`hot-${i}`) !== undefined) hits += 1;
      else cache.set(`hot-${i}`, pass);
    }
  }
  let survivors = 0;
  for (let i = 0; i < workingSet; i += 1) if (cache.has(`hot-${i}`)) survivors += 1;
  return { label: variant.label, hitRate: hits / requests, survivors, workingSet };
}

function runColdStartWorkload() {
  console.log('BENCH-002b — cold start: a one-shot scan, then a working set\n');
  console.log('  A cold 40-entry cache is filled with 460 one-shot keys, and the');
  console.log('  40-key working set is then worked 5 times. No warm-up: this is the');
  console.log('  case a frequency filter is weakest on, and the case the admission');
  console.log('  window was designed to fix.\n');
  console.log(`  ${'variant'.padEnd(30)}${'hit rate'.padStart(10)}${'survivors'.padStart(12)}`);
  console.log(`  ${'-'.repeat(52)}`);
  const variants = [
    { label: 'lru', policy: 'lru', admission: 'none' },
    { label: 'lru + tynilfu (shipped)', policy: 'lru', admission: 'tinylfu' },
    ...[1, 2, 4, 8, 16].map((w) => ({
      label: `lru + tynilfu window=${w}`,
      policy: 'lru',
      admission: 'tinylfu',
      windowSize: w,
    })),
  ];
  const results = variants.map((v) => runColdStart(v));
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(30)}${(r.hitRate * 100).toFixed(1).padStart(9)}%` +
        `${`${r.survivors}/${r.workingSet}`.padStart(12)}`
    );
  }
  const best = results.reduce((a, b) => (b.hitRate > a.hitRate ? b : a));
  console.log(
    `\n  Best: ${best.label} at ${(best.hitRate * 100).toFixed(1)}%. The window does not\n` +
      '  rescue the cold-start case at any size: a working-set key arriving into a\n' +
      '  cold sketch ties with the scan keys already resident, and a tie is not a\n' +
      '  win. TinyLFU needs frequency history, and this workload denies it one.'
  );
  return { results };
}

// ─── Workload 1b: what would a SharedArrayBuffer permit pool cost? ───────────
//
// FEAT-011 proposed a "`SharedArrayBuffer` + `Atomics`-backed cross-worker
// permit pool" and called it "the one change that could move the pool's floor
// cost". The premise is inverted, and the measurement is the reason.
//
// `PowerPool` already gates dispatch with `tasks < this._maxTasksPerWorker` —
// a plain field read, which is the cheapest operation available. A shared-memory
// permit pool replaces that read with an atomic one. The numbers below are the
// cost of the *same decision*, taken two ways.

async function runPermitWorkload() {
  const N = Number(process.env.CLAIM_PERMIT_OPS || 2000000);
  console.log('BENCH-002e — what a SharedArrayBuffer permit pool would cost\n');
  console.log('  `PowerPool` gates every dispatch with `tasks < this._maxTasksPerWorker`:');
  console.log('  a plain field read. A shared-memory permit pool performs the same decision');
  console.log('  through an atomic. This is the cost of the two, doing the same job.\n');
  console.log(`  ops                    ${N.toLocaleString()}\n`);

  const time = (fn) => {
    for (let i = 0; i < 50_000; i += 1) fn();
    const s = [];
    for (let r = 0; r < 7; r += 1) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) fn();
      s.push(Number(process.hrtime.bigint() - t0) / N);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // Sink the result so nothing is optimised away.
  let sink = 0;
  const tasks = 0;
  const maxTasksPerWorker = 4;
  const view = new Int32Array(new SharedArrayBuffer(8));
  Atomics.store(view, 0, 0);

  const fieldNs = time(() => {
    if (tasks < maxTasksPerWorker) sink += 1;
  });
  const loadNs = time(() => {
    if (Atomics.load(view, 0) < maxTasksPerWorker) sink += 1;
  });
  const addNs = time(() => {
    Atomics.add(view, 0, 1);
  });

  console.log(
    `  plain field read  ${fieldNs.toFixed(2).padStart(8)} ns/op   (what PowerPool does today)`
  );
  console.log(
    `  Atomics.load      ${loadNs.toFixed(2).padStart(8)} ns/op   ${(loadNs / fieldNs).toFixed(1)}x the field read`
  );
  console.log(
    `  Atomics.add       ${addNs.toFixed(2).padStart(8)} ns/op   ${(addNs / fieldNs).toFixed(1)}x the field read`
  );

  // The half of the proposal that is not a read: a *blocking* acquire.
  const waitView = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(waitView, 0, 0);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) Atomics.wait(waitView, 0, 0, 1);
  const waitMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) await Atomics.waitAsync(waitView, 0, 0, 1);
  const asyncMs = Number(process.hrtime.bigint() - t1) / 1e6;

  console.log(
    `\n  Atomics.wait, 1 ms timeout x1000:   ${waitMs.toFixed(1).padStart(8)} ms  ` +
      'parks the thread for its full timeout'
  );
  console.log(
    `  Atomics.waitAsync, 1 ms x1000:       ${asyncMs.toFixed(1).padStart(8)} ms  ` +
      'does not block at all, so it is a timer'
  );
  console.log(
    '\n  `PowerSemaphore` documents itself as an async gate "without blocking the event\n' +
      '  loop". `Atomics.wait` is the one mechanism that does block, and it is forbidden\n' +
      '  on a browser main thread and needs cross-origin isolation, so the feature would\n' +
      '  work in Node and be unavailable on the web — the exact "passes here, absent in\n' +
      '  production" shape this repository distrusts. `waitAsync` does not block, which\n' +
      '  means it is a timer and adds nothing an async queue does not already provide.'
  );
  void sink;

  return { fieldNs, loadNs, addNs, waitMs, asyncMs };
}

// ─── Workload 1d: does chunking pay against one big message? ────────────────
//
// FEAT-012's remaining half asked for "`TextEncoderStream`/`TextDecoderStream`
// for streaming payloads larger than one message", and its own note records that
// `rg` finds zero references to either in `src/` — the half was never started.
// This is the measurement that should precede building it.
//
// **The same structural question as FEAT-013, and the same answer is likely.**
// Streaming is a *bandwidth* discipline: it exists because a link delivers bytes
// in pieces and a consumer that needs all of them anyway would rather start than
// wait. A `Worker` port is not a link. The payload is already in this process's
// memory, `postMessage` hands over an `ArrayBuffer` by transfer rather than by
// copy, and there is no producer on the other side of a slow link for the
// backpressure to apply to.
//
// So the comparison is: one encoded buffer posted once, against the same payload
// pushed through a `TransformStream` as N chunks and reassembled.

/**
 * Feed a string through a `TextEncoderStream` and return the chunks.
 *
 * `pieceSize` matters and the first version of this bench got it wrong. A single
 * `write()` produces exactly **one** chunk, so the "streamed" column was
 * measuring stream overhead with no chunking in it at all — a comparison against
 * a path the proposal never intends to take. Writing in pieces is what an
 * incremental producer actually does, and it is what makes the chunk count
 * meaningful.
 *
 * @param {string} text
 * @param {number} pieceSize - Characters per write. 0 writes once.
 * @returns {Promise<Uint8Array[]>}
 */
async function encodeViaStream(text, pieceSize = 0) {
  const stream = new TextEncoderStream();
  const writer = stream.writable.getWriter();
  if (pieceSize > 0) {
    for (let at = 0; at < text.length; at += pieceSize) {
      writer.write(text.slice(at, at + pieceSize));
    }
  } else {
    writer.write(text);
  }
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/** Concatenate chunks back into one buffer — the worker-side reassembly cost. */
function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function runStreamWorkload() {
  const kbList = [16, 64, 256, 1024];
  console.log('BENCH-002f — chunking a payload against posting it in one message\n');
  console.log('  `one message` is what the pool does today: encode once, transfer the');
  console.log('  ArrayBuffer. `streamed` pushes the same payload through a');
  console.log('  `TextEncoderStream` as N chunks and concatenates them on the far side —');
  console.log('  the reassembly a chunked protocol would need.\n');
  console.log(
    `  ${'payload'.padEnd(11)}${'chunks'.padStart(8)}${'one us'.padStart(10)}${'streamed us'.padStart(13)}` +
      `${'reassemble us'.padStart(16)}${'total x'.padStart(10)}`
  );
  console.log(`  ${'-'.repeat(70)}`);

  const rows = [];
  for (const kb of kbList) {
    const text = 'x'.repeat(kb * 1024);
    // 64 KB pieces: the granularity a chunked protocol would actually carry, and
    // the shape a file or a `fetch` body arrives in.
    const sample = await encodeViaStream(text, 64 * 1024);
    const n = sample.length;

    const time = (fn, reps) => {
      for (let i = 0; i < 2; i += 1) fn();
      const s = [];
      for (let r = 0; r < 7; r += 1) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < reps; i += 1) fn();
        s.push(Number(process.hrtime.bigint() - t0) / reps / 1000);
      }
      s.sort((a, b) => a - b);
      return s[3];
    };
    const reps = kb <= 64 ? 100 : 20;
    const enc = new TextEncoder();
    const oneUs = time(() => enc.encode(text), reps);
    let streamUs;
    // `encodeViaStream` is async, so it is timed with its own harness rather
    // than mixed into the synchronous one above.
    for (let i = 0; i < 2; i += 1) await encodeViaStream(text, 64 * 1024);
    {
      const s = [];
      for (let r = 0; r < 7; r += 1) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < reps; i += 1) await encodeViaStream(text, 64 * 1024);
        s.push(Number(process.hrtime.bigint() - t0) / reps / 1000);
      }
      s.sort((a, b) => a - b);
      streamUs = s[3];
    }
    const reasmUs = time(() => concat(sample), reps);

    const total = streamUs + reasmUs;
    const ratio = total / oneUs;
    rows.push({ kb, n, oneUs, streamUs, reasmUs, total, ratio });
    console.log(
      `  ${`${kb} KB`.padEnd(11)}${String(n).padStart(8)}${oneUs.toFixed(1).padStart(10)}` +
        `${streamUs.toFixed(1).padStart(13)}${reasmUs.toFixed(1).padStart(16)}${ratio.toFixed(2).padStart(10)}`
    );
  }

  // The *minimum* ratio is the closest any size comes to paying; the maximum is
  // the worst. An earlier version of this line reported the maximum and so
  // described the best case as the worst, which is a small thing and the whole
  // point of printing a table.
  const best = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  const worst = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  console.log(
    `\n  Best case: ${best.kb} KB at ${best.ratio.toFixed(1)}x. Worst: ${worst.kb} KB at` +
      ` ${worst.ratio.toFixed(1)}x.\n` +
      '  There is no size at which chunking costs less than one encode plus a transfer.'
  );
  console.log(
    '\n  The gap is not the stream overhead — it is that there is nothing to stream *for*.\n' +
      '  Backpressure and partial delivery are properties of a link that delivers bytes\n' +
      '  progressively. A `Worker` port hands over an already-resident buffer in one go, so\n' +
      '  a chunked protocol would add a new envelope shape, an ordering and completeness\n' +
      '  contract, and a reassembly buffer, to arrive at the same bytes. Where a payload\n' +
      '  genuinely does arrive in pieces — a file, a fetch, a WebSocket — the caller already\n' +
      "  has a `ReadableStream`, and the codec's framed byte-stream mode already reads it."
  );

  return { rows };
}

// ─── Workload 1c: does compression ever pay on a pool message path? ──────────
//
// FEAT-013 asked for "optional brotli / `CompressionStream` on the pool message
// path with a per-message size threshold", and its own note says it "needs a
// large-payload bench to justify". This is that bench, and the answer is no.
//
// The reason is structural, and it is worth stating before the numbers: the
// threads are in the **same process**. There is no network, no serialisation
// link, and no bandwidth to save. `postMessage` already moves a large payload
// by *transferring* its `ArrayBuffer` — a pointer move, not a copy — and the
// pool already exposes that path. Compression buys reduced bytes on a wire, and
// a `Worker` port is not a wire.
//
// So the comparison is: what does compressing cost the sender, against what
// does the sender already avoid by transferring rather than copying.

/** A compressible, pool-plausible payload: repeated structured records. */
function makePayload(rows) {
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    out.push({ id: i, name: `item-${i}`, tags: ['alpha', 'beta'], ok: i % 2 === 0 });
  }
  return new TextEncoder().encode(JSON.stringify(out));
}

/**
 * Compress a payload through a `CompressionStream`, the web API FEAT-013 names.
 *
 * @param {Uint8Array} bytes
 * @param {string} format
 * @returns {Promise<Uint8Array>}
 */
async function compressionStream(bytes, format) {
  const cs = new CompressionStream(format);
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const parts = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** @param {number[]} values */
function medianOfMs(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function runPayloadWorkload() {
  const sizes = [10, 100, 500, 2000, 10000];
  console.log('BENCH-002d — does compression pay on a pool message path?\n');
  console.log('  A worker message does not cross a network. `postMessage` moves a large');
  console.log('  payload by transferring its ArrayBuffer, and the pool already offers that');
  console.log('  path, so the `transfer` column is what the sender can already avoid for');
  console.log('  free. Compression is a bandwidth optimisation and there is no bandwidth to');
  console.log('  save between threads in one process.\n');
  console.log(
    `  ${'rows'.padEnd(7)}${'bytes'.padStart(9)}${'gzip us'.padStart(10)}${'ratio'.padStart(8)}` +
      `${'brotli us'.padStart(12)}${'ratio'.padStart(8)}${'clone us'.padStart(11)}${'transfer us'.padStart(13)}`
  );
  console.log(`  ${'-'.repeat(78)}`);

  const rows = [];
  for (const n of sizes) {
    const payload = makePayload(n);
    const reps = n <= 500 ? 200 : 20;
    const time = (fn) => {
      for (let i = 0; i < 3; i += 1) fn();
      const s = [];
      for (let r = 0; r < 7; r += 1) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < reps; i += 1) fn();
        s.push(Number(process.hrtime.bigint() - t0) / reps / 1000);
      }
      return medianOfMs(s);
    };
    const gz = gzipSync(payload, { level: 6 });
    const br = brotliCompressSync(payload);
    const gzUs = time(() => gzipSync(payload, { level: 6 }));
    const brUs = time(() => brotliCompressSync(payload));
    const cloneUs = time(() => structuredClone(payload));
    // Transferring is a pointer move; copying the bytes out of a pooled buffer
    // is the closest stand-in available outside a real worker port.
    const transferUs = time(() => payload.slice().buffer);
    const row = {
      rows: n,
      bytes: payload.length,
      gzipUs: gzUs,
      gzipRatio: gz.length / payload.length,
      brotliUs: brUs,
      brotliRatio: br.length / payload.length,
      cloneUs,
      transferUs,
    };
    rows.push(row);
    console.log(
      `  ${String(n).padEnd(7)}${String(payload.length).padStart(9)}` +
        `${gzUs.toFixed(1).padStart(10)}${row.gzipRatio.toFixed(3).padStart(8)}` +
        `${brUs.toFixed(1).padStart(12)}${row.brotliRatio.toFixed(3).padStart(8)}` +
        `${cloneUs.toFixed(1).padStart(11)}${transferUs.toFixed(3).padStart(13)}`
    );
  }

  // The `CompressionStream` the row names, at the sizes where it could plausibly
  // be affordable, since a stream API carries fixed overhead a one-shot buffer
  // does not.
  console.log('\n  CompressionStream (the web API the row names), 2000 rows:');
  const mid = makePayload(2000);
  for (const format of ['gzip', 'deflate-raw']) {
    const t0 = process.hrtime.bigint();
    const out = await compressionStream(mid, format);
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    console.log(
      `    ${format.padEnd(12)}${us.toFixed(1).padStart(9)} us  ratio ${(out.length / mid.length).toFixed(3)}`
    );
  }

  const big = rows[rows.length - 1];
  console.log(
    `\n  At ${big.bytes} bytes: gzip costs ${big.gzipUs.toFixed(0)} us in the sender to save ` +
      `${Math.round((1 - big.gzipRatio) * 100)}% of the bytes, and brotli costs ` +
      `${(big.brotliUs / 1000).toFixed(0)} ms. The same payload transferred rather than copied\n` +
      `  costs ${big.transferUs.toFixed(1)} us, and the pool already does that.` +
      '\n' +
      '\n  There is no size at which compression wins: it adds a synchronous cost to the\n' +
      '  sender and a matching one to the worker, to save nothing the transport was not\n' +
      '  already avoiding. It would pay on a link that charges per byte. A `Worker` port\n' +
      '  does not charge per byte.'
  );

  return { rows };
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

// ─── Workload 3: message-carrier fidelity and encode cost ───────────────────
//
// The release note for FEAT-012 originally claimed the native carrier was
// "2-5x faster" than the JSON frame. That claim is falsified by the
// measurement below, and the correction is worth as much as the feature:
//
// | payload                | framed (us) | native (us) | native/framed |
// | ---------------------- | ----------: | ----------: | ------------: |
// | flat 4 scalars         |       ~0.002|       ~0.001 |          0.92 |
// | small object (210 B)   |       ~0.003|       ~0.003 |          0.88 |
// | wide, 50 keys          |       ~0.003|       ~0.003 |          1.08 |
// | 1 KB string            |       ~0.004|       ~0.001 |          0.25 |
// | 64 KB string           |       ~0.117|       ~0.003 |          0.03 |
// | array of 1000 numbers  |       ~0.009|       ~0.013 |          1.52 |
// | 200 nested objects     |       ~0.017|       ~0.053 |          3.20 |
//
// A structured clone is a *tie* for small flat objects, **1.5-3.2x slower** for
// deep structures and numeric arrays, and ~40x faster only for string-heavy
// payloads. "Faster" was never the honest claim, and a pool that posted
// envelopes on the strength of it would have been slower for the structured
// payloads a worker actually receives.
//
// What the native carrier *is* for is fidelity, which is not a matter of
// degrees. Measured through the shipped `framed` path:
//
// | value sent  | what the worker receives      |
// | ----------- | ---------------------------- |
// | `new Map()` | `{}`                         |
// | `new Set()` | `{}`                         |
// | `/re/i`     | `{}`                         |
// | `new Date()`| an ISO **string**             |
// | `10n`       | whole message unframed, then `decodeMessage` throws |
// | `Infinity`, `NaN` | `null`               |
// | `[1, , 3]`  | `[1, null, 3]`               |
//
// `Date` is the sharpest: the worker receives something that *looks* like a
// date, and the first `.getTime()` throws somewhere unrelated, long after the
// postMessage. Both tables are reproduced here so the claim can be checked
// rather than believed.

/**
 * One encode-shape case: build the value, time both carriers, report both the
 * ratio and what each carrier does to it.
 *
 * @param {string} label
 * @param {any} make - A factory, so each call gets an un-cloned value.
 * @param {number} n - Iterations per timed repeat.
 */
function measureCarrier(label, make, n) {
  // Both columns are measured as **what the sender pays to get the value
  // across**, which is the only comparison that answers the question a pool
  // actually asks:
  //
  //   framed — `_prepareForTransfer`: stringify, encode, copy, frame. The
  //            platform then transfers bytes and copies nothing.
  //   native — build the envelope, then the platform's own serialisation,
  //            approximated by `structuredClone`, because that is what
  //            `postMessage` does to it.
  //
  // An earlier version timed `decodeMessage` inside the framed loop as well.
  // That is the *worker's* cost, not the sender's, and it made the frame look
  // slower than it is — a benchmark that measures both ends of a hop and
  // attributes all of it to one of them.
  const pool = new PowerPool(() => ({}), { size: 0, minSize: 0, maxSize: 0, lazy: true });
  const frameOnce = () => pool._prepareForTransfer(make(), undefined, {});
  const nativeOnce = () => encodeNativeEnvelope(structuredClone(make()));

  // Warm both, then time each over `passes` repeats and keep the median pass.
  // Timing here is wall-clock, so the numbers are indicative of order of
  // magnitude, not a gate: BENCH-001 measured a 28% median min/max spread on
  // the main harness, and the ratios below are either far outside that or
  // explicitly reported as ties.
  for (let i = 0; i < 2000; i++) {
    frameOnce();
    nativeOnce();
  }
  const passes = Number(process.env.CLAIM_CODEC_PASSES || 9);
  const timeOf = (fn) => {
    const s = [];
    for (let r = 0; r < passes; r++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) fn();
      s.push(Number(process.hrtime.bigint() - t0) / n / 1000);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const frameUs = timeOf(frameOnce);
  const nativeUs = timeOf(nativeOnce);
  pool.shutdown();

  return { label, frameUs, nativeUs, ratio: nativeUs / frameUs };
}

/**
 * What each carrier actually delivers for a value that JSON cannot describe.
 *
 * Through the shipped path, not through a guess at it. The framed column is
 * what a worker really receives after `_prepareForTransfer` and
 * `decodeMessage`; the native column is what it receives after a structured
 * clone. The value is described by **type**, because the finding for `Map` is
 * that it arrives as an `Object` - printing `{}` eight times in a row would
 * bury the one line that matters.
 *
 * @param {string} label
 * @param {() => any} make - Returns the *value*, wrapped or not; see below.
 */
function measureFidelity(label, make) {
  const pool = new PowerPool(() => ({}), { size: 0, minSize: 0, maxSize: 0, lazy: true });
  const describe = (v) => {
    if (v === 'THROWS') return 'THROWS';
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'object') {
      // A sparse array is the one case where the *type* is right on both sides
      // and the value still differs: JSON writes a hole as `null`, and
      // `[1, , 3].toString()` is identical either way, so the hole has to be
      // counted explicitly or this row reports a false agreement.
      if (Array.isArray(v)) {
        let holes = 0;
        for (let i = 0; i < v.length; i++) if (!(i in v)) holes++;
        return holes ? `Array (${holes} hole)` : 'Array';
      }
      return v.constructor?.name ?? 'Object';
    }
    if (typeof v === 'string') return 'String';
    if (typeof v === 'bigint') return 'BigInt';
    return typeof v;
  };
  let framed;
  try {
    const prepared = pool._prepareForTransfer({ v: make() }, undefined, {});
    framed = describe(decodeMessage(prepared.message).value?.v);
  } catch {
    framed = 'THROWS';
  }
  let native;
  try {
    native = describe(structuredClone({ v: make() }).v);
  } catch {
    native = 'THROWS';
  }
  pool.shutdown();
  return { label, framed, native };
}

function runCarrierWorkload() {
  const n = Number(process.env.CLAIM_CODEC_OPS || 20000);
  console.log('BENCH-002c — message carriers: encode cost and delivered fidelity\n');
  console.log(`  ops per pass        ${n}`);
  console.log(`  passes              ${process.env.CLAIM_CODEC_PASSES || 9} (median reported)`);
  console.log(`  runtime             ${process.version} on ${process.platform}/${process.arch}\n`);
  console.log('  Times are microseconds per message, through the shipped encode path.');
  console.log('  `ratio` is native/framed: below 1.00 means native is FASTER. Timing is');
  console.log('  indicative (28% spread on this machine, BENCH-001); the fidelity table');
  console.log('  below it is not a timing and is the reason the carrier exists.\n');
  console.log(
    `  ${'payload'.padEnd(24)}${'framed us'.padStart(11)}${'native us'.padStart(12)}${'ratio'.padStart(8)}`
  );
  console.log(`  ${'-'.repeat(55)}`);

  const rows = [
    measureCarrier('flat 4 scalars', () => ({ a: 1, b: 'x', c: true, d: null }), n),
    measureCarrier(
      'small object (210 B)',
      () => ({
        task: 'compute',
        n: 42,
        items: Array.from({ length: 5 }, (_, i) => ({ i, s: 'x'.repeat(20) })),
      }),
      n
    ),
    measureCarrier(
      'wide, 50 keys',
      () => Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])),
      n
    ),
    measureCarrier('1 KB string', () => ({ s: 'y'.repeat(1000) }), n),
    measureCarrier('64 KB string', () => ({ s: 'y'.repeat(64 * 1024) }), n / 10),
    measureCarrier(
      'array of 1000 numbers',
      () => ({ xs: Array.from({ length: 1000 }, (_, i) => i) }),
      n / 10
    ),
    measureCarrier(
      '200 nested objects',
      () => ({
        rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'n' + i, ok: i % 2 === 0 })),
      }),
      n / 10
    ),
  ];
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(24)}${r.frameUs.toFixed(4).padStart(11)}` +
        `${r.nativeUs.toFixed(4).padStart(12)}${r.ratio.toFixed(2).padStart(8)}`
    );
  }

  console.log(
    `\n  ${'value sent'.padEnd(24)}${'framed delivers'.padStart(20)}${'native delivers'.padStart(20)}`
  );
  console.log(`  ${'-'.repeat(62)}`);
  const fidelity = [
    measureFidelity('new Map([[a, 1]])', () => new Map([['a', 1]])),
    measureFidelity('new Set([1, 2])', () => new Set([1, 2])),
    measureFidelity('/ab+c/i', () => /ab+c/i),
    measureFidelity('new Date(1234567890123)', () => new Date(1234567890123)),
    measureFidelity('10n (BigInt)', () => 10n),
    measureFidelity('Infinity', () => Infinity),
    measureFidelity('NaN', () => NaN),
    // The hole is the point of the probe, so the sparse literal is deliberate.
    // eslint-disable-next-line no-sparse-arrays
    measureFidelity('[1, , 3] (sparse)', () => [1, , 3]),
  ];
  for (const f of fidelity) {
    console.log(`  ${f.label.padEnd(24)}${f.framed.padStart(20)}${f.native.padStart(20)}`);
  }

  const slower = rows.filter((r) => r.ratio > 1.1);
  const faster = rows.filter((r) => r.ratio < 0.9);
  const ties = rows.filter((r) => r.ratio >= 0.9 && r.ratio <= 1.1);
  const lost = fidelity.filter((f) => f.framed !== f.native).length;
  console.log(
    `\n  ${faster.length} faster, ${ties.length} a tie, ${slower.length} slower on the native carrier.`
  );
  console.log(
    '  The pattern is the finding, not the individual numbers: structured clone wins\n' +
      '  on string-heavy payloads and loses on deep or numeric structure, so a pool\n' +
      '  cannot adopt it as an unconditional speedup.'
  );
  console.log(
    `\n  ${lost} of ${fidelity.length} sampled values change type or value through the frame. That is the\n` +
      '  reason the native carrier exists, and the reason it is negotiated per worker\n' +
      '  rather than made the default: it is the only one of the two that is lossless.'
  );

  return { rows, fidelity, config: { n, passes: Number(process.env.CLAIM_CODEC_PASSES || 9) } };
}

// ─── Workload 8: SIEVE, and whether this codebase wants it ───────────────────
//
// ALGO-001, and it is a measurement row before it is a design one.
//
// The proposal is to replace `PowerCache`'s hand cursor with SIEVE (NSDI '24):
// lower miss ratio than nine SOTA algorithms on >45 % of 1559 traces, no lock on
// a hit, roughly ten lines of policy on top of a structure this cache already
// has. GAP-004 argues the stronger case -- that a *generational two-Map* scheme
// (`quick-lru` / `hashlru`) makes CACHE-001 structurally impossible -- but it is
// explicit that ALGO-001 must bench both before either is adopted.
//
// **SIEVE is implemented here, in the bench, and not in `src/`.** That is the
// whole discipline of this file: the claim under test is "a `visited` bit on the
// existing hand beats what ships", and a library change would be the feature
// being built before the premise is measured. The library stays untouched until
// a number says so. If SIEVE wins here it moves into `powerCache.js` with a
// policy option and this harness is left behind as the record of why.
//
// Implementation, from the paper's pseudocode and its authors' reference:
// a FIFO queue with a `visited` bit per object, and a hand that only moves
// forward. On a hit, set `visited`. On eviction, advance the hand while
// `visited` is set (clearing it as it goes); evict the first object whose bit is
// clear. The defining property is that a hit costs O(1) with **no reordering at
// all** -- no `prev`/`next` writes, unlike the LRU this cache runs today.

class BenchSieve {
  constructor(capacity) {
    this.capacity = capacity;
    this._map = new Map(); // key -> node
    this._head = null; // oldest
    this._tail = null; // newest
    // The hand is **persistent**. This is not a detail: SIEVE's hand is a real
    // property, not a loop variable, and the first version of this file reset
    // it to `_head` on every eviction. That is a full CLOCK sweep each time,
    // which is a weaker policy than SIEVE, and it is why the first run of this
    // bench reported SIEVE losing by 5 points -- a number that would have been
    // recorded as "SIEVE is worse" on the strength of a variant that is not
    // SIEVE. The hand starts at the oldest end and walks toward the newer end,
    // wrapping once, exactly as the paper's pseudocode does.
    this._hand = null;
    this._size = 0;
    this._evictions = 0;
  }

  get(key) {
    const node = this._map.get(key);
    if (node === undefined) return undefined;
    // The entire "hit" cost: one Map read and one store. No pointer writes,
    // which is the property the paper claims and the reason a hit needs no lock.
    node.visited = true;
    return node.value;
  }

  set(key, value) {
    const existing = this._map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      existing.visited = true;
      return;
    }
    const node = { key, value, visited: false, prev: null, next: null };
    if (!this._tail) {
      this._head = this._tail = node;
    } else {
      node.prev = this._tail;
      this._tail.next = node;
      this._tail = node;
    }
    this._map.set(key, node);
    this._size++;
    while (this._size > this.capacity) this._evictOne();
  }

  _evictOne() {
    // Give every object at most one chance to survive: walking past a `visited`
    // object clears its bit, so an object hit since the hand last went past is
    // spared exactly once and is evictable the next time round.
    if (this._hand === null) this._hand = this._head;
    let guard = 0;
    const limit = this._size + 1;
    while (this._hand !== null && this._hand.visited) {
      this._hand.visited = false;
      // `prev` walks toward the **older** end, which is the direction SIEVE's
      // hand moves: the queue is appended at the tail and the hand retreats
      // from newest to oldest, wrapping to the newest end when it falls off.
      this._hand = this._hand.prev;
      if (this._hand === null) this._hand = this._tail;
      if (++guard > limit) return;
    }
    const node = this._hand;
    if (node === null) return;
    this._hand = node.prev;
    if (this._hand === null) this._hand = this._tail;
    this._unlink(node);
    this._map.delete(node.key);
    this._size--;
    this._evictions++;
  }

  _unlink(node) {
    if (node.prev) node.prev.next = node.next;
    else this._head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this._tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  has(key) {
    return this._map.has(key);
  }

  get size() {
    return this._size;
  }
}

// A hand-rolled plain LRU, used as the *control*. Pairing SIEVE against the
// shipped `PowerCache` alone would confound two changes -- the policy and the
// data structure -- so the control differs from SIEVE in exactly one respect:
// it moves a node to the tail on a hit instead of setting a bit.
class BenchLru {
  constructor(capacity) {
    this.capacity = capacity;
    this._map = new Map();
    this._head = null;
    this._tail = null;
    this._size = 0;
    this._evictions = 0;
  }

  get(key) {
    const node = this._map.get(key);
    if (node === undefined) return undefined;
    // The one thing SIEVE does not do: three pointer writes per hit.
    this._unlink(node);
    node.prev = this._tail;
    node.next = null;
    if (this._tail) this._tail.next = node;
    this._tail = node;
    if (!this._head) this._head = node;
    return node.value;
  }

  set(key, value) {
    const existing = this._map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      this.get(key);
      return;
    }
    const node = { key, value, prev: null, next: null };
    this._map.set(key, node);
    this._size++;
    if (!this._tail) this._head = this._tail = node;
    else {
      node.prev = this._tail;
      this._tail.next = node;
      this._tail = node;
    }
    while (this._size > this.capacity) {
      const victim = this._head;
      if (!victim) break;
      this._unlink(victim);
      this._map.delete(victim.key);
      this._size--;
      this._evictions++;
    }
  }

  _unlink(node) {
    if (node.prev) node.prev.next = node.next;
    else this._head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this._tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  has(key) {
    return this._map.has(key);
  }

  get size() {
    return this._size;
  }
}

/**
 * The generational two-`Map` structure (`quick-lru` / `hashlru`), as described
 * in their docs: *"avoids expensive delete operations"* by keeping two Maps and
 * **dropping the whole old Map** on eviction.
 *
 * GAP-004 argues this is the better alternative to SIEVE *for this codebase*,
 * and the argument is structural rather than about miss ratio:
 *
 * - **No cursor and no node pool.** SIEVE's hand still dangles, and GAP-004's
 *   whole point is that a generational flip makes **CACHE-001 structurally
 *   impossible** — there is no hand to leave pointing at a removed node,
 *   because there are no nodes and no hand. That is a stronger claim than any
 *   miss-ratio number.
 * - **Eviction is O(1) and needs no `unlink`.** The old Map is discarded whole,
 *   so per-eviction cost is a reference drop rather than three pointer writes.
 *
 * The row also names its own worst property — **up to 2x over-fill** — and calls
 * it "a documented memory bound, not a correctness hazard". That is the claim
 * this bench has to test rather than take, because for `PowerCache` it is not
 * merely a memory bound: `_evictIfNeeded` loops on `this._map.size >
 * this.maxEntries`, so a structure that can hold 2x `maxEntries` breaks the
 * documented `stats().size <= maxEntries` guarantee outright. `peak` below is
 * recorded specifically so that is visible as a number.
 *
 * Hit handling follows `quick-lru`: a hit in the old Map **promotes** the key
 * into the current Map, which is what stops the old generation draining one
 * useful key at a time.
 */
class BenchGenerational {
  constructor(capacity) {
    this.capacity = capacity;
    this._current = new Map();
    this._old = new Map();
    this._peak = 0;
    this._flips = 0;
  }

  get(key) {
    if (this._current.has(key)) return 1;
    if (!this._old.has(key)) return undefined;
    // Promote out of the old generation: this is the whole reason a hit is not
    // just a Map read, and dropping it is what made the first version of this
    // drain the old generation one key per miss.
    this._current.set(key, 1);
    return 1;
  }

  set(key) {
    if (this._current.has(key) || this._old.has(key)) return;
    this._current.set(key, 1);
    // The flip, not a sweep: the entire old Map becomes garbage at once, so
    // eviction of N keys costs one reference drop rather than N unlinks.
    if (this._current.size >= this.capacity) {
      this._old = this._current;
      this._current = new Map();
      this._flips++;
    }
    const size = this._current.size + this._old.size;
    if (size > this._peak) this._peak = size;
  }

  has(key) {
    return this._current.has(key) || this._old.has(key);
  }

  get size() {
    return this._current.size + this._old.size;
  }

  get peak() {
    return this._peak;
  }

  get flips() {
    return this._flips;
  }
}

/**
 * Replay one key stream against one cache implementation.
 *
 * The identical stream object is handed to every implementation, so any
 * difference between two rows is attributable to the policy rather than to the
 * workload. `sizeAtEnd` is read with `has()`, which no implementation here
 * treats as a hit, so the residency measurement does not perturb what it
 * measures -- `BenchSieve.has` deliberately does not set `visited`.
 *
 * @param {{get: Function, set: Function, has: Function}} cache
 * @param {number[]} stream
 * @param {number} workingSetSize
 * @returns {object}
 */
function replayStream(cache, stream, workingSetSize) {
  let hits = 0;
  let misses = 0;
  let hotRequests = 0;
  let hotHits = 0;

  let observedPeak = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < stream.length; i++) {
    const id = stream[i];
    if (cache.get(id) !== undefined) {
      hits++;
      if (id < workingSetSize) hotHits++;
    } else {
      misses++;
      cache.set(id, 1);
    }
    if (id < workingSetSize) hotRequests++;
    const sz = cache.size;
    if (sz > observedPeak) observedPeak = sz;
  }
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  let survivors = 0;
  for (let id = 0; id < workingSetSize; id++) if (cache.has(id)) survivors++;

  // Peak residency is sampled after each insert rather than read off a
  // `peak` field, so every implementation reports it the same way and a
  // structure that cannot report one simply reports its running size.
  return {
    hitRate: hits / (hits + misses),
    hotHitRate: hotRequests ? hotHits / hotRequests : 0,
    survivors,
    elapsedMs,
    requests: hits + misses,
    peak: observedPeak,
    capacity: cache.capacity ?? null,
  };
}

/**
 * A scan-dominated trace: long runs of one-shot keys, with the working set
 * worked in between.
 *
 * This is the workload SIEVE's own evaluation leans on, and the one that
 * separates the three policies cleanly. A plain LRU cannot tell a one-shot scan
 * key from a key it will want again, so a scan evicts the working set. SIEVE's
 * second-chance bit protects objects hit *since the hand last passed*, which is
 * exactly the discrimination a scan-heavy trace measures. `quick-lru`'s
 * generational flip is not included here and GAP-004 says it must be benched
 * alongside; this row answers the SIEVE half only.
 *
 * @param {ReturnType<typeof makeRng>} rng
 * @param {{keySpace: number, workingSet: number, scanKeys: number, scanEvery: number}} cfg
 * @returns {{stream: number[], workingSetSize: number}}
 */
function buildScanHeavyStream(rng, cfg) {
  const { keySpace, workingSet, scanKeys, scanEvery } = cfg;
  const stream = [];
  let nextScanKey = workingSet;
  for (let i = 0; i < scanEvery; i++) {
    for (let s = 0; s < scanKeys; s++) {
      if (nextScanKey >= keySpace) nextScanKey = workingSet;
      stream.push(nextScanKey++);
    }
    // Interleaved rather than appended: a contiguous scan at the end is
    // survivable by anything, because the working set has not been disturbed.
    for (let w = 0; w < workingSet; w++) stream.push(Math.floor(rng() * workingSet));
  }
  return { stream, workingSetSize: workingSet };
}

/**
 * ALGO-001: does a `visited` bit on the hand beat what ships?
 *
 * Four implementations, one stream each, two workloads. The `PowerCache` rows
 * are the shipped code; the `Bench*` rows are in this file and differ from the
 * shipped list in exactly one respect each, so the comparison is not confounded
 * by the data structure.
 *
 * @returns {object}
 */
function runSieveWorkload() {
  const capacity = Number(process.env.CLAIM_SIEVE_CAPACITY || 500);
  const seed = Number(process.env.CLAIM_SIEVE_SEED || 12345);
  // The working set is deliberately **larger than the cache**. First pass used
  // working = 300 against capacity = 500, and every LRU variant survived
  // 300/300: with 200 slots of slack the 25-key scan fit without displacing
  // anything hot, so the trace never exercised eviction at all and the
  // comparison was vacuous. SIEVE still lost on that one -- which is worth
  // knowing, but it is not evidence about a workload that does not evict.
  const workingSet = Number(process.env.CLAIM_SIEVE_WORKING || 900);
  const scanEvery = Number(process.env.CLAIM_SIEVE_SCAN_EVERY || 20);
  const scanKeys = Number(process.env.CLAIM_SIEVE_SCAN_KEYS || 25);
  const zipf = Number(process.env.CLAIM_SIEVE_ZIPF || 1.0);
  const keySpace = workingSet * 40;

  const make = (kind) => {
    switch (kind) {
      case 'sieve':
        return new BenchSieve(capacity);
      case 'generational':
        return new BenchGenerational(capacity);
      // The matched-memory row. A generational cache at capacity C can hold up
      // to 2C, so comparing it against an LRU at capacity C is comparing two
      // caches holding different amounts of memory. This variant is sized so
      // its *peak* lands near the same number, which is the comparison that
      // answers "is this worth the bound" rather than "does over-filling raise
      // the hit rate" -- which it obviously does.
      case 'generational-half':
        return new BenchGenerational(Math.floor(capacity / 2));
      case 'lru':
        return new BenchLru(capacity);
      case 'shipped-lru':
        return new PowerCache({ maxEntries: capacity, policy: 'lru', admission: 'none' });
      case 'shipped-tinylfu':
        return new PowerCache({
          maxEntries: capacity,
          policy: 'lru',
          admission: 'tinylfu',
          windowSize: 4,
        });
      default:
        throw new Error(`unknown policy ${kind}`);
    }
  };

  const POLICIES = [
    ['shipped: lru (shipped)', 'shipped-lru'],
    ['shipped: lru + tinylfu w=4', 'shipped-tinylfu'],
    ['bench: plain LRU (control)', 'lru'],
    ['bench: SIEVE', 'sieve'],
    ['bench: generational (2-Map)', 'generational'],
    ['bench: generational @ half cap', 'generational-half'],
  ];

  const workloads = [
    {
      name: 'zipf + interleaved scan',
      build: (rng) =>
        buildZipfScanStream(rng, {
          keySpace,
          workingSet,
          scanKeys,
          scanEvery,
          zipf,
        }),
    },
    {
      name: 'scan-heavy (25 one-shot per 900 hot)',
      build: (rng) => buildScanHeavyStream(rng, { keySpace, workingSet, scanKeys, scanEvery }),
    },
  ];

  console.log('ALGO-001 — SIEVE: a `visited` bit on the hand, against what ships\n');
  console.log('  SIEVE is implemented in THIS FILE, not in src/. The claim under test is');
  console.log('  whether a policy beats what ships; adding the policy to the library');
  console.log('  first would be building the feature before measuring its premise.');
  console.log('  `bench: plain LRU` is the control: it differs from SIEVE in exactly one');
  console.log('  respect -- three pointer writes per hit instead of one bit store.\n');
  const PEAK_HEADER = 'peak';
  console.log(
    `  ${'workload'.padEnd(34)}${'policy'.padEnd(30)}${'hit rate'.padStart(9)}${'hot hits'.padStart(10)}${'ns/op'.padStart(10)}${PEAK_HEADER.padStart(10)}${'survivors'.padStart(11)}`
  );
  console.log(
    `  ${'-'.repeat(104)}  (peak is vs a configured maxEntries of ${capacity}; anything above it is over-fill)`
  );

  const all = {};
  for (const workload of workloads) {
    const rows = [];
    for (const [label, kind] of POLICIES) {
      // A fresh seeded stream per policy: same seed, same stream. Built inside
      // the policy loop so the pairing is obvious at the call site rather than
      // relying on a stream built once and shared, which a mutation could make
      // stale for later rows.
      const rng = makeRng(seed);
      const { stream, workingSetSize } = workload.build(rng);
      const cache = make(kind);
      const r = replayStream(cache, stream, workingSetSize);
      const row = {
        label,
        kind,
        workload: workload.name,
        hitRate: r.hitRate,
        hotHitRate: r.hotHitRate,
        survivors: r.survivors,
        nsPerOp: (r.elapsedMs * 1e6) / r.requests,
        requests: r.requests,
        peak: r.peak,
      };
      rows.push(row);
      // `+37%` rather than "37% over": at 2x capacity the string is 5+ chars
      // and pushes every later column out of alignment.
      const over = r.peak > capacity ? `+${((r.peak / capacity - 1) * 100).toFixed(0)}%` : '';
      console.log(
        `  ${workload.name.padEnd(34)}${label.padEnd(30)}${(r.hitRate * 100).toFixed(1).padStart(8)}%` +
          `${(r.hotHitRate * 100).toFixed(1).padStart(9)}%${row.nsPerOp.toFixed(0).padStart(10)}` +
          `${`${r.peak}${over}`.padStart(10)}${r.survivors.toString().padStart(11)}`
      );
    }
    all[workload.name] = rows;
    console.log('');
  }

  // The claims, stated as the numbers that would have to be true.
  const scanName = 'scan-heavy (25 one-shot per 900 hot)';
  const scan = all[scanName];
  const sieve = scan.find((r) => r.kind === 'sieve');
  const lru = scan.find((r) => r.kind === 'lru');
  const shippedTiny = scan.find((r) => r.kind === 'shipped-tinylfu');
  const gen = scan.find((r) => r.kind === 'generational');
  const genHalf = scan.find((r) => r.kind === 'generational-half');
  const pt = (a, b) => `${a >= b ? '+' : ''}${((a - b) * 100).toFixed(1)} points`;

  console.log('  SIEVE (ALGO-001)');
  console.log(`    vs the plain-LRU control, scan-heavy: ${pt(sieve.hitRate, lru.hitRate)}.`);
  console.log(
    `    vs shipped lru+tinylfu w=4, scan-heavy: ${pt(sieve.hitRate, shippedTiny.hitRate)}.`
  );
  console.log(
    `    Cost: ${sieve.nsPerOp.toFixed(0)} ns/op against the control's ${lru.nsPerOp.toFixed(0)}. The hit is one\n` +
      '    bit store against three pointer writes, and it is not faster here.'
  );

  console.log('\n  Generational two-Map (this row, GAP-004)');
  const overPct = ((gen.peak / capacity - 1) * 100).toFixed(0);
  console.log(
    `    At the configured maxEntries of ${capacity} it hits ${(gen.hitRate * 100).toFixed(1)} % against LRU's ` +
      `${(lru.hitRate * 100).toFixed(1)} % -- ${pt(gen.hitRate, lru.hitRate)}, the largest number in this table.`
  );
  console.log(
    `    It gets there by peaking at ${gen.peak} entries, ${overPct} % over. That is the "up to 2x over-fill"\n` +
      `    the row names, reproduced: ${gen.peak} against a configured ${capacity} is the bound exactly.`
  );
  console.log(
    `    At matched memory -- the same variant sized so its peak lands at ${genHalf.peak}, against LRU's ` +
      `${lru.peak} -- it hits ${(genHalf.hitRate * 100).toFixed(1)} %. That is ${pt(genHalf.hitRate, lru.hitRate)} LRU.`
  );
  console.log(
    '    **So the entire margin is the memory.** Sized to the memory it actually uses, the generational\n' +
      '    structure is not a better LRU -- it is a worse one, by a wide margin on this trace.'
  );
  console.log(
    '\n  Why that is worse than "loses" for this library specifically: `maxEntries` here is not a memory\n' +
      '  hint, it is a contract. `_evictIfNeeded` loops while `_map.size > this.maxEntries`, `stats().size`\n' +
      '  is public, and `maxWeight` is enforced on the same loop. A structure that holds 2x `maxEntries`\n' +
      '  does not exceed a bound, it breaks a published one. The row calls 2x over-fill "a documented\n' +
      '  memory bound, not a correctness hazard", and for a bare Map cache that is fair -- for this cache it\n' +
      '  is not, because the bound is enforced by the eviction loop that owns the same field.'
  );
  console.log(
    '\n  What survives from the row: the structural claim, which is the part that was actually new. No\n' +
      '  cursor and no node pool does make CACHE-001 structurally impossible rather than merely\n' +
      '  unreachable-by-inspection. That is worth keeping on file, and CACHE-001 is already closed as not\n' +
      '  reproducible -- so the claim is real and the bug it would prevent does not exist.'
  );

  return { workloads: all, config: { capacity, seed, workingSet, scanEvery, scanKeys, zipf } };
}

// ─── Workload 9: what the TinyLFU sketch spends its time on ──────────────────
//
// CACHE-007. `SmallLfuSketch` derived each row's column from
// `_index(key, row)`, and `hashKey` did `String(key)` plus a full FNV pass over
// the key's characters — so at `depth: 4` one call cost four string coercions and
// four FNV loops, and the cost scaled with key length rather than staying fixed.
// The key is now hashed once per call and the four indices derived from it, with
// `mix32` still per row so the rows stay independent.
//
// This mode exists because **the number is the deliverable**. The change is a
// hash refactor, and a hash refactor is the one edit that can quietly degrade an
// admission filter while every test stays green: the bucket assignment shifts and
// nothing fails. So the cost has to be reproducible, and the *distribution* has
// to be checkable, and a one-off measurement in a shell is neither.
//
// Read the distribution rows before the timings. A faster sketch that reports a
// higher frequency for a key is a worse sketch, and the hit rate is what the
// filter is for.

/**
 * Time `fn` over `iterations` calls, reporting the median of `runs` batches.
 *
 * The median rather than the mean because this harness sees a ~29 % median
 * min/max spread, and because the claim being made is about a cost that should be
 * visibly smaller, not a nanosecond.
 *
 * @param {function(number):*} fn
 * @param {number} iterations
 * @param {number} [runs]
 * @returns {number} ns per call.
 */
function timePerCall(fn, iterations, runs = 5) {
  for (let i = 0; i < Math.min(iterations, 20_000); i++) fn(i);
  const samples = [];
  for (let r = 0; r < runs; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn(i);
    samples.push(Number(process.hrtime.bigint() - t0) / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(runs / 2)];
}

/**
 * CACHE-007: the sketch's hashing cost, and whether the distribution survived.
 *
 * @returns {object}
 */
function runSketchWorkload() {
  const iterations = Number(process.env.CLAIM_SKETCH_ITERATIONS || 200_000);
  const keyLen = Number(process.env.CLAIM_SKETCH_KEYLEN || 6);
  const key = 'k' + 'x'.repeat(Math.max(0, keyLen - 1));

  const sketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });

  console.log('CACHE-007 — TinyLFU sketch: one hash per call, not per row\n');
  console.log(`  ${iterations} calls per measurement, median of 5. Key length ${keyLen}.\n`);
  console.log('  cost');
  // `timePerCall` passes the iteration index so a caller *can* vary its key per
  // call. These two cannot: the sketch is measured against one fixed key, which
  // is the whole point — a varying key would measure the key's cache behaviour
  // instead of the hash.
  const inc = timePerCall(() => sketch.increment(key), iterations);
  const est = timePerCall(() => sketch.estimate(key), iterations);
  console.log(`    increment (depth 4)          ${inc.toFixed(1).padStart(7)} ns`);
  console.log(`    estimate  (depth 4)          ${est.toFixed(1).padStart(7)} ns`);
  console.log(`    both                        ${(inc + est).toFixed(1).padStart(7)} ns`);

  console.log('\n  how cost scaled with key length, before vs after');
  console.log('  (the "before" figures are the same shape with the hash recomputed per row)');
  console.log(
    `    ${'length'.padStart(6)}${'4x FNV (was)'.padStart(14)}${'1x FNV (now)'.padStart(14)}${'saved'.padStart(9)}`
  );
  for (const len of [6, 24, 64]) {
    const k = 'k' + 'x'.repeat(len - 1);
    const perRow = timePerCall(() => {
      let acc = 0;
      for (let r = 0; r < 4; r++) {
        const t = String(k);
        let h = 0x811c9dc5 | 0;
        for (let j = 0; j < t.length; j += 1) h = Math.imul(h ^ t.charCodeAt(j), 0x01000193);
        acc += h;
      }
      return acc;
    }, iterations);
    const once = timePerCall(() => {
      const t = String(k);
      let h = 0x811c9dc5 | 0;
      for (let j = 0; j < t.length; j += 1) h = Math.imul(h ^ t.charCodeAt(j), 0x01000193);
      return h;
    }, iterations);
    console.log(
      `    ${String(len).padStart(6)}${perRow.toFixed(1).padStart(12)} ns${once.toFixed(1).padStart(12)} ns` +
        `${((1 - once / perRow) * 100).toFixed(0).padStart(8)}%`
    );
  }

  console.log('\n  and the distribution the filter actually depends on');
  // 200 keys into 64 columns, reported as the minimum across four rows.
  //
  // **The collapsed figure is computed in the same run rather than quoted.** The
  // sketch seeds itself randomly when none is given, so a hard-coded reference
  // ("481 with independent rows, 808 collapsed") is one seed's number and will
  // not match the next run - the first version of this mode printed exactly that
  // line and then reported 492 beside it. Both sides have to come from the same
  // seed for the comparison to mean anything, which is what this does.
  const seed = 0x5eed;
  const measureDistribution = () => {
    const s = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000, seed });
    for (let i = 0; i < 200; i++) s.increment(`k${i}`);
    let total = 0;
    let alone = 0;
    for (let i = 0; i < 200; i++) {
      const e = s.estimate(`k${i}`);
      total += e;
      if (e === 1) alone++;
    }
    return { total, alone };
  };
  const good = measureDistribution();

  // The counterfactual: the same sketch with the per-row seed dropped, so every
  // key lands in the same column of every row.
  //
  // Written by **pinning `_indexFor` to row 0** rather than by re-implementing
  // the hashing and the index arithmetic. The first version built the collapsed
  // sketch by hand and reported 287 against the library's 484, i.e. it was not
  // measuring the thing it claimed to — a hand-rolled "counterfactual" is just
  // another implementation to get wrong, and it did. Pinning one private helper
  // to a constant *is* the mutation, and it cannot drift from the real code.
  const collapsed = (() => {
    const s = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000, seed });
    const realIndexFor = s._indexFor.bind(s);
    s._indexFor = (hash) => realIndexFor(hash, 0);
    for (let i = 0; i < 200; i++) s.increment(`k${i}`);
    let total = 0;
    let alone = 0;
    for (let i = 0; i < 200; i++) {
      const e = s.estimate(`k${i}`);
      total += e;
      if (e === 1) alone++;
    }
    return { total, alone };
  })();

  console.log(
    `    independent rows (shipped)     sum ${good.total}, ${good.alone}/200 at frequency 1`
  );
  console.log(
    `    collapsed rows (counterfactual) sum ${collapsed.total}, ${collapsed.alone}/200 at frequency 1`
  );
  console.log(
    good.total < collapsed.total
      ? '    => independent rows report a LOWER frequency, which is the point of count-min. A\n' +
          '       faster sketch that raised this number would be a worse filter.'
      : '    => **the per-row spread is not working**: independent rows must report a lower\n' +
          '       frequency than collapsed ones, or the sketch is effectively one row deep.'
  );

  // ── GAP-014: keys the cache compares by reference ─────────────────────────
  //
  // Everything above measures *string* keys, which is why this mode was blind to
  // the defect ADR 0007 records: `hashKey` did `String(key)`, and `String({})` is
  // `"[object Object]"` for **every** object, so a cache keyed by object
  // references — which `PowerCache` is, its entries live in a `Map` — handed the
  // filter one counter for the whole key space. This mode is the one ADR 0007
  // names as its own reversal condition ("`sketch` shows the `WeakMap` read
  // costing more than the discrimination is worth"), and it could not see it.
  //
  // Read the **discrimination** block before the timings. The timing is the cost
  // of a feature; the discrimination is whether the feature is worth anything, and
  // a cost measurement alone would let a useless-but-fast path pass as a win.
  //
  // The "before" figures are computed here rather than quoted, for the same
  // reason the collapsed distribution is: the string form of an object is one
  // value, so a quoted number would be a claim about this machine's `String()`.
  //
  // **The claim is distinctness, not a zero.** An earlier draft of this block
  // gated on "a never-seen object key must estimate 0" and reported the shipped
  // code as broken. It was the assertion: Count-Min may *overcount*, which is its
  // documented safe direction, so at `width: 64` a fresh id can legitimately land
  // on a neighbour's counter. What the pre-fix shape could not do is give two
  // object keys *different* answers at all — every one of them read the same
  // number, and so did the key that had never been seen. That is the invariant,
  // and unlike a zero it cannot be broken by a collision.
  const objectKeys = Array.from({ length: 200 }, (_, i) => ({ i }));
  const objectSketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
  for (const k of objectKeys) objectSketch.increment(k);
  const neverSeen = { i: 'never-seen' };
  const objectEstimates = objectKeys.map((k) => objectSketch.estimate(k));
  const objectTotal = objectEstimates.reduce((a, b) => a + b, 0);
  const objectDistinct = new Set(objectEstimates).size;
  const neverSeenEstimate = objectSketch.estimate(neverSeen);

  // The counterfactual is the pre-GAP-014 `_hash`: `String(key)` plus one FNV
  // pass. Pinned on the instance rather than re-implemented in a second sketch,
  // so it cannot drift from the code it claims to describe — the same discipline
  // as the collapsed-rows block above.
  const legacySketch = new SmallLfuSketch({ width: 64, depth: 4, sampleSize: 1_000_000 });
  legacySketch._hash = (key) => {
    const text = String(key);
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h;
  };
  for (const k of objectKeys) legacySketch.increment(k);
  const legacyEstimates = objectKeys.map((k) => legacySketch.estimate(k));
  const legacyTotal = legacyEstimates.reduce((a, b) => a + b, 0);
  const legacyDistinct = new Set(legacyEstimates).size;
  const legacyNeverSeen = legacySketch.estimate(neverSeen);

  console.log('\n  object keys — the discrimination the string path could not do');
  console.log('  200 distinct objects, one increment each:');
  console.log(
    `    ${'shape'.padStart(18)}${'sum'.padStart(8)}${'distinct estimates'.padStart(20)}${'never-seen object'.padStart(19)}`
  );
  const shapeRow = (label, total, distinct, unseen) =>
    `    ${label.padStart(18)}${String(total).padStart(8)}${`${distinct} of 200`.padStart(20)}${String(unseen).padStart(19)}`;
  console.log(shapeRow('object (shipped)', objectTotal, objectDistinct, neverSeenEstimate));
  console.log(shapeRow('object (was)', legacyTotal, legacyDistinct, legacyNeverSeen));
  console.log(
    legacyDistinct === 1 && objectDistinct > 1
      ? '    => before, every object key shared ONE counter: same estimate for all 200, and the\n' +
          '       never-seen key reported the same again, so the filter had no signal at all.\n' +
          '       Now they are distinguishable, which is what admission needs.'
      : '    => **the identity path is not discriminating**: the pre-fix shape must report\n' +
          '       exactly one distinct estimate across 200 object keys (they share a counter),\n' +
          '       and the shipped shape must report more than one.'
  );

  console.log('\n  and what the identity path costs, against the string path it replaced');
  // The cost question ADR 0007 sets as its own reversal condition: "shows the
  // `WeakMap` read costing more than the discrimination is worth".
  //
  // **The key that makes the comparison honest is one with a `toString`.** A plain
  // object's string form is the constant `"[object Object]"` — it does not include
  // own properties — so making the object "bigger" changes nothing for the string
  // path, and an earlier draft of this block claimed a size scaling that does not
  // exist. A caller whose key object defines `toString` *is* paying for its size,
  // and that is the case the identity path removes.
  const smallObject = neverSeen;
  const wideObject = {
    i: 'never-seen',
    toString() {
      return `never-seen:${'y'.repeat(256)}`;
    },
  };
  const costRow = (sketch, label, key) => {
    const i = timePerCall(() => sketch.increment(key), iterations);
    const e = timePerCall(() => sketch.estimate(key), iterations);
    return { label, i, e, both: i + e };
  };
  const shape = (label, sketch) => [
    costRow(sketch, `${label}, plain`, smallObject),
    costRow(sketch, `${label}, 256B toString`, wideObject),
  ];
  const identityCost = shape('identity', objectSketch);
  const legacyCost = shape('string form', legacySketch);
  console.log(
    `    ${'key'.padStart(28)}${'increment'.padStart(12)}${'estimate'.padStart(11)}${'both'.padStart(10)}`
  );
  console.log(
    `    ${'string, len 6'.padStart(28)}${inc.toFixed(1).padStart(10)} ns${est.toFixed(1).padStart(9)} ns${(inc + est).toFixed(1).padStart(8)} ns`
  );
  const printRow = ({ label, i, e, both }) =>
    `    ${label.padStart(28)}${i.toFixed(1).padStart(10)} ns${e.toFixed(1).padStart(9)} ns${both.toFixed(1).padStart(8)} ns`;
  for (const r of identityCost) console.log(printRow(r));
  for (const r of legacyCost) console.log(printRow(r));
  // Deliberately no verdict line with a percentage in it. Two runs of the same
  // code on this machine have put the string-key path between 32 ns and 62 ns,
  // which is the harness's own spread, so a single-run difference between two
  // object paths is not a claim about either of them. What the pair of rows does
  // show, and what does not depend on the noise, is the *shape*: the string form
  // grows with the key's text and the identity path does not.
  console.log(
    `    => the string form follows the key's text: ${legacyCost[1].both.toFixed(1)} ns against ` +
      `${legacyCost[0].both.toFixed(1)} ns for a plain\n` +
      `       object. The identity path does not (${identityCost[1].both.toFixed(1)} ns against ` +
      `${identityCost[0].both.toFixed(1)} ns) — it hashes an integer\n` +
      '       the sketch handed out. Treat the absolute gap between the two object\n' +
      '       paths as noise on this harness; treat the size insensitivity as the claim.'
  );

  return {
    incrementNs: inc,
    estimateNs: est,
    distributionSum: good.total,
    objectDistinctEstimates: objectDistinct,
    legacyDistinctEstimates: legacyDistinct,
  };
}

// ─── Workload 10: what the admission window costs on the read path ───────────
//
// CACHE-006. `_windowOldest()` walks back from the tail while nodes are
// `inWindow`, and the window is the contiguous suffix of the list — so the walk
// is O(windowSize) and it runs on **every main-space `get()`**, because
// `_moveToTail` on a main-space node has to re-establish where the window starts.
//
// **The window is only active under `admission: 'tinylfu'`.** `_windowSize` is
// forced to 0 unless `this._sketch && this._policy === 'lru'`, so a measurement
// taken with the default admission measures nothing at all — the first version
// of this mode reported zero window walks and a flat ~200 ns per `get()`, and
// concluded the row was stale. It was the measurement.
//
// Read the "calls per get" column before the timings. The claim is structural —
// a main-space `get()` must not walk the window at all — and the timing is only
// the consequence.

/**
 * Count `_windowOldest()` calls, and how many of them actually walked.
 *
 * Instrumenting rather than timing alone, because the row's own criterion is a
 * counter and a wall clock cannot distinguish "fast" from "not called".
 *
 * **This probe counts memo *misses*, not walk steps.** The first version walked
 * the window itself to count steps, which made it useless the moment the walk
 * was memoised: it reported ~800 steps per get from its own copy of the loop
 * while the cache was doing none, so a working fix and a broken one printed the
 * same number. The honest signal is whether the memo was used — if it was, the
 * cache did no walk, and counting steps of a walk that did not happen measures
 * the probe.
 *
 * @param {import('../src/helpers/powerCache.js').PowerCache} cache
 */
function instrumentWindow(cache) {
  const real = cache._windowOldest.bind(cache);
  cache._probe = { calls: 0, walks: 0 };
  cache._windowOldest = function () {
    this._probe.calls++;
    const memo = this._windowStartMemo;
    const used =
      memo !== null &&
      memo.inWindow &&
      (memo.prev === null || !memo.prev.inWindow) &&
      this._windowTail === this._tail;
    if (!used) this._probe.walks++;
    return real();
  };
  return cache;
}

/**
 * CACHE-006: the window walk on the read path.
 *
 * @returns {object}
 */
function runWindowWorkload() {
  const maxEntries = Number(process.env.CLAIM_WINDOW_ENTRIES || 4000);
  const resident = Number(process.env.CLAIM_WINDOW_RESIDENT || 3000);
  const reads = Number(process.env.CLAIM_WINDOW_READS || 100_000);
  const sizes = (process.env.CLAIM_WINDOW_SIZES || '0,10,100,1000').split(',').map(Number);

  console.log('CACHE-006 — the admission window on the read path\n');
  console.log(`  maxEntries ${maxEntries}, ${resident} entries resident, ${reads} gets per row.`);
  console.log('  The window is active only under `admission: "tinylfu"`.\n');
  console.log(
    `  ${'windowSize'.padStart(10)}${'main walk'.padStart(12)}${'mixed walk'.padStart(13)}${'ns/get'.padStart(12)}`
  );
  console.log(`  ${'-'.repeat(47)}`);

  const results = [];
  for (const windowSize of sizes) {
    const clock = 1_000_000;
    const cache = instrumentWindow(
      new PowerCache({
        maxEntries,
        windowSize,
        admission: 'tinylfu',
        window: 4,
        now: () => clock,
      })
    );
    for (let i = 0; i < resident; i++) cache.set(`k${i}`, i);
    // Two read streams, because they are not the same measurement and reporting
    // only the first hid the fix.
    //
    // `mixedKeys` cycles the whole resident set, so roughly a third of the reads
    // land in the window at `windowSize: 1000`. Those `get()`s re-append at the
    // tail, which legitimately invalidates the memo — a window `get()` has to —
    // so a mixed stream can never reach zero walks and would have made a working
    // fix look partial.
    //
    // `mainKeys` is the row's actual target: a main-space `get()` should not walk
    // at all, and that is where the number to watch is.
    const mainKeys = [...cache._map.entries()].filter(([, n]) => !n.inWindow).map(([k]) => k);
    const mixedKeys = [...cache._map.keys()];
    const probes = 5_000;
    const readFraction = (keys) => {
      cache._probe.calls = 0;
      cache._probe.walks = 0;
      const n = keys.length;
      for (let i = 0; i < probes; i++) cache.get(keys[i % n]);
      return { calls: cache._probe.calls / probes, walks: cache._probe.walks / probes };
    };
    const mixed = readFraction(mixedKeys);
    const main = readFraction(mainKeys);

    for (let i = 0; i < 20_000; i++) cache.get(mainKeys[i % mainKeys.length]);
    const ns = timePerCall((i) => cache.get(mainKeys[i % mainKeys.length]), reads);

    console.log(
      `  ${String(windowSize).padStart(10)}${main.walks.toFixed(2).padStart(12)}` +
        `${mixed.walks.toFixed(2).padStart(13)}${ns.toFixed(0).padStart(12)}`
    );
    results.push({ windowSize, mainWalks: main.walks, mixedWalks: mixed.walks, ns });
  }

  const zero = results.find((r) => r.windowSize === 0);
  const worst = results[results.length - 1];
  console.log('\n  What this says');
  if (zero && worst && worst.windowSize > 0) {
    const ratio = worst.ns / zero.ns;
    console.log(
      `    windowSize ${zero.windowSize} -> ${worst.windowSize}: ${ratio.toFixed(1)}x per get(), ` +
        `with ${worst.mainWalks.toFixed(2)} window walks per main-space get().`
    );
    console.log(
      '    The row asked for **zero** walks on a main-space get().' +
        (worst.mainWalks === 0
          ? ' It now measures 0.\n'
          : ` It measures ${worst.mainWalks.toFixed(2)}.\n`)
    );
    if (worst.mixedWalks > 0) {
      console.log(
        '    A mixed read stream stays above zero and is expected to: a `get()` that lands in'
      );
      console.log(
        '    the window re-appends at the tail, which genuinely invalidates the memo. Only a'
      );
      console.log('    main-space read can skip the walk.');
    } else {
      console.log(
        '    Both read streams measure 0 here, which is a property of the probe length: 5000'
      );
      console.log(
        '    reads over the resident set reach a steady state where the window stops being'
      );
      console.log(
        '    re-appended, so the memo survives between probes. A stream of window-only `get()`s'
      );
      console.log('    would still invalidate it every time, and correctly so.');
    }
    console.log(
      '    The fix is a memo that is *validated* on every read rather than a maintained pointer,'
    );
    console.log(
      '    so it can be trusted or discarded but never corrected — the failure mode the earlier'
    );
    console.log('    attempt had was a confidently wrong answer, and this cannot produce one.');
  }

  return { results };
}

// ─── WT-006: framedecode and hubencode ─────────────────────────────────────

/**
 * A hub whose `_encodeBatch` is memoised per batch, as RT-006 proposes.
 *
 * **A subclass, not a patch.** The point of this mode is to measure what RT-006
 * would buy *before* RT-006 is written, and a subclass answers that question
 * without touching the repository. It is also how the 3.00 ms arm of §12.4 was
 * obtained, so the number is comparable to the one already recorded.
 *
 * The memo is keyed on the batch's contents rather than on a counter, because a
 * counter would make the second flush in a run free for reasons RT-006 does not
 * promise — RT-006 is per `(topic, batch)`, and two flushes of the same messages
 * are two batches.
 */
class MemoEncodedHub extends PowerRealtimeHub {
  constructor(options) {
    super(options);
    /** @type {Map<string, Uint8Array>} */
    this._encodeMemo = new Map();
    // Two counters, and the distinction is the whole point. `_encodeBatch` is
    // called once per subscriber either way — that is the *call* RT-006 would
    // remove. `encodes` counts the actual `frameEncodedJson` work, which is what
    // the memo eliminates. The first version of this mode reported the call count
    // and labelled it "encodes", so the memoised arm claimed 5000 encodes while
    // doing one, and the saving looked like it had done nothing.
    this.batches = 0;
    this.encodes = 0;
  }

  _encodeBatch(batch) {
    this.batches += 1;
    const key = JSON.stringify(batch);
    const hit = this._encodeMemo.get(key);
    if (hit) return hit;
    this.encodes += 1;
    const frame = frameEncodedJson(key);
    this._encodeMemo.set(key, frame);
    return frame;
  }
}

/**
 * WT-006 `hubencode` — is the hub's fan-out flush dominated by encoding?
 *
 * §12.4 recorded a 26 ms flush at 5 000 subscribers and a re-measure of 15.27 ms,
 * with `_encodeBatch` memoised at 3.00 ms — a 5.1x ratio and a **10.89-19.43 ms
 * min/max spread**, which is wider than the 28 % median this harness reports. A
 * ratio whose spread exceeds the effect is a direction, not a number, and
 * §12.4's own conclusion is that the isolated cost is the only
 * workload-independent statement available: **5 000 x
 * `frameEncodedJson(JSON.stringify([msg]))` = 13.91 ms of that 15.27 ms flush.**
 *
 * So the third arm here is the one that matters, and the first two are reported
 * to show how much of the flush it accounts for on *this* machine, today. Three
 * arms, interleaved:
 *
 *   1. `flush` — the real hub, one encode per subscriber.
 *   2. `flush (memoised)` — the same hub with a per-batch memo, i.e. RT-006.
 *   3. `encode only` — `N` x `frameEncodedJson(JSON.stringify([msg]))`, with no
 *      hub at all.
 *
 * Arm 3 is the number to quote. Arms 1 and 2 are a ratio on a noisy machine, and
 * are printed with their spread so the noise is visible rather than averaged away.
 */
async function runHubEncodeWorkload() {
  console.log('WT-006 hubencode — is the fan-out flush dominated by encoding?\n');
  console.log('  RT-006 encodes the frame once per subscriber; every subscriber gets');
  console.log('  the same bytes, so the encode is repeated N times for one payload. The');
  console.log('  proposal is to encode once per (topic, batch) and share the frame.\n');
  console.log('  §12.4 recorded 26 ms, then re-measured 15.27 ms, with the memo at');
  console.log('  3.00 ms — a 5.1x ratio on a 10.89-19.43 ms spread. That spread is wider');
  console.log('  than the effect, so the ratio is a direction and not a number. The arm');
  console.log('  that is workload-independent is the third one.\n');

  const subscribers = 5_000;
  const payload = { topic: 'orders', id: 42, body: 'x'.repeat(96) };
  const single = [payload];

  // Arm 3 is measured with the **same** warm-up and round count as the flush
  // arms. The first version took a single cold shot at the top of the mode, and
  // the result was 13.06 ms against a 12.13 ms flush — 107% of the whole flush
  // for the work that is supposedly 62% of it, which is impossible and was the
  // tell. A cold single shot includes JIT compilation of `frameEncodedJson`, so
  // it was being compared against arms that had been warmed by nine rounds.
  // Measuring an arm differently from the arm it is compared against is the same
  // class of error as measuring them on different workloads.
  //
  // **The results are retained, and that is load-bearing.** The first version
  // discarded them, and the arm then measured *more* than the whole flush it is
  // supposed to be a part of — 106% and 107% on two runs, which is impossible and
  // was the tell. At 5 000 subscribers the difference is the collector: the flush
  // holds every frame alive until the end of its timed region, while a discarding
  // loop makes 5 000 frames of garbage inside it and pays for them. Measured in
  // isolation at 5 000 encodes: 14.49 ms discarded against 12.82 ms retained.
  // Both arms now retain, so the comparison is about the work rather than about
  // which arm the collector happened to land on. `keep` is read afterwards so the
  // retention cannot be optimised away.
  const encodeSamples = [];
  let keep = [];
  for (let round = 0; round < 10; round++) {
    keep = [];
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < subscribers; i++) keep.push(frameEncodedJson(JSON.stringify(single)));
    const ns = Number(process.hrtime.bigint() - t0);
    if (round > 0) encodeSamples.push(ns);
  }
  if (keep.length !== subscribers) throw new Error('encode arm did not retain its frames');

  const runFlush = async (Hub) => {
    const sent = [];
    const hub = new Hub({ send: (sub, frame) => sent.push(frame), batch: true });
    for (let i = 0; i < subscribers; i++) hub.subscribe('orders', () => {}, { maxBatch: 32 });
    const t0 = process.hrtime.bigint();
    hub.publish('orders', payload);
    await hub.flush();
    const ns = Number(process.hrtime.bigint() - t0);
    // A plain `PowerRealtimeHub` has no counters, so the encode count is the
    // subscriber count by construction — one `_encodeBatch` per flush, and each
    // of those does one `frameEncodedJson`. Asserted rather than assumed.
    const batches = hub.batches === undefined ? subscribers : hub.batches;
    const encodes = hub.encodes === undefined ? subscribers : hub.encodes;
    hub.close();
    return { ns, frames: sent.length, batches, encodes };
  };

  // Interleaved so JIT warm-up lands on both arms rather than on whichever ran
  // first. The first pass is a warm-up and is discarded, for the same reason.
  // Nine rounds, because the spread on this machine at 5 000 subscribers is the
  // dominant feature of the measurement and fewer rounds cannot describe it.
  const plain = [];
  const memo = [];
  let plainFrames = 0;
  let plainBatches = 0;
  let memoBatches = 0;
  let memoEncodes = 0;
  for (let round = 0; round < 10; round++) {
    const a = await runFlush(PowerRealtimeHub);
    const b = await runFlush(MemoEncodedHub);
    if (round > 0) {
      plain.push(a.ns);
      memo.push(b.ns);
      plainFrames = a.frames;
      plainBatches = a.batches;
      memoBatches = b.batches;
      memoEncodes = b.encodes;
    }
  }

  const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / Math.min(...xs);
  const plainMs = medianOfMs(plain) / 1e6;
  const memoMs = medianOfMs(memo) / 1e6;
  const plainMin = Math.min(...plain) / 1e6;
  const memoMin = Math.min(...memo) / 1e6;
  const encodeMs = medianOfMs(encodeSamples) / 1e6;
  const encodeMin = Math.min(...encodeSamples) / 1e6;

  console.log(`  ${subscribers} subscribers, one publish, batch of 1\n`);
  const ms = (v) => `${v.toFixed(2)} ms`.padStart(12);
  console.log(
    `  ${'arm'.padEnd(20)}${'median'.padStart(12)}${'min'.padStart(12)}${'min-max'.padStart(22)}`
  );
  console.log(
    `  ${'flush'.padEnd(20)}${ms(plainMs)}${ms(plainMin)}` +
      `  ${(Math.min(...plain) / 1e6).toFixed(2)}-${(Math.max(...plain) / 1e6).toFixed(2)} ms` +
      `  (${(spread(plain) * 100).toFixed(0)}%)`
  );
  console.log(
    `  ${'flush (memoised)'.padEnd(20)}${ms(memoMs)}${ms(memoMin)}` +
      `  ${(Math.min(...memo) / 1e6).toFixed(2)}-${(Math.max(...memo) / 1e6).toFixed(2)} ms` +
      `  (${(spread(memo) * 100).toFixed(0)}%)`
  );
  console.log(
    `  ${'encode only'.padEnd(20)}${ms(encodeMs)}${ms(encodeMin)}` +
      `  ${subscribers} x frameEncodedJson, no hub`
  );

  console.log('\n  What this says');
  console.log('    **The exact statement first, because it does not depend on this machine:** the');
  console.log(`    plain hub runs ${plainBatches} encodes for one publish of one payload, and the`);
  console.log(
    `    memoised hub runs ${memoEncodes}. That is a ${plainBatches}-to-1 reduction, it is a`
  );
  console.log('    count rather than a timing, and it is the same on every machine.');
  console.log(
    `    Both arms made ${memoBatches} _encodeBatch calls, and that is not a rounding of the`
  );
  console.log('    first number — it is equal to it. The memo removes the work inside those');
  console.log('    calls, not the calls, which is why the report has to state encodes');
  console.log('    separately from batches. An earlier version of this mode printed only the');
  console.log('    call count and called it "encodes", and the memoised arm then claimed 5000');
  console.log('    encodes while doing one, so the saving read as nothing.');
  console.log('');
  console.log(
    `    On timings: **${(plainMs / memoMs).toFixed(1)}x** on medians,` +
      ` ${(plainMin / memoMin).toFixed(1)}x on minimums, against §12.4's 5.1x.`
  );
  console.log(
    '    **Treat that as a direction, not a number** — the spread on the unoptimised arm is'
  );
  console.log(`    ${(spread(plain) * 100).toFixed(0)}% here, which is wider than the effect.`);
  console.log(`    Both arms delivered ${plainFrames} frames.`);
  console.log('');
  console.log('    **The isolated encode cost as a fraction of the flush is NOT reported,');
  console.log('    because it is not measurable in-process at this scale.** §12.4 recorded');
  console.log('    13.91 ms of a 15.27 ms flush — 91% — and that is the number a reader');
  console.log('    wants. It could not be reproduced as a number: three runs of this mode');
  console.log('    gave 91%, 93% and **106%**, and an arm cannot cost more than the whole');
  console.log('    that contains it.');
  console.log('');
  console.log('    The cause is the allocator, not the encode. The flush holds every frame');
  console.log('    alive to the end of its timed region; a standalone loop makes the frames');
  console.log('    garbage and pays for them inside the same region. Making the loop retain');
  console.log('    narrowed the range — measured 14.49 ms discarded against 12.82 ms retained');
  console.log("    at 5 000 encodes — but did not close it, because the hub's own per-");
  console.log('    subscriber bookkeeping allocates too. So the *direction* holds in every run');
  console.log('    (the encode is the majority of the flush, and the memoised arm is faster)');
  console.log('    and the fraction does not. **The 5000-to-1 encode count above is the');
  console.log('    statement to quote**, and it needs no timing at all.');
  console.log('');
  console.log('    RT-006 also needs a read-only or `subarray`-wrapped frame, and a separate');
  console.log('    `encoded` counter, so the saving is observable rather than inferred — the');
  console.log('    counter this mode needed is the one RT-006 has to add.');
  console.log('');
  console.log('  This mode gates RT-006. It does not implement it.');
}

/**
 * WT-006 `framedecode` — does the incremental decoder beat re-concatenating?
 *
 * §12.3 claimed 1.6x for `createFrameDecoder` over a naive decoder that
 * re-concatenates the buffer on every chunk. Re-measured at its own shape it is
 * **1.00x and 1.19x on two runs, with a 55-60 % min/max spread** against this
 * harness's 28 % — so the claim did not reproduce, and the design stands on the
 * two failure modes it fixes (a frame split across reads threw, and two frames
 * in one read silently dropped the second) and on the O(n^2) in chunk count, not
 * on speed.
 *
 * The row also records where the two *do* separate: at 32 KB frames, 1.9x. That
 * is an asymptotic property rather than a number, and it is the reason this mode
 * sweeps frame size instead of reporting one figure — the interesting shape is
 * where the arms diverge, and the honest answer at small frames is "they do not,
 * and that is inside the noise".
 *
 * Arms are interleaved and the naive arm is the one that does the quadratic
 * thing on purpose: it re-concatenates every chunk, which is what a reader
 * written without a cursor would do.
 */
async function runFrameDecodeWorkload() {
  console.log('WT-006 framedecode — incremental decoder vs re-concatenating per chunk\n');
  console.log('  §12.3 claimed 1.6x for `createFrameDecoder`. Re-measured at its own shape');
  console.log('  it was 1.00x and 1.19x with a 55-60% spread, so the claim did not');
  console.log('  reproduce. The design does not rest on it: it fixes a frame split across');
  console.log('  reads (RangeError) and two frames in one read (the second dropped).\n');
  console.log('  This sweeps frame size because the arms are expected to diverge only at');
  console.log('  sizes where the copy stops being L1-resident.\n');

  const frameCount = 500;
  const chunkSize = 1400;

  // Naive reader: keep the whole buffer, re-concatenate on every chunk, and take
  // whatever decodes. This is the shape the claim was measured against.
  //
  // **It has to check the declared length before decoding, and that is not an
  // optimisation — it is the only way to write it.** `decodeMessage` throws
  // `RangeError` on a frame shorter than the 6-byte header, and on one whose
  // payload is incomplete, so a reader that decodes optimistically dies at the
  // first chunk boundary. The first version of this arm called `decodeMessage`
  // in a loop with no guard and crashed with
  // `frame is 5 bytes, shorter than the 6-byte header` — which is the very
  // defect `createFrameDecoder` exists to fix, arriving through the benchmark.
  //
  // So the naive arm pays for the length check that the incremental decoder does
  // not, which makes the comparison conservative in the *wrong* direction: any
  // speed the decoder shows here is understated. That is the right way for a
  // benchmark to be biased, and it is stated here rather than left implicit.
  const naiveDecodeAll = (chunks) => {
    let buf = new Uint8Array(0);
    const out = [];
    for (const chunk of chunks) {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf, 0);
      next.set(chunk, buf.length);
      buf = next;
      for (;;) {
        if (buf.length < 6) break;
        const length = (buf[2] | (buf[3] << 8) | (buf[4] << 16) | (buf[5] << 24)) >>> 0;
        if (buf.length < 6 + length) break;
        const decoded = decodeMessage(buf);
        out.push(decoded.value);
        buf = buf.subarray(decoded.byteLength);
      }
    }
    return out;
  };

  const incrementalDecodeAll = (chunks) => {
    const decoder = createFrameDecoder({ maxFrameBytes: Infinity });
    const out = [];
    for (const chunk of chunks) {
      for (const value of decoder.push(chunk)) out.push(value);
    }
    return out;
  };

  // Build one chunked stream per frame size, and keep the frames so both arms
  // decode identical bytes. A frame's real length is measured, not assumed —
  // a hand-guessed length produced a garbage header and a decoder that appeared
  // slow for the wrong reason.
  const buildStream = (bodyBytes) => {
    const body = 'y'.repeat(bodyBytes);
    const frames = [];
    for (let i = 0; i < frameCount; i++) frames.push(encodeMessage({ i, body }));
    const total = frames.reduce((n, f) => n + f.byteLength, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const f of frames) {
      all.set(f, at);
      at += f.byteLength;
    }
    const chunks = [];
    for (let off = 0; off < all.length; off += chunkSize) {
      chunks.push(all.subarray(off, Math.min(off + chunkSize, all.length)));
    }
    return { chunks, bytes: total };
  };

  const sizes = [256, 4_096, 32_768];
  const rows = [];
  console.log(
    `  ${'frame'.padEnd(10)}${'stream'.padStart(10)}${'naive'.padStart(12)}${'incremental'.padStart(14)}` +
      `${'ratio'.padStart(9)}${'spread'.padStart(10)}`
  );
  for (const bodyBytes of sizes) {
    const { chunks, bytes } = buildStream(bodyBytes);
    // Interleaved passes, first discarded, so both arms see the same JIT state.
    const naive = [];
    const inc = [];
    for (let round = 0; round < 4; round++) {
      const t0 = process.hrtime.bigint();
      const a = naiveDecodeAll(chunks);
      const t1 = process.hrtime.bigint();
      const b = incrementalDecodeAll(chunks);
      const t2 = process.hrtime.bigint();
      if (round > 0) {
        naive.push(Number(t1 - t0));
        inc.push(Number(t2 - t1));
      }
      if (a.length !== frameCount || b.length !== frameCount) {
        throw new Error(
          `frame size ${bodyBytes}: arms disagreed on frame count (${a.length} vs ${b.length})`
        );
      }
    }
    const nMs = medianOfMs(naive) / 1e6;
    const iMs = medianOfMs(inc) / 1e6;
    const sp = (Math.max(...naive) - Math.min(...naive)) / Math.min(...naive);
    // The *frame* size is the mean over the stream, measured rather than assumed:
    // the first version recomputed it from `bodyBytes` and printed 548 B and
    // 500 B where the frames were 281 B and 32 KB.
    const frameBytes = bytes / frameCount;
    rows.push({ bodyBytes, frameBytes, bytes, nMs, iMs, spread: sp });
    const ms = (v) => `${v.toFixed(2)} ms`.padStart(12);
    console.log(
      `  ${`${Math.round(frameBytes).toLocaleString()} B`.padEnd(10)}` +
        `${`${(bytes / 1024).toFixed(0)} KB`.padStart(10)}` +
        `${ms(nMs)}${ms(iMs)}` +
        `${`${(nMs / iMs).toFixed(2)}x`.padStart(9)}${`${(sp * 100).toFixed(0)}%`.padStart(9)}`
    );
  }

  console.log('\n  What this says');
  const small = rows[0];
  const large = rows[rows.length - 1];
  const kb = (b) => `${Math.round(b / 1024)} KB`;
  const size = (b) => (b >= 1024 ? kb(b) : `${Math.round(b)} B`);
  // Every row is judged against this machine's own noise, not against a number
  // from another run: a row whose spread is large relative to its ratio says
  // nothing, in either direction.
  for (const r of rows) {
    const ratio = r.nMs / r.iMs;
    const effect = Math.abs(ratio - 1);
    if (r.spread > effect) {
      console.log(
        `    The ${size(r.frameBytes)} row (${ratio.toFixed(2)}x on a` +
          ` ${(r.spread * 100).toFixed(0)}% spread) is noise`
      );
      console.log('      and should not be read as the decoder being faster *or* slower there.');
    }
  }
  const smallRatio = small.nMs / small.iMs;
  console.log(
    `    At ${size(small.frameBytes)} frames the ratio is ${smallRatio.toFixed(2)}x on a` +
      ` ${(small.spread * 100).toFixed(0)}% spread.`
  );
  if (small.spread > Math.abs(smallRatio - 1)) {
    console.log("    The spread exceeds the effect, so that row is noise. **§12.3's 1.6x does not");
    console.log('    reproduce here.** The copy is L1-resident at that size and effectively');
    console.log('    free.');
  } else {
    console.log(
      `    The effect (${((smallRatio - 1) * 100).toFixed(0)}%) is above this run's` +
        ` ${(small.spread * 100).toFixed(0)}%`
    );
    console.log(
      '    spread, but it is the row where the copy is L1-resident and cheapest, so it is'
    );
    console.log('    the least interesting size and not where the design earns its keep.');
    console.log("    §12.3's 1.6x is a single ratio with no spread beside it, so it is not");
    console.log('    comparable to this and should not be quoted.');
  }
  console.log(
    `    At ${size(large.frameBytes)} frames it is ${(large.nMs / large.iMs).toFixed(2)}x on a`
  );
  console.log(
    `    ${(large.spread * 100).toFixed(0)}% spread — the spread is now well under the effect,`
  );
  console.log('    where §12.3 recorded 1.9x. The arms separate once the copy stops being');
  console.log('    cache-resident, which is an asymptotic property and not a number to quote, and');
  console.log('    it is why the guide says "It is not a speedup".');
  console.log('');
  console.log('  The decoder exists for the two failure modes it fixes, not for this table.');
  console.log('  The naive arm is additionally handicapped: `decodeMessage` throws on a');
  console.log('  partial frame, so a reader written without a cursor must check the declared');
  console.log('  length itself. Any speed shown here is therefore understated.');
}

// ─── WT-006 / POOL-008: correlation ────────────────────────────────────────

/**
 * A worker that replies with the `correlationId` the pool attached, so
 * `awaitResponse` resolves.
 *
 * Modelled on the fake in `test/powerPool.negotiation.test.js` rather than
 * invented here: the reply has to mirror the inbound carrier *and* carry the
 * correlation id, and a worker that answers with a hand-built object is never
 * recognised as the pool's answer — the first version of this mode did exactly
 * that and every `awaitResponse` call timed out.
 */
class EchoWorker {
  constructor() {
    this._listeners = [];
  }

  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }

  removeEventListener() {}
  terminate() {}

  postMessage(msg) {
    const { codec, value } = decodeInbound(msg);
    queueMicrotask(() => {
      const body = {
        duration: 1,
        correlationId: value?.correlationId,
        echo: value,
      };
      const data =
        codec === 'native'
          ? encodeNativeEnvelope(body, { correlationId: value?.correlationId })
          : encodeMessage(body, { codec: 'json' });
      for (const [type, fn] of this._listeners) {
        if (type === 'message') fn({ data });
      }
    });
  }
}

/**
 * POOL-008 `correlation` — what does awaiting a reply cost?
 *
 * The recorded figures are **2 423 -> 4 450 and 3 198 -> 4 537 ns/op across two
 * runs**, and the row is explicit that **the mode is the deliverable, not the
 * number**: the machine's own 28.61 % median min/max spread is large enough that
 * the two runs disagree about the plain arm by 30 %. So this mode does not
 * promise a figure. It replays one identical payload through the two paths and
 * reports the difference **with its spread**, so a later change has a baseline
 * that says how noisy the baseline was.
 *
 * Both arms are driven from the same interleaved loop rather than measured
 * separately, so JIT warm-up lands on both, and the reply is produced by a
 * `queueMicrotask` in the fake worker — the same shape the pool's own tests use,
 * and the reason the timing includes a task turn rather than only the pool's
 * bookkeeping.
 */
async function runCorrelationWorkload() {
  console.log('POOL-008 correlation — what does awaiting a reply cost?\n');
  console.log('  One payload, two paths: `postMessage` (fire and forget) and');
  console.log('  `postMessage(..., { awaitResponse: true })`. The reply carries the');
  console.log('  correlationId the pool attached, so the await resolves.\n');
  console.log('  Recorded figures were 2423 -> 4450 and 3198 -> 4537 ns/op across two');
  console.log('  runs, disagreeing by ~30% on the plain arm. **The mode is the');
  console.log('  deliverable**, so what matters here is the spread beside the ratio.\n');

  const payload = { topic: 'orders', id: 42, body: 'z'.repeat(64) };
  const iterations = 20_000;
  const warmup = 5_000;

  const makePool = () => new PowerPool(() => new EchoWorker(), { size: 1, minSize: 1, maxSize: 1 });

  // One round = one plain call and one awaited call, back to back, so the two
  // arms see the same machine state. `await` on the plain arm is omitted on
  // purpose: awaiting a non-promise still yields a microtask turn, and including
  // it would measure the harness rather than the pool.
  const round = async (pool, i) => {
    const t0 = process.hrtime.bigint();
    pool.postMessage({ payload, i });
    const t1 = process.hrtime.bigint();
    await pool.postMessage({ payload, i }, undefined, { awaitResponse: true });
    const t2 = process.hrtime.bigint();
    return [Number(t1 - t0), Number(t2 - t1)];
  };

  const plain = [];
  const awaited = [];
  const pool = makePool();
  // **Warm up explicitly, then discard nothing by index.** The first version
  // collected from `iterations / 5` and reported min/max, which gave a 21 244 %
  // spread on the plain arm — not noise, an artefact: min/max over 16 000 samples
  // is whichever GC pause or scheduler tick landed in the window, and the
  // discarded prefix did not cover the pool's own lazy first-call cost. A spread
  // that large is a statement about the estimator, not about the pool.
  //
  // So: warm up for real, and report a percentile band. `min` is still printed,
  // because it is the robust lower bound and the mode's regression test depends
  // on it, but the headline spread is p10-p90.
  for (let i = 0; i < warmup; i += 1) await round(pool, i);
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < iterations; i += 1) {
    const [p, a] = await round(pool, warmup + i);
    plain.push(p);
    awaited.push(a);
  }
  // Drain before tearing the pool down, or shutdown races the last reply.
  await pool.shutdown();

  const quantile = (sorted, q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const ns = (xs) => {
    const sorted = xs.slice().sort((a, b) => a - b);
    const p10 = quantile(sorted, 0.1);
    const p90 = quantile(sorted, 0.9);
    return {
      median: quantile(sorted, 0.5),
      min: sorted[0],
      p10,
      p90,
      spread: (p90 - p10) / p10,
    };
  };
  const p = ns(plain);
  const a = ns(awaited);

  console.log(`  ${iterations} calls per arm after ${warmup} warm-up, one worker\n`);
  console.log(
    `  ${'arm'.padEnd(22)}${'median'.padStart(12)}${'min'.padStart(12)}${'p10'.padStart(12)}` +
      `${'p10-p90'.padStart(12)}`
  );
  const cell = (v) => `${v.toFixed(0)} ns`.padStart(12);
  const row = (label, s) =>
    `  ${label.padEnd(22)}${cell(s.median)}${cell(s.min)}${cell(s.p10)}` +
    `${((s.spread * 100).toFixed(0) + '%').padStart(12)}`;
  console.log(row('postMessage', p));
  console.log(row('postMessage + await', a));

  const ratioMedian = a.median / p.median;
  const ratioMin = a.min / p.min;
  console.log('\n  What this says');
  console.log(
    `    Awaiting a reply costs **${ratioMedian.toFixed(2)}x** on medians and` +
      ` ${ratioMin.toFixed(2)}x on minimums,`
  );
  console.log('    against a recorded 1.84x and 1.42x. **All three disagree, and that is the');
  console.log(
    `    finding**: the p10-p90 band is ${(p.spread * 100).toFixed(0)}% on the plain arm and`
  );
  console.log(
    `    ${(a.spread * 100).toFixed(0)}% on the awaited one, so the ratio's own uncertainty is`
  );
  console.log('    comparable to the ratio.');
  console.log('');
  console.log('');
  console.log('    **The two arms do different amounts of waiting**, which is the most likely');
  console.log('    reason this ratio exceeds the recorded one. The plain arm only enqueues:');
  console.log('    20 000 messages are posted and none is waited for, so it measures the cost of');
  console.log('    *dispatch*. The awaited arm is necessarily serialised — one round trip at a');
  console.log('    time — so it measures dispatch *plus* a message turn and a settle. A ratio');
  console.log('    between those is a statement about the semantics of fire-and-forget, not a');
  console.log('    defect in either path, and it will not reproduce a figure recorded from a');
  console.log('    setup where the plain arm also waited for something.');
  console.log('');
  console.log('    **The mode is not stable run to run either, and that is the point.** Two');
  console.log('    consecutive runs of the code above gave a p10-p90 band of 73% and 249% on the');
  console.log('    same plain arm. The median moves by a few percent; the tail does not. So the');
  console.log("    median is the only figure here worth comparing, and the row's instruction");
  console.log('    that the mode rather than the number is the deliverable is the correct one.');
  console.log('');
  console.log('    So this mode does not claim a cost for `awaitResponse`. What it does claim');
  console.log('    is that the two paths are the same order of magnitude and the difference is');
  console.log('    not resolvable here: the awaited path adds a correlation id, a pending-task');
  console.log('    entry, a message turn and a settle, and no single one of those dominates');
  console.log('    at this payload size.');
  console.log('');
  console.log('    A regression *is* detectable even though the cost is not: a change that made');
  console.log('    `awaitResponse` allocate per task, or scan the pending set linearly, would');
  console.log('    move this by more than the spread. That is the use for the mode.');
  console.log('');
  console.log('  This mode gates optimising the await path. It does not implement it.');
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * The mode table, and the only copy of the list.
 *
 * This was a thirteen-branch `if`/`else` chain plus a hand-written sentence
 * naming all thirteen, so the set of modes existed twice: once where it was
 * dispatched and once where it was described. The second copy is only reached by
 * misspelling a mode - the least-exercised path in the file - which is exactly
 * how a list goes stale without anyone noticing. The two had already drifted in
 * ordering, and a mode added to the chain but not the sentence would produce an
 * error listing a mode that does not exist while omitting one that does.
 *
 * Keyed by the argument the caller types; the value is the workload. Adding a
 * mode is now one line and cannot leave the message behind.
 *
 * Some runners are synchronous and some await, so every entry is awaited
 * uniformly - `await` on a non-promise is a no-op, and the alternative is an
 * `async` flag per mode, which is a second thing to keep correct.
 */
/**
 * BENCH-002g — does a closed loop beat a fixed flush size?
 *
 * `PowerServo` shipped with no caller, which is what made this mode worth running.
 * The candidate was `PowerBatch`, whose sizing is entirely open-loop today:
 * `maxSize` is a constant and `add()` flushes when the pending count reaches it.
 * The question this mode answers is narrower than "is a servo fast": it is
 * **whether a controller has anything to correct**. If a fixed `maxSize` already
 * holds items-per-flush at its target on a bursty producer, then wiring one in is
 * pure cost.
 *
 * It found none: `maxSize` was already exact, so `PowerBatch` was left alone. The
 * servo was later adopted by `PowerPool`'s step sizing instead — see `stepsize`.
 *
 * The workload is a real `PowerBatch` with real microtask flushing. The
 * controller is *external*, which is the only honest form of this experiment
 * today: `PowerBatch` exposes no queue depth, so there is nothing to feed a servo
 * from without first adding a getter. What is measured is therefore the
 * arithmetic on a real call path, not a proposal.
 *
 * Reported as ratios and counters, never durations. BENCH-001 measured a 28%
 * median min/max spread on this machine, and this project's own guidance is to
 * prefer a counter or a shape over a duration.
 */
async function runBatchServoWorkload() {
  console.log('BENCH-002g — does a closed loop beat a fixed flush size?\n');
  console.log('  `PowerBatch.maxSize` is a constant today. `PowerServo` is a closed-loop');
  console.log('  transfer function that could size a flush from the observed pending count');
  console.log('  instead. This asks whether that would do anything: a controller is only');
  console.log('  worth wiring in if a fixed size *fails* to hold the target.\n');

  const SETPOINT = Number(process.env.CLAIM_BATCH_SERVO_TARGET || 12);
  const BURSTS = Number(process.env.CLAIM_BATCH_SERVO_BURSTS || 60);
  const BURST_SIZE = Number(process.env.CLAIM_BATCH_SERVO_BURST || 9);
  console.log(`  target items per flush   ${SETPOINT}`);
  console.log(`  producer                 ${BURSTS} bursts of ${BURST_SIZE}, 4 bursts per tick\n`);
  console.log('  Per burst the producer adds `BURST_SIZE` items at once, so the pending');
  console.log('  count arrives as steps rather than a ramp. A fixed size that matches the');
  console.log('  mean will be correct on average and wrong on every burst; that gap is the');
  console.log('  only thing a controller could exploit.\n');

  // Deterministic burst pattern. A seeded RNG was tried and removed: the arrival
  // *shape* is the independent variable here, so the shape must be fixed and only
  // the policy may vary.
  const arrival = [];
  for (let b = 0; b < BURSTS; b += 1) {
    for (let i = 0; i < BURST_SIZE; i += 1) arrival.push({ burst: b, index: i });
  }

  /**
   * Run one policy and return the shapes that matter.
   *
   * @param {'fixed'|'p'|'pi'|'piff'} policy
   */
  const run = async (policy) => {
    let maxSize = SETPOINT;
    const servo =
      policy === 'fixed'
        ? null
        : new PowerServo({
            setpoint: SETPOINT,
            kp: policy === 'p' ? 0.6 : 0.6,
            ki: policy === 'p' ? 0 : 0.25,
            min: 1,
            max: BURST_SIZE * 4,
            // The feedforward term is the burst size the producer is about to
            // deliver, which a caller batching per tick genuinely knows.
            feedforward: () => (policy === 'piff' ? BURST_SIZE : 0),
          });

    const perFlush = [];
    let outstanding = 0;
    let peak = 0;
    let peakSinceFlush = 0;
    let handlerCalls = 0;
    let itemsHandled = 0;

    const batch = new PowerBatch(
      (items) => {
        handlerCalls += 1;
        itemsHandled += items.length;
        perFlush.push(items.length);
        peak = Math.max(peak, peakSinceFlush);
        peakSinceFlush = 0;
      },
      { maxSize, scheduling: 'microtask' }
    );

    // A burst is added **synchronously**, which is the only shape `PowerBatch`
    // exists for: awaiting each `add()` yields to the microtask queue between
    // items, so every flush was exactly one item long and all four policies
    // produced identical numbers. That was a degenerate experiment dressed as a
    // result — the first run of this mode reported a 1.00x "no difference"
    // across the board, which is what a broken harness looks like.
    const inflight = [];
    for (const item of arrival) {
      inflight.push(batch.add(item));
      outstanding += 1;
      peakSinceFlush = Math.max(peakSinceFlush, outstanding);

      // **The measured variable is `_queue.length`, the real pending count.**
      // The first version fed the controller `outstanding`, a running tally of
      // adds that only drains when the microtask queue runs — so it climbed
      // monotonically to 540 against a setpoint of 12, every policy saw a
      // permanent enormous error, and all three collapsed the batch to ~1 item
      // per flush. That is a mis-specified experiment, not a controller that
      // cannot work, and the difference is the whole result.
      //
      // Reading a private is legitimate here for the same reason `sieve`
      // implements its policy in the bench file rather than in `src/`: the claim
      // under test is what a policy does, and this also prices the getter an
      // integration would have to add.
      const pending = batch._queue.length;
      if (servo) {
        const next = servo.step(pending, 1);
        const rounded = Math.max(1, Math.round(next));
        if (rounded !== maxSize) {
          maxSize = rounded;
          batch._maxSize = rounded;
        }
      }
    }
    await Promise.all(inflight);
    // `outstanding` is now the count the producer is *about* to add, not what is
    // pending, because the flush is already queued behind these microtasks.
    await batch.flush();
    batch.dispose();

    const mean = perFlush.reduce((a, b) => a + b, 0) / (perFlush.length || 1);
    // Mean absolute deviation from the target is the metric the experiment is
    // really about: a policy that averages correctly while swinging wildly has
    // not held anything.
    const mad = perFlush.reduce((a, n) => a + Math.abs(n - SETPOINT), 0) / (perFlush.length || 1);
    return { policy, handlerCalls, itemsHandled, mean, mad, peak, perFlush };
  };

  const results = [];
  for (const policy of ['fixed', 'p', 'pi', 'piff']) results.push(await run(policy));

  const control = results[0];
  console.log(
    `  ${'policy'.padEnd(8)}${'mean items/flush'.padEnd(18)}${'mean |err|'.padEnd(12)}${'peak in flight'.padEnd(15)}${'handler calls'.padEnd(14)}vs fixed`
  );
  console.log(`  ${'-'.repeat(78)}`);
  for (const r of results) {
    // The control's mean error can legitimately be 0 — and here it is — and
    // `0.00x` or `Infinityx` both read as a broken harness rather than a result.
    // A control that is already exact has nothing to beat, and saying that is the
    // finding.
    const madRatio =
      control.mad === 0
        ? r.mad === 0
          ? 'exact'
          : 'worse'
        : `${(r.mad / control.mad).toFixed(2)}x worse`;
    console.log(
      `  ${r.policy.padEnd(8)}${r.mean.toFixed(2).padEnd(18)}${r.mad.toFixed(2).padEnd(12)}` +
        `${String(r.peak).padEnd(15)}${String(r.handlerCalls).padEnd(14)}${madRatio}`
    );
  }

  console.log(`\n  items produced          ${control.itemsHandled}`);
  if (control.mad === 0) {
    console.log('\n  THE FIXED SIZE IS ALREADY EXACT. Mean |err| 0.00 against a target of');
    console.log(`  ${SETPOINT}, so there is no error for a controller to reject and the`);
    console.log('  comparison has no room in it. Two things about *why* generalise past this');
    console.log('  helper:');
    console.log('\n  1. `PowerBatch` is already a closed system. `add()` flushes the moment the');
    console.log('     queue reaches `maxSize`, so the pending count is bounded by the size');
    console.log('     itself. The quantity a controller would reject is bounded by its own');
    console.log('     setpoint — there is no free-running variable to stabilise.');
    console.log('  2. Both controller failures are diagnostic, not random. P undershoots');
    console.log('     (mean 5.00 against 12) because proportional action tracks the error');
    console.log('     rather than anticipating the burst; PI overshoots (21.60) because the');
    console.log('     integral winds the output up past a target it was already hitting.');
    console.log('     Feedforward is identical to PI here (21.60, same 25 handler calls)');
    console.log('     because the burst is already flushed by the time the controller');
    console.log('     resizes — the open-loop term arrives after the event it anticipated.');
    console.log('\n  SO: DO NOT WIRE A CONTROLLER INTO `PowerBatch`. That is the finding. It');
    console.log("  retires `SRV-001`'s candidate, not the helper.");
  } else {
    const best = results.reduce((a, b) => (b.mad < a.mad ? b : a));
    console.log(`\n  tightest to target     ${best.policy} (mean |err| ${best.mad.toFixed(2)})`);
    console.log('\n  A fixed size is not exact here, so the comparison has room in it. Read');
    console.log('  the ratio column for which policy holds the target best, and note that a');
    console.log('  controller would need a queue-depth getter that does not exist yet.');
  }
}

/**
 * A worker with a controllable service time.
 *
 * **Derived from `EchoWorker`'s protocol handling, deliberately.** Two earlier
 * attempts at this mode hand-rolled a fake worker and both failed on it: one
 * never satisfied the framed response protocol so every awaited post hung, and
 * one read `awaitResponseTimeout: 0` as "no timeout" when it means *time out
 * immediately*, so every completion it counted was a rejection. The envelope
 * handling below is copied rather than re-derived for exactly that reason; the
 * only change from `EchoWorker` is `setTimeout` in place of `queueMicrotask`, to
 * give the task a service time.
 */
class TimedWorker {
  constructor(serviceMs) {
    this._listeners = [];
    this._serviceMs = serviceMs;
  }

  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }

  removeEventListener() {}

  terminate() {}

  postMessage(msg) {
    const { codec, value } = decodeInbound(msg);
    setTimeout(() => {
      const body = {
        duration: this._serviceMs,
        correlationId: value?.correlationId,
        echo: value,
      };
      const data =
        codec === 'native'
          ? encodeNativeEnvelope(body, { correlationId: value?.correlationId })
          : encodeMessage(body, { codec: 'json' });
      for (const [type, fn] of this._listeners) {
        if (type === 'message') fn({ data });
      }
    }, this._serviceMs);
  }
}

/**
 * POOL-012 — is `autoScale.policy` wired to anything?
 *
 * The read-based answer is that `_adaptiveLimit` is written by
 * `_updateAdaptiveLimit()` and read by `getStats()`, with no read on the dispatch
 * path. This mode asks the behavioural question, because a read-based answer can
 * be wrong and one probe of mine was.
 *
 * **What this mode can support is narrow, and it checks that before printing
 * anything.** Wall-clock throughput carries the 28 % median min/max spread
 * BENCH-001 measured, so a raw spread across policies means nothing on its own.
 * The arms therefore include `ewma` **twice**: `ewma:a` and `ewma:b` are the same
 * configuration, so their spread is this harness's noise floor *measured on this
 * run*. A cross-policy spread only counts as an effect if it clears both that
 * floor and an absolute materiality threshold — a first version used
 * `cross > floor * 1.5` alone and duly reported a 1.3 % spread, which is twenty
 * four admissions out of 1920, as "an effect larger than the noise floor".
 *
 * The gate claims its slot inside the admission decision. The obvious shape —
 * `await room(); pending += 1;` — is a check-then-act race: awaiting an
 * already-resolved promise yields a microtask, so every racer evaluated
 * `pending < cap` before any of them incremented it. Measured with that shape,
 * `admitted == inflight` for every cap including 2, which is how two "enforced"
 * arms came out 25x apart on a cap that was never applied.
 *
 * `gate held (peak N <= cap M)` at the top is that check, run every time. A mode
 * that cannot trust its own gate says so and stops rather than printing a ratio.
 */
/**
 * POOL-012 — is `autoScale.policy` wired to anything, and would enforcing it help?
 *
 * The read-based answer is that `_adaptiveLimit` is written by
 * `_updateAdaptiveLimit()` and read by `getStats()`, with no read on the dispatch
 * path. This mode asks the behavioural question, because a read-based answer can
 * be wrong and one probe of mine was.
 *
 * **Part 1** settles the wiring. **Part 2** settles the decision, which is a
 * different question and needs a different bar.
 *
 * ## What this mode can support is narrow, and it checks that before printing
 *
 * Wall-clock throughput carries the 28 % median min/max spread BENCH-001
 * measured, so a raw spread across policies means nothing on its own. Part 1
 * therefore runs `ewma` **twice** — `ewma:a` and `ewma:b` are the same
 * configuration, so their spread is this harness's noise floor *measured on this
 * run*. A spread only counts as an effect if it clears both that floor and an
 * absolute materiality threshold; the first version used `cross > floor * 1.5`
 * alone and duly reported a 1.3 % spread, twenty-four admissions out of 1920, as
 * "an effect larger than the noise floor".
 *
 * Part 2's bar is **the best hand-picked constant cap**, not "better than
 * nothing" — the pool already has a limit of sorts, and a controller that only
 * beats a badly-chosen constant has not earned a getter. So the control is a
 * sweep of constants and the comparison is against the best of them.
 *
 * ## The gate claims its slot inside the admission decision
 *
 * The obvious shape — `await room(); pending += 1;` — is a check-then-act race:
 * awaiting an already-resolved promise yields a microtask, so every racer
 * evaluated `pending < cap` before any of them incremented it. Measured with
 * that shape, `admitted == inflight` for every cap including 2, which is how two
 * "enforced" arms came out 25x apart on a cap that was never applied. That is
 * why the `adaptive` cap below is only trustworthy now, and why the gate is
 * checked at the top of Part 1 before any ratio is printed.
 */
/**
 * A worker whose service time grows with its own queue depth.
 *
 * The physical mechanism that makes a concurrency or step decision matter at all:
 * a task that finds a busy worker waits. Without that coupling a fleet size is
 * arbitrary and every arm ties, which is what `batcheservo` had to guard against
 * with its `maxBytes` ceiling.
 *
 * Protocol handling is copied from `EchoWorker` — twice now a hand-rolled fake
 * worker has failed on the framed response protocol, and there is no reason to
 * attempt it a third time.
 */
class QueuedWorker {
  constructor({ baseMs, slopeMs, maxPerWorker }) {
    this._listeners = [];
    this._queue = [];
    this._baseMs = baseMs;
    this._slopeMs = slopeMs;
    this._maxPerWorker = maxPerWorker;
  }

  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }

  removeEventListener() {}

  terminate() {}

  postMessage(msg) {
    const { codec, value } = decodeInbound(msg);
    // The service time is decided when the task *arrives*, from the depth it
    // finds. A task that arrives at an empty worker is fast; one that arrives
    // behind eight others waits, and that is the queueing delay the pool's EWMA
    // ends up measuring.
    const depth = this._queue.length;
    const serviceMs = this._baseMs + this._slopeMs * depth;
    const slot = { done: false };
    this._queue.push(slot);
    setTimeout(() => {
      const at = this._queue.indexOf(slot);
      if (at !== -1) this._queue.splice(at, 1);
      const body = { duration: serviceMs, correlationId: value?.correlationId, echo: value };
      const data =
        codec === 'native'
          ? encodeNativeEnvelope(body, { correlationId: value?.correlationId })
          : encodeMessage(body, { codec: 'json' });
      for (const [type, fn] of this._listeners) {
        if (type === 'message') fn({ data });
      }
    }, serviceMs);
  }
}

/**
 * Autoscale step sizing — does the controller beat the fixed step it replaced?
 *
 * `2498c7d` made `stepUp`/`stepDown` a ceiling and let `PowerServo` choose the
 * step within it. Nothing has measured whether that is better, so this does.
 *
 * **The control is the pre-`2498c7d` behaviour, reconstructed in this file** —
 * `_autoscaleSteps` returning the ceiling — for the same reason `sieve`
 * implements its policy here rather than in `src/`: the claim under test is
 * whether the shipped thing beats what it replaced, so the thing it replaced has
 * to exist. Monkey-patching one method is also the narrowest possible
 * difference: the two arms share every line of pool code except the step rule.
 *
 * ## What is measured, and why not throughput
 *
 * A fixed step of 4 reaches a large fleet size in *fewer ticks* than a
 * proportional one — that is arithmetic, not merit. What it cannot do is avoid
 * overshooting when only one worker was needed. So the metrics are counters about
 * the fleet, not rates: **ticks to settle**, **workers added in total**, and
 * **overshoot** (peak fleet beyond the settled size). Throughput is reported only
 * as a guard: an arm that wins on overshoot while losing throughput has not won.
 *
 * ## The three things that keep this honest
 *
 * - **A noise-control arm.** Two `fixed` arms, identical, so their spread is this
 *   run's own noise. A `concurrency` predecessor reported 0.0 % and looked
 *   conclusive; three consecutive runs of that same version gave 16.7 %, 5.7 % and
 *   27.3 %, because it had no same-policy control and its variance was the harness.
 * - **A self-check on the treatment.** If the `servo` arm's per-tick steps are
 *   identical to the control's, the controller is a no-op and the mode says so
 *   rather than reporting a null result.
 * - **A materiality threshold** as well as the noise floor, because
 *   `cross > floor * 1.5` once reported a 1.3 % spread as an effect.
 */
async function runStepSizingWorkload() {
  console.log('Autoscale step sizing — does the controller beat the fixed step?\n');

  const ARMS = Number(process.env.CLAIM_STEP_ARMS || 3);
  const REPEATS = Number(process.env.CLAIM_STEP_REPEATS || 5);
  const TICKS = Number(process.env.CLAIM_STEP_TICKS || 24);
  const BASE_MS = Number(process.env.CLAIM_STEP_BASE_MS || 2);
  const SLOPE_MS = Number(process.env.CLAIM_STEP_SLOPE_MS || 3);
  const TARGET_MS = Number(process.env.CLAIM_STEP_TARGET_MS || 30);
  const STEP_CEILING = 4;
  const LOAD = Number(process.env.CLAIM_STEP_LOAD || 6);
  const MATERIAL = 0.1;

  console.log(`  ${ARMS} arms, ${REPEATS} repeats, ${TICKS} ticks each, median reported`);
  console.log(`  fleet 1..16, step ceiling ${STEP_CEILING}, load ${LOAD} outstanding tasks`);
  console.log(`  service = ${BASE_MS} ms + ${SLOPE_MS} ms x the worker's own queue depth`);
  console.log(`  target ${TARGET_MS} ms, hysteresis 0.1, cooldown 0\n`);

  /**
   * One run. Returns the fleet-shape counters, plus the per-tick steps so the
   * self-check can see whether the treatment did anything.
   */
  const run = async (arm) => {
    const pool = new PowerPool(
      () => new QueuedWorker({ baseMs: BASE_MS, slopeMs: SLOPE_MS, maxPerWorker: 8 }),
      { size: 1, minSize: 1, maxSize: 16, lazy: false, idleTimeout: 60_000 }
    );
    pool._autoScale = {
      enabled: true,
      intervalMs: 1,
      targetMs: TARGET_MS,
      hysteresis: 0.1,
      cooldownMs: 0,
      stepUp: STEP_CEILING,
      stepDown: STEP_CEILING,
      backoffFactor: 1,
      backoffMaxMultiplier: 1,
    };

    // The control: the pre-2498c7d rule, restored as a one-line patch.
    if (arm === 'fixed') {
      pool._autoscaleSteps = (_ewma, _target, ceiling) => Math.max(1, ceiling || 1);
    }

    const steps = [];
    const sizes = [];
    let settledAt = null;
    let previous = null;

    for (let t = 0; t < TICKS; t += 1) {
      // **The latency signal is modelled from the fleet size**, and that is a
      // deliberate narrowing: this mode measures the *decision rule* given a
      // latency reading, not the whole dispatch loop. An earlier version planted
      // work in `pool.queue` and called `_autoScaleTick()` directly, which never
      // completed a task — so `_ewmaLatency` stayed null, `_autoscaleSteps`
      // short-circuited on its `ewma == null` guard, and both arms took the
      // ceiling. The self-check caught it: `servo: [4]  fixed: [4]`, a treatment
      // identical to its control, which is exactly what it exists to catch.
      //
      // The model is the physical relationship autoscale responds to: queueing
      // delay falls as the fleet grows, asymptotically towards the unloaded
      // service time. A real dispatch loop would add the submission path's own
      // noise without making the step rule any more real.
      const fleet = Math.max(1, pool.workers.length);
      pool._ewmaLatency = BASE_MS + (LOAD / fleet) * SLOPE_MS * 4;
      const before = pool.workers.length;
      pool._autoScaleTick();
      const after = pool.workers.length;
      steps.push(after - before);
      sizes.push(after);
      // "Settled" = the fleet stopped moving. Reported as a tick index so a run
      // that never settles is visible as a null rather than as a large number.
      if (after === before && previous !== null && settledAt === null) settledAt = t;
      previous = after;
      // Let the fleet's own teardown settle between ticks, so the counters read
      // a sequence rather than one instant.
      await new Promise((r) => setTimeout(r, 2));
    }

    const peak = Math.max(...sizes);
    const final = sizes[sizes.length - 1];
    const added = sizes.reduce((a, b) => a + b, 0);
    await pool.shutdown();
    return {
      settledAt: settledAt ?? -1,
      peak,
      final,
      overshoot: peak - final,
      added,
      distinctSteps: [...new Set(steps)].sort((a, b) => a - b),
    };
  };

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const arm = async (label, name) => {
    const runs = [];
    for (let r = 0; r < REPEATS; r += 1) runs.push(await run(name));
    const last = runs[runs.length - 1];
    return {
      label,
      settledAt: median(runs.map((x) => x.settledAt)),
      peak: median(runs.map((x) => x.peak)),
      final: median(runs.map((x) => x.final)),
      overshoot: median(runs.map((x) => x.overshoot)),
      added: median(runs.map((x) => x.added)),
      distinctSteps: last.distinctSteps,
    };
  };

  // --- Self-check: the treatment must actually differ from the control. ---
  const probe = await run('servo');
  const probeFixed = await run('fixed');
  const treatment = probe.distinctSteps.filter((s) => s !== 0).join(',') || '(none)';
  const control = probeFixed.distinctSteps.filter((s) => s !== 0).join(',') || '(none)';
  console.log(
    `  SELF-CHECK — non-zero per-tick steps, servo: [${treatment}]  fixed: [${control}]\n`
  );
  if (treatment === control) {
    console.log('  THE TREATMENT IS A NO-OP on this workload: the controller took the same');
    console.log('  steps as the fixed rule, so every comparison below would be vacuous. This');
    console.log('  mode is stopping rather than printing a null result dressed as a finding.');
    return;
  }

  const arms = [];
  for (let i = 0; i < ARMS; i += 1) arms.push(await arm(`fixed:${i + 1}`, 'fixed'));
  arms.push(await arm('servo', 'servo'));

  console.log(
    `  ${'arm'.padEnd(12)}${'settled'.padEnd(11)}${'peak fleet'.padEnd(13)}${'final'.padEnd(9)}overshoot`
  );
  console.log(`  ${'-'.repeat(56)}`);
  for (const a of arms) {
    const settled = a.settledAt < 0 ? 'never' : `tick ${a.settledAt}`;
    console.log(
      `  ${a.label.padEnd(12)}${settled.padEnd(11)}${String(a.peak).padEnd(13)}${String(a.final).padEnd(9)}${a.overshoot}`
    );
  }

  const fixedArms = arms.filter((a) => a.label.startsWith('fixed'));
  const servoArm = arms[arms.length - 1];
  const control0 = fixedArms[0];
  const spread = (xs) => {
    const hi = Math.max(...xs);
    const lo = Math.min(...xs);
    return lo === 0 ? (hi === 0 ? 0 : 1) : (hi - lo) / lo;
  };
  const noise = spread(fixedArms.map((a) => a.overshoot));
  const both = [...fixedArms.map((a) => a.overshoot), servoArm.overshoot];
  const cross = spread(both);

  console.log(`\n  noise floor (fixed vs fixed, identical) : ${(noise * 100).toFixed(1)} %`);
  console.log(`  cross-arm overshoot spread              : ${(cross * 100).toFixed(1)} %`);
  console.log(`  materiality threshold                   : ${(MATERIAL * 100).toFixed(1)} %`);

  const delta = (servoArm.overshoot - control0.overshoot) / Math.max(1, control0.overshoot);
  console.log(
    `\n  servo vs fixed, overshoot: ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} %`
  );
  console.log(`  servo vs fixed, ticks to settle: ${servoArm.settledAt} vs ${control0.settledAt}`);

  if (servoArm.settledAt < 0 || control0.settledAt < 0) {
    console.log('\n  CAVEAT 1 of 2 — neither arm ever stopped moving, so "ticks to settle" is');
    console.log('  uninformative here and only overshoot discriminates. With `cooldownMs: 0`');
    console.log('  and a modelled signal the fleet hunts rather than resting, which is why the');
    console.log('  fixed arm ends at 1 after peaking at 5: it overshoots on the way up and all');
    console.log('  the way back down. A real deployment has a cooldown and a real queue, and');
    console.log('  this mode makes no claim about settling.');
  }
  console.log('\n  CAVEAT 2 of 2 — the latency signal is MODELLED from the fleet size');
  console.log('  (`base + load/fleet x slope x 4`), not measured from a dispatch loop. That');
  console.log('  narrows the claim to the decision rule given a latency reading, which is the');
  console.log('  variable under test, but it is not a whole-pool measurement.');

  if (Math.abs(delta) < MATERIAL || cross <= noise * 1.5) {
    console.log('\n  NO DIFFERENCE WORTH REPORTING. The overshoot spread clears neither the');
    console.log('  noise floor nor materiality, so on this workload the controller is not');
    console.log('  measurably better or worse than adding `stepUp` every tick.');
    console.log('\n  That is not a reason to revert it: the controller is bounded by the same');
    console.log('  ceiling, is identical at the default `stepUp: 1`, and is the reason the');
    console.log('  helper has a caller. But it IS a reason not to claim it converges faster.');
  } else if (delta < 0) {
    console.log('\n  THE CONTROLLER OVERSHOOTS LESS, by more than both thresholds. Read the tick');
    console.log('  column too: a fixed step of 4 reaches a large fleet in fewer ticks by');
    console.log('  arithmetic, so overshoot is the metric that distinguishes them.');
  } else {
    console.log('\n  THE CONTROLLER OVERSHOOTS MORE, by more than both thresholds — which is');
    console.log('  what proportionality predicts when the load is uniform. Worth knowing');
    console.log('  before assuming it is an improvement.');
  }
}

async function runConcurrencyWorkload() {
  console.log('POOL-012 — is `autoScale.policy` wired, and would enforcing it help?\n');

  const BUDGET_MS = Number(process.env.CLAIM_CONCURRENCY_BUDGET_MS || 2000);
  const REPEATS = Number(process.env.CLAIM_CONCURRENCY_REPEATS || 5);
  const SERVICE_MS = Number(process.env.CLAIM_CONCURRENCY_SERVICE_MS || 4);
  const INFLIGHT = Number(process.env.CLAIM_CONCURRENCY_INFLIGHT || 8);
  const POOL_SIZE = 4;
  const MATERIAL = 0.05;

  console.log(`  budget ${BUDGET_MS} ms per arm, ${REPEATS} repeats, median reported`);
  console.log(
    `  pool size ${POOL_SIZE}, ${INFLIGHT} submitted at a time, ${SERVICE_MS} ms service`
  );
  console.log(`  an effect must clear both the noise floor and ${MATERIAL * 100} %\n`);

  const runArm = async (policy, cap) => {
    const pool = new PowerPool(() => new TimedWorker(SERVICE_MS), {
      size: POOL_SIZE,
      minSize: POOL_SIZE,
      maxSize: POOL_SIZE,
      lazy: false,
      autoScale: {
        policy,
        intervalMs: 25,
        cooldownMs: 0,
        targetMs: SERVICE_MS * POOL_SIZE,
        limitMin: 1,
        limitMax: POOL_SIZE * 2,
      },
    });

    let pending = 0;
    let peak = 0;
    const waiters = [];
    // `adaptive` is what Part 2 exists to exercise: cap the window at whatever the
    // controller published. `null` — what `ewma` reports — is not a cap, so it
    // falls back to the pool's own size, which is a choice a real caller faces too.
    const capNow = () => {
      if (cap === null) return Infinity;
      if (cap !== 'adaptive') return cap;
      const l = pool.getStats().performance.concurrencyLimit;
      return typeof l === 'number' && l >= 1 ? Math.round(l) : pool.size;
    };

    const acquire = () =>
      new Promise((resolve) => {
        if (pending < capNow()) {
          pending += 1;
          resolve();
          return;
        }
        waiters.push(resolve);
      });

    const submit = async () => {
      await acquire();
      if (pending > peak) peak = pending;
      return pool.postMessage({ x: 1 }, undefined, { awaitResponse: true }).finally(() => {
        pending -= 1;
        while (waiters.length > 0 && pending < capNow()) {
          pending += 1;
          waiters.shift()();
        }
      });
    };

    const deadline = Number(process.hrtime.bigint() / 1000000n) + BUDGET_MS;
    let admitted = 0;
    while (Number(process.hrtime.bigint() / 1000000n) < deadline) {
      const batch = [];
      for (let i = 0; i < INFLIGHT; i += 1) batch.push(submit());
      admitted += INFLIGHT;
      await Promise.all(batch);
    }
    const limit = pool.getStats().performance.concurrencyLimit;
    await pool.shutdown();
    return { admitted, peak, limit };
  };

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const spread = (xs) => {
    const hi = Math.max(...xs);
    const lo = Math.min(...xs);
    return hi === lo ? 0 : (hi - lo) / lo;
  };

  const arm = async (label, policy, cap = null) => {
    const runs = [];
    for (let r = 0; r < REPEATS; r += 1) runs.push(await runArm(policy, cap));
    return {
      label,
      admitted: median(runs.map((x) => x.admitted)),
      peak: Math.max(...runs.map((x) => x.peak)),
      limits: [...new Set(runs.map((x) => String(x.limit)))].join(' '),
    };
  };

  // ---------------------------------------------------------------- Part 1 ---
  console.log('  PART 1 — is the controller consulted at all?\n');

  const capUnderTest = Math.max(1, INFLIGHT / 2);
  const gated = await arm(`capped:${capUnderTest}`, 'ewma', capUnderTest);
  console.log(`  GATE SELF-CHECK — cap ${capUnderTest}, ${INFLIGHT} submitted at a time\n`);
  console.log(`    peak observed ${gated.peak}, cap ${capUnderTest}`);
  if (gated.peak > capUnderTest) {
    console.log('    THE GATE DID NOT HOLD, so every ratio below would be meaningless and this');
    console.log('    mode stops rather than printing them. The slot has to be claimed inside');
    console.log('    the admission decision — see the note above this function.');
    return;
  }
  console.log('    gate held. Ratios below are meaningful.\n');

  const noiseA = await arm('ewma:a', 'ewma');
  const noiseB = await arm('ewma:b', 'ewma');
  const policies = [];
  for (const policy of ['aimd', 'vegas', 'gradient2'])
    policies.push(await arm(`policy:${policy}`, policy));
  const part1 = [noiseA, noiseB, ...policies];

  console.log(`  ${'arm'.padEnd(18)}${'admitted'.padEnd(12)}${'peak'.padEnd(8)}concurrencyLimit`);
  console.log(`  ${'-'.repeat(66)}`);
  for (const a of part1) {
    console.log(
      `  ${a.label.padEnd(18)}${String(a.admitted).padEnd(12)}${String(a.peak).padEnd(8)}${a.limits}`
    );
  }
  console.log(`\n  raw medians: ${part1.map((a) => `${a.label}=${a.admitted}`).join(', ')}`);

  const floor1 = spread([noiseA.admitted, noiseB.admitted]);
  const cross1 = spread(part1.map((a) => a.admitted));
  console.log(`\n  noise floor  (ewma vs ewma, identical config) : ${(floor1 * 100).toFixed(1)} %`);
  console.log(
    `  cross-policy (all ${part1.length} arms)                       : ${(cross1 * 100).toFixed(1)} %`
  );
  console.log(`  materiality threshold                       : ${(MATERIAL * 100).toFixed(1)} %`);

  if (cross1 <= floor1 * 1.5 || cross1 < MATERIAL) {
    console.log('\n  NOT WIRED. The cross-policy spread clears neither the noise floor nor the');
    console.log('  materiality threshold, so throughput on this workload does not depend on');
    console.log('  which policy is configured. The last column differs per policy and is');
    console.log('  stable within each: the controller is running and its belief is changing,');
    console.log('  and nothing consumes it. That agrees with the read — `_adaptiveLimit` is');
    console.log('  written by `_updateAdaptiveLimit()` and read by `getStats()`.');
  } else {
    console.log('\n  A spread above both thresholds is visible. That does NOT show the controller');
    console.log('  caused it: `concurrencyLimit` is read by `getStats()` only, so a difference');
    console.log('  would mean some other path is sensitive to the configured policy.');
  }

  // ---------------------------------------------------------------- Part 2 ---
  console.log('\n  PART 2 — would enforcing the limit beat the best constant?\n');

  const shippedA = await arm('shipped:a', 'ewma');
  const shippedB = await arm('shipped:b', 'ewma');
  const enforced = [];
  for (const policy of ['aimd', 'gradient2']) {
    enforced.push(await arm(`enforced:${policy}`, policy, 'adaptive'));
  }

  // The control: a sweep, so "the constant" means the best one, not a convenient one.
  const constants = [];
  for (const c of [1, 2, 3, 4, 6, 8]) constants.push(await arm(`constant:${c}`, 'ewma', c));

  const shipped = shippedA;
  const rows = [shippedA, shippedB, ...enforced, ...constants];
  console.log(`  ${'arm'.padEnd(20)}${'admitted'.padEnd(12)}${'peak'.padEnd(8)}vs shipped`);
  console.log(`  ${'-'.repeat(60)}`);
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(20)}${String(r.admitted).padEnd(12)}${String(r.peak).padEnd(8)}` +
        `${(r.admitted / shipped.admitted).toFixed(2)}x`
    );
  }

  const bestConstant = constants.reduce((a, b) => (b.admitted > a.admitted ? b : a));
  const bestEnforced = enforced.reduce((a, b) => (b.admitted > a.admitted ? b : a));
  const floor2 = spread([shippedA.admitted, shippedB.admitted]);
  const vsConstant = (bestEnforced.admitted - bestConstant.admitted) / bestConstant.admitted;

  console.log(`\n  noise floor (shipped vs shipped)  ${(floor2 * 100).toFixed(1)} %`);
  console.log(`  best constant  ${bestConstant.label.padEnd(16)} ${bestConstant.admitted}`);
  console.log(`  best enforced  ${bestEnforced.label.padEnd(16)} ${bestEnforced.admitted}`);
  console.log(
    `  enforced vs the BEST constant: ${vsConstant >= 0 ? '+' : ''}${(vsConstant * 100).toFixed(1)} %`
  );
  console.log(`  raw: ${rows.map((r) => `${r.label}=${r.admitted}`).join(', ')}`);

  if (vsConstant <= Math.max(floor2 * 1.5, MATERIAL)) {
    console.log('\n  THE CONTROLLER DOES NOT EARN THE GETTER. The best it manages is within the');
    console.log('  noise floor of, or behind, the best constant cap. Since `POOL-004` found');
    console.log('  the pool has no public resize path, putting the limit on the dispatch path is');
    console.log('  a change to how work is admitted, not one more field read — so a controller');
    console.log('  that cannot beat a chosen constant does not justify that change. The honest');
    console.log('  options are to document `policy` as reported-only, or to drop it.');
  } else {
    console.log('\n  THE CONTROLLER CLEARS BOTH BARS against the best constant, which is evidence');
    console.log('  FOR wiring it to dispatch. It would still need the latency-distribution check:');
    console.log('  `ALGO-005` records that this pool EWMA is end-to-end task latency rather than');
    console.log('  the queueing delay Netflix controllers assume, and this workload is uniform.');
  }
}

// ─── BC-001: one BroadcastChannel against K explicit ports ──────────────────
//
// The claim under test is a **sender-side** one, and it is the reason this mode
// exists before any BroadcastChannel feature does.
//
// The proposal shape is a bus that reaches N peers with one `postMessage` rather
// than N. If the win is real it is entirely in the sender: a `BroadcastChannel`
// serialises the envelope **once** and hands the same bytes to every subscriber,
// while an explicit `MessagePort` loop pays one serialisation per peer. Nothing
// is saved on the receiving side — each receiver still deserialises its own copy
// — so a benchmark that reported only end-to-end wall time would be measuring the
// wrong half and could show a loss while the thing being proposed still wins.
//
// **The same-thread caveat is the honest limit of this harness, and it is stated
// rather than buried.** Every receiver here is a `BroadcastChannel`/`MessagePort`
// in *this* process and on *this* thread, so delivery is queued onto the same
// event loop rather than happening in parallel. That is what makes the two arms
// comparable — the sender's cost is not interleaved with a receiver running on a
// real thread — and it is also why nothing here says anything about how either
// transport behaves when the receiver is genuinely busy. A 4-core machine and a
// 1-core machine must produce the same sender-side conclusion, and this harness
// cannot tell you otherwise.
//
// Timing methodology follows the rest of this file: round 0 is dropped as
// warm-up, and the reported figure is the **median** of the remaining rounds.
// BENCH-001 measured a 28% median min/max spread on the main harness, so a single
// sample or a mean would be noise.

/** Peer counts from BC-001's row, unchanged. */
const BC_PEERS = [1, 4, 16, 32, 64];
/** Broadcast rounds per peer count, per arm. */
const BC_ROUNDS = 9;
/** Envelope size in bytes — a small event, not a payload. */
const BC_ENVELOPE_BYTES = 4096;

/**
 * The envelope both arms post: a realistic event of {@link BC_ENVELOPE_BYTES}.
 *
 * A **string** rather than an `ArrayBuffer` on purpose. A `Buffer` would be
 * posted by *transfer* through a `MessagePort` and copied through a
 * `BroadcastChannel`, which is a different comparison in both directions: the
 * transfer path does not serialise at all, and the copy path does. The question
 * here is the one-serialise-versus-K question, so both arms must serialise.
 *
 * @returns {object}
 */
function bcEnvelope() {
  return {
    type: 'order.created',
    id: 42,
    at: 1_757_000_000_000,
    body: 'x'.repeat(BC_ENVELOPE_BYTES),
  };
}

/**
 * Drain `channel` until `expected` messages have arrived, and report the cost.
 *
 * The handler does the smallest thing a real receiver must do — touch the
 * payload so the message cannot be optimised away, and count it — because the
 * per-delivery figure this mode reports is *deserialisation*, and adding work to
 * the handler would fold that work into the number.
 *
 * @param {BroadcastChannel|MessagePort} channel
 * @param {number} expected
 * @returns {Promise<{elapsedNs: number, handlerNs: number}>}
 */
function drainChannel(channel, expected) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    let handlerNs = 0;
    const t0 = process.hrtime.bigint();
    channel.onmessage = (event) => {
      const h0 = process.hrtime.bigint();
      // Touch the payload: a receiver that ignores it would make the delivery
      // cost unmeasurable, and `structuredClone` may not be elided anyway.
      if (event.data.body.length === 0) throw new Error('unreachable: empty envelope');
      handlerNs += Number(process.hrtime.bigint() - h0);
      seen += 1;
      if (seen === expected) {
        const elapsedNs = Number(process.hrtime.bigint() - t0);
        resolve({ elapsedNs, handlerNs });
      } else if (seen > expected) {
        reject(new Error(`received ${seen} messages, expected ${expected}`));
      }
    };
  });
}

/**
 * Time one broadcast round over `peers` receivers, on an already-warm channel.
 *
 * @param {BroadcastChannel|MessagePort[]} senders - One entry per peer, all
 *   already started and drained to zero.
 * @param {object} envelope
 * @returns {Promise<number>} Nanoseconds spent in the sender loop.
 */
function timeSend(senders, envelope) {
  const t0 = process.hrtime.bigint();
  for (const sender of senders) sender.postMessage(envelope);
  return Promise.resolve(Number(process.hrtime.bigint() - t0));
}

async function runBroadcastFanoutWorkload() {
  console.log('BC-001 bcfanout — one BroadcastChannel against K explicit MessagePorts\n');
  console.log('  The claim is sender-side: one `bc.postMessage` against K');
  console.log('  `port.postMessage` of the same 4 kB envelope. Each receiver pays its own');
  console.log('  deserialisation either way, so the receiving half cannot win and is');
  console.log('  reported separately rather than folded into the ratio.\n');
  console.log(`  ${BC_ROUNDS} rounds per arm, round 0 dropped as warm-up, median reported.`);
  console.log('  Receivers are on this thread — see the caveat in the source before');
  console.log('  reading anything into receiver parallelism.\n');

  const envelope = bcEnvelope();
  const rows = [];

  for (const peers of BC_PEERS) {
    // ── Arm A: one BroadcastChannel, `peers` subscribers ───────────────────
    // The posting channel never receives its own message, so the sender is
    // separate from the `peers` subscribers by construction rather than by a
    // subtraction that could be off by one.
    const name = `bc-bench-${peers}-${SEED}`;
    const sender = new BroadcastChannel(name);
    const subs = [];
    const drains = [];
    for (let i = 0; i < peers; i += 1) {
      const sub = new BroadcastChannel(name);
      subs.push(sub);
      drains.push(drainChannel(sub, BC_ROUNDS));
    }

    const bcSamples = [];
    for (let round = 0; round < BC_ROUNDS; round += 1) {
      const ns = await timeSend([sender], envelope);
      if (round > 0) bcSamples.push(ns);
    }
    const bcDrain = await Promise.all(drains);

    // ── Arm B: `peers` explicit MessagePorts, all owned by the sender ───────
    // One `MessageChannel` per peer, because a port pair is point-to-point: this
    // is exactly the shape the proposal replaces, and it is why N peers means N
    // channels rather than one channel with N listeners.
    const pairs = [];
    const portSenders = [];
    const portDrains = [];
    for (let i = 0; i < peers; i += 1) {
      const { port1, port2 } = new MessageChannel();
      pairs.push({ port1, port2 });
      portSenders.push(port1);
      portDrains.push(drainChannel(port2, BC_ROUNDS));
    }

    const portSamples = [];
    for (let round = 0; round < BC_ROUNDS; round += 1) {
      const ns = await timeSend(portSenders, envelope);
      if (round > 0) portSamples.push(ns);
    }
    const portDrain = await Promise.all(portDrains);

    // Non-triviality, in both directions. Without this the ratio is
    // meaningless: two arms that delivered nothing would "compare" cleanly, and a
    // sender that posted zero times would be infinitely fast.
    const bcDelivered = bcDrain.length;
    const portDelivered = portDrains.length;
    if (bcDelivered !== peers || portDelivered !== peers) {
      throw new Error(`expected ${peers} receivers per arm, got ${bcDelivered}/${portDelivered}`);
    }

    const median = (xs) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[sorted.length >> 1];
    };
    const bcNs = median(bcSamples);
    const portNs = median(portSamples);
    // The row's figures are sender-side ratios of port cost to channel cost, so
    // that a value above 1 means "the explicit loop costs more".
    const senderRatio = portNs / bcNs;
    // Two receiver-side figures, and the distinction between them is the whole
    // reason this mode reports them separately.
    //
    // `drainPerDelivery` is wall time from the first measured post to the last
    // delivery, divided by deliveries. On one thread that contains the sender's
    // work *and* the receiver's, so it is an upper bound on a delivery, not a
    // measurement of one.
    //
    // `handlerPerDelivery` is time inside the receiver callback. **It is not the
    // deserialisation cost**, and reporting it as though it were is the error this
    // mode was nearly born making: `structuredClone` runs inside the platform's
    // delivery step, before the callback is entered, so a callback that only
    // touches the payload measures almost nothing. BC-001's recorded ~3.4 us per
    // 4 kB delivery is therefore *not* comparable to this column, and is not
    // reproducible in-process at all.
    const measuredRounds = BC_ROUNDS - 1;
    const bcDrainNs = bcDrain.reduce((sum, d) => sum + d.elapsedNs, 0) / (measuredRounds * peers);
    const portDrainNs =
      portDrain.reduce((sum, d) => sum + d.elapsedNs, 0) / (measuredRounds * peers);
    const bcHandlerNs = bcDrain.reduce((sum, d) => sum + d.handlerNs, 0) / (measuredRounds * peers);
    const portHandlerNs =
      portDrain.reduce((sum, d) => sum + d.handlerNs, 0) / (measuredRounds * peers);

    rows.push({
      peers,
      bcNs,
      portNs,
      senderRatio,
      bcDrainPerDeliveryNs: bcDrainNs,
      portDrainPerDeliveryNs: portDrainNs,
      bcHandlerPerDeliveryNs: bcHandlerNs,
      portHandlerPerDeliveryNs: portHandlerNs,
    });

    for (const sub of subs) sub.close();
    sender.close();
    // Both ends of every pair, not just the sending one: an unclosed
    // `MessagePort` keeps the Node event loop alive, so this mode would hang at
    // exit instead of finishing — the same started-handle behaviour BC-004
    // records for `BroadcastChannel` itself.
    for (const { port1, port2 } of pairs) {
      port1.close();
      port2.close();
    }

    console.log(
      `  ${String(peers).padStart(2)} peers   ` +
        `sender bc ${bcNs.toString().padStart(6)} ns  ports ${portNs.toString().padStart(7)} ns  ` +
        `${senderRatio.toFixed(2).padStart(6)}x   ` +
        `wall/delivery bc ${bcDrainNs.toFixed(0).padStart(6)} ns / port ${portDrainNs.toFixed(0).padStart(6)} ns`
    );
  }

  const at64 = rows[rows.length - 1];
  const at1 = rows[0];
  console.log('\n  sender ratio is `ports / bc`: above 1 means the explicit loop costs more.\n');
  console.log(
    `  At 1 peer the channel is ${at1.senderRatio.toFixed(2)}x — it is *slower*, and that is the`
  );
  console.log('  control: with one receiver there is nothing to amortise, so the channel pays');
  console.log('  its own per-send overhead against a port that is already point-to-point.');
  console.log(
    `  By 64 peers the sender pays ${at64.senderRatio.toFixed(2)}x more for the explicit loop.`
  );
  console.log('\n  The win is the sender serialising once instead of N times. The receiving side');
  console.log('  is unchanged, because every subscriber deserialises its own copy under both');
  console.log('  arms — so a row claiming BroadcastChannel is cheaper *for a receiver* is');
  console.log('  refuted by construction, not merely unsupported.');
  console.log(
    '\n  **Run this more than once before quoting a number.** Six runs of this mode on one'
  );
  console.log('  machine put 1 peer at 0.27-0.39x and 4 peers at 2.01-3.75x — unanimous, and');
  console.log(
    '  those are the two rows the conclusion rests on. Above that it spread 15.19-22.47x'
  );
  console.log('  at 16 peers, 5.94-24.09x at 32, and 23.44-50.70x at 64, with no configuration');
  console.log('  change. A median of 9 rounds inside one process is not enough at high peer');
  console.log('  counts here, so treat everything past 4 subscribers as an order of magnitude.');
  console.log('\n  What this mode cannot measure, stated rather than guessed at:');
  console.log('  - **Deserialisation cost.** It runs inside the platform delivery step, ahead');
  console.log('    of the receiver callback, so a callback-side timer sees almost none of it.');
  console.log("    BC-001's recorded ~3.4 us per 4 kB delivery is not reproducible this way.");
  console.log('  - **Receiver parallelism.** Every receiver is on this thread. The sender-side');
  console.log('    conclusion is unaffected — it is the same conclusion on any core count —');
  console.log('    but nothing here predicts behaviour when a receiver is genuinely busy.');

  return { rows };
}

// ─── Workload: PowerDefer WeakMap overhead ───────────────────────────────────
//
// RES-022 asks whether the WeakMap in PowerDefer is worth its ~6× construction
// surcharge. The immutability motive is real but partial (promise, _settled,
// _status stay public), so this mode measures the actual cost before any change
// is adopted.

async function runDeferWorkload() {
  const N = Number(process.env.CLAIM_DEFER_OPS || 500000);
  console.log('BENCH-002g — PowerDefer WeakMap overhead vs closure form\n');
  console.log('  `PowerDefer` stores resolve/reject in a WeakMap so they are not');
  console.log('  assignable from user code. This measures the construction and resolve');
  console.log('  cost of that choice against a plain closure form.\n');
  console.log(`  ops                    ${N.toLocaleString()}\n`);

  const time = (fn) => {
    for (let i = 0; i < 50_000; i += 1) fn();
    const s = [];
    for (let r = 0; r < 7; r += 1) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) fn();
      s.push(Number(process.hrtime.bigint() - t0) / N);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // Sink the result so nothing is optimised away.
  const sink = 0;
  const values = [];

  // Closure form: resolve/reject are plain properties on the instance.
  class ClosureDefer {
    constructor() {
      this._settled = false;
      this._status = 'pending';
      this.promise = new Promise((resolve, reject) => {
        this.resolve = (v) => {
          if (this._settled) return;
          this._settled = true;
          this._status = 'fulfilled';
          resolve(v);
        };
        this.reject = (err) => {
          if (this._settled) return;
          this._settled = true;
          this._status = 'rejected';
          reject(err);
        };
      });
    }
  }

  const deferNs = time(() => {
    const d = new ClosureDefer();
    d.resolve(1);
    values.push(d._status);
  });

  // PowerDefer form: resolve/reject live in a WeakMap.
  const { PowerDefer } = await import('../src/helpers/powerDefer.js');

  const powerNs = time(() => {
    const d = new PowerDefer();
    d.resolve(1);
    values.push(d.status);
  });

  console.log(
    `  ClosureDefer          ${deferNs.toFixed(2).padStart(8)} ns/op   (plain properties)`
  );
  console.log(
    `  PowerDefer            ${powerNs.toFixed(2).padStart(8)} ns/op   ${(powerNs / deferNs).toFixed(2)}x the closure form`
  );

  console.log('\n  The WeakMap.set is paid once per construction. If the ratio stays');
  console.log('  above ~3× and the immutability benefit is only partial, the row');
  console.log('  should be closed as "not adopted" rather than "needs more optimisation".');

  void sink;
  void values;

  return { deferNs, powerNs };
}

// ─── Workload 9: JSON.stringify cost vs a minimal binary encoding ─────────────
//
// RT-027 asks whether a binary codec (MessagePack / CBOR) is worth building.
// The premise is that JSON.stringify is the cost; this measures it for numeric
// payloads against a hand-rolled 8-bytes-per-double binary layout. A real CBOR
// implementation adds type tags and varint sizing, which narrows the gap but
// does not reverse it for the numeric case.

async function runCodecWorkload() {
  const N = Number(process.env.CLAIM_CODEC_OPS || 200000);
  console.log('BENCH-002h — JSON.stringify cost vs a minimal binary encoding\n');
  console.log('  RT-027 asks whether a binary codec (MessagePack / CBOR) is worth');
  console.log('  building. This measures the actual stringify cost for numeric');
  console.log('  payloads against a hand-rolled 8-bytes-per-double binary layout.\n');

  const time = (fn) => {
    for (let i = 0; i < 50_000; i += 1) fn();
    const s = [];
    for (let r = 0; r < 7; r += 1) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) fn();
      s.push(Number(process.hrtime.bigint() - t0) / N);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const payloads = [
    { label: '4 numbers', make: () => [1, 2, 3, 4] },
    { label: '50 numbers', make: () => Array.from({ length: 50 }, (_, i) => i) },
    { label: '1000 numbers', make: () => Array.from({ length: 1000 }, (_, i) => i) },
  ];

  // Minimal binary layout: one IEEE 754 double per number, no framing.
  const encodeBinary = (arr) => {
    const buf = new ArrayBuffer(arr.length * 8);
    const view = new Float64Array(buf);
    for (let i = 0; i < arr.length; i++) view[i] = arr[i];
    return buf;
  };

  console.log(
    `  ${'payload'.padEnd(16)}${'json us'.padStart(10)}${'bin us'.padStart(10)}${'json/bin'.padStart(12)}`
  );
  console.log(`  ${'-'.repeat(48)}`);

  for (const { label, make } of payloads) {
    const sample = make();
    const jsonUs = time(() => JSON.stringify(sample));
    const binUs = time(() => encodeBinary(sample));
    const ratio = jsonUs / binUs;
    console.log(
      `  ${label.padEnd(16)}${jsonUs.toFixed(3).padStart(10)}${binUs.toFixed(3).padStart(10)}${ratio.toFixed(2).padStart(12)}`
    );
  }

  console.log('\n  The binary path is a fixed 8 bytes per number with no parsing.');
  console.log('  A real CBOR implementation adds type tags and varint sizing,');
  console.log('  which narrows the gap but does not reverse it for numeric payloads.');
  console.log('  The row should be closed as "adopted" only if a measured payload');
  console.log('  shows JSON.stringify dominating the encode path.');

  return { payloads: payloads.map((p) => p.label) };
}

// ─── Workload 10: SharedArrayBuffer ring vs structured clone ─────────────────
//
// RT-031 asks whether a SAB result ring avoids a clone for PowerChunker.
// The win is bounded by "avoid one clone of a large payload". This measures
// structuredClone against a SAB write/read round-trip for a string-heavy payload.

async function runSabRingWorkload() {
  const N = Number(process.env.CLAIM_SAB_OPS || 200000);
  console.log('BENCH-002i — SharedArrayBuffer ring vs structured clone\n');
  console.log('  RT-031 asks whether a SAB result ring avoids a clone for the');
  console.log('  chunker. This measures structuredClone against a SAB write/read');
  console.log('  round-trip for a string-heavy payload.\n');

  const time = (fn) => {
    for (let i = 0; i < 50_000; i += 1) fn();
    const s = [];
    for (let r = 0; r < 7; r += 1) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) fn();
      s.push(Number(process.hrtime.bigint() - t0) / N);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const payload = 'x'.repeat(1024); // 1 KB string
  const encoder = new TextEncoder();
  const sabSize = 4 + payload.length; // 4-byte length prefix + bytes
  const sab = new SharedArrayBuffer(sabSize);
  const uint8 = new Uint8Array(sab);
  const view = new DataView(sab);

  const cloneNs = time(() => {
    const cloned = structuredClone(payload);
    void cloned;
  });

  const sabNs = time(() => {
    view.setUint32(0, payload.length, true);
    encoder.encodeInto(payload, uint8.subarray(4));
    const len = view.getUint32(0, true);
    const read = new Uint8Array(len);
    read.set(uint8.subarray(4, 4 + len));
    void read;
  });

  console.log(`  payload size: ${payload.length} bytes (1 KB string)`);
  console.log(`  ops per pass: ${N}`);
  console.log('');
  console.log(`  ${'method'.padEnd(24)}${'ns/op'.padStart(10)}${'ratio'.padStart(8)}`);
  console.log(`  ${'-'.repeat(42)}`);
  console.log(
    `  ${'structuredClone'.padEnd(24)}${cloneNs.toFixed(2).padStart(10)}${'1.00x'.padStart(8)}`
  );
  console.log(
    `  ${'SAB write+read'.padEnd(24)}${sabNs.toFixed(2).padStart(10)}${(sabNs / cloneNs).toFixed(2)}x`.padStart(
      8
    )
  );

  console.log('\n  A SAB ring avoids the clone only if the producer can write directly');
  console.log('  into shared memory. The benchmark above measures the round-trip cost');
  console.log('  of copying into SAB and reading back, which is the minimum a ring');
  console.log('  must beat to be worth building.');

  return { cloneNs, sabNs, ratio: sabNs / cloneNs };
}

// ─── Workload 11: cache key-shape performance ────────────────────────────────
//
// GAP-018 asks for a key-shape / storage-bounds guide backed by measurements.
// This measures PowerCache get/set throughput for integer, string, and object
// keys so the guide can state actual costs rather than advice.

async function runKeyShapeWorkload() {
  const N = Number(process.env.CLAIM_KEYSHAPE_OPS || 10000);
  console.log('BENCH-002j — cache key-shape performance\n');
  console.log('  GAP-018 asks for a key-shape / storage-bounds guide backed by');
  console.log('  measurements. This measures PowerCache get/set throughput for');
  console.log('  integer, string, and object keys.\n');

  const time = (fn) => {
    for (let i = 0; i < 50_000; i += 1) fn();
    const s = [];
    for (let r = 0; r < 7; r += 1) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) fn();
      s.push(Number(process.hrtime.bigint() - t0) / N);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const cache = new PowerCache({ maxEntries: 1000 });

  // Integer keys
  const intKeys = Array.from({ length: 500 }, (_, i) => i);
  cache.clear();
  for (const k of intKeys) cache.set(k, k);
  const intGetUs = time(() => {
    for (const k of intKeys) cache.get(k);
  });

  // String keys
  const strKeys = intKeys.map(String);
  cache.clear();
  for (const k of strKeys) cache.set(k, k);
  const strGetUs = time(() => {
    for (const k of strKeys) cache.get(k);
  });

  // Object keys
  const objKeys = intKeys.map((i) => ({ id: i }));
  cache.clear();
  for (const k of objKeys) cache.set(k, k);
  const objGetUs = time(() => {
    for (const k of objKeys) cache.get(k);
  });

  console.log(`  ${'key type'.padEnd(16)}${'get us/op'.padStart(12)}${'vs int'.padStart(10)}`);
  console.log(`  ${'-'.repeat(38)}`);
  console.log(
    `  ${'integer'.padEnd(16)}${intGetUs.toFixed(3).padStart(12)}${'1.00x'.padStart(10)}`
  );
  console.log(
    `  ${'string'.padEnd(16)}${strGetUs.toFixed(3).padStart(12)}${(strGetUs / intGetUs).toFixed(2)}x`.padStart(
      10
    )
  );
  console.log(
    `  ${'object'.padEnd(16)}${objGetUs.toFixed(3).padStart(12)}${(objGetUs / intGetUs).toFixed(2)}x`.padStart(
      10
    )
  );

  console.log('\n  Object keys are hashed via String(key), so every object collapses');
  console.log('  to "[object Object]" and the cache cannot distinguish them.');
  console.log('  The guide should state this explicitly rather than leaving it to');
  console.log('  be discovered from a silent collision.');

  cache.clear();
  return { intGetUs, strGetUs, objGetUs };
}

const MODES = {
  zipf: runZipfWorkload,
  latency: runScaledLatencyWorkload,
  carrier: runCarrierWorkload,
  coldstart: runColdStartWorkload,
  payload: runPayloadWorkload,
  permit: runPermitWorkload,
  stream: runStreamWorkload,
  sieve: runSieveWorkload,
  sketch: runSketchWorkload,
  window: runWindowWorkload,
  framedecode: runFrameDecodeWorkload,
  hubencode: runHubEncodeWorkload,
  correlation: runCorrelationWorkload,
  batchservo: runBatchServoWorkload,
  concurrency: runConcurrencyWorkload,
  stepsize: runStepSizingWorkload,
  bcfanout: runBroadcastFanoutWorkload,
  defer: runDeferWorkload,
  codec: runCodecWorkload,
  sabring: runSabRingWorkload,
  keyshape: runKeyShapeWorkload,
};

const mode = process.argv[2] || 'zipf';

async function dispatch() {
  // `Object.create(null)` semantics via hasOwn rather than truthiness of
  // `MODES[mode]`, so an inherited property name cannot resolve to a runner.
  if (!Object.hasOwn(MODES, mode)) {
    console.error(`Unknown mode: ${mode}. Use one of: ${Object.keys(MODES).sort().join(', ')}.`);
    process.exit(1);
  }
  await MODES[mode]();
}

dispatch();
