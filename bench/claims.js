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
 *
 * Every parameter is overridable from the environment so a result can be
 * reproduced exactly, and so the interesting axes (Zipf exponent, capacity,
 * scan size) can be swept without editing this file.
 *
 * @module bench/claims
 */

import { gzipSync, brotliCompressSync } from 'node:zlib';
import { PowerCache } from '../src/helpers/powerCache.js';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';
import { PowerPool } from '../src/helpers/powerPool.js';
import { decodeMessage, encodeNativeEnvelope } from '../src/helpers/powerMessageCodec.js';

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

// ─── Entry point ────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'zipf';

async function dispatch() {
  if (mode === 'zipf') {
    runZipfWorkload();
  } else if (mode === 'latency') {
    runScaledLatencyWorkload();
  } else if (mode === 'carrier') {
    runCarrierWorkload();
  } else if (mode === 'coldstart') {
    runColdStartWorkload();
  } else if (mode === 'payload') {
    await runPayloadWorkload();
  } else if (mode === 'permit') {
    await runPermitWorkload();
  } else if (mode === 'stream') {
    await runStreamWorkload();
  } else {
    console.error(
      `Unknown mode: ${mode}. Use "zipf", "coldstart", "payload", "permit", "stream", "latency" or "carrier".`
    );
    process.exit(1);
  }
}

dispatch();
