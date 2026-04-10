import { Worker as NodeWorker } from 'worker_threads';
import { writeFileSync, readFileSync } from 'fs';
// Expose Node Worker as global Worker so PowerPool can use it
globalThis.Worker = NodeWorker;

import { PowerPool } from '../src/helpers/powerPool.js';
import { PowerCache, PowerMemoizer } from '../src/helpers/powerCache.js';
import { o2u8 } from '../src/helpers/powerBuffer.js';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerRetry } from '../src/helpers/powerRetry.js';
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerBatch } from '../src/helpers/powerBatch.js';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';
import { PowerDeadline } from '../src/helpers/powerDeadline.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerQueue } from '../src/helpers/powerQueue.js';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

const args = process.argv.slice(2);
const mode = args[0] || 'all';
const TASKS = Number(process.env.BENCH_TASKS || 1000);
const ITERS = Number(process.env.BENCH_ITERS || 1000000);
const POOL_SIZES = (process.env.BENCH_POOLS || '1,2,4,8').split(',').map((s) => Number(s));
const CACHE_DUPLICATE_KEYS = Number(process.env.BENCH_CACHE_DUPLICATE_KEYS || 10);
const MEMOIZER_DUPLICATE_KEYS = Number(process.env.BENCH_MEMOIZER_DUPLICATE_KEYS || 10);
const AUTOSCALE_CACHE_KEYS = Number(process.env.BENCH_AUTOSCALE_CACHE_KEYS || 10);
// How many times to repeat each helper micro-benchmark; median is reported.
const BENCH_RUNS = Math.max(1, Number(process.env.BENCH_RUNS || 5));
// How many times to repeat each pool/scenario variant; median is reported.
// Defaults to 1 because pool runs are slow; set to 3 for more stable results.
const POOL_RUNS = Math.max(1, Number(process.env.BENCH_POOL_RUNS || 3));
// Number of operations for helper micro-benchmarks.
const HELPER_OPS = Number(process.env.BENCH_HELPER_OPS || 100000);
// Timeout for PowerPool per-pool run in ms. Set to 0 to disable timeout.
// Default to 0 so the harness exercises PowerPool fully unless overridden.
const POOL_TIMEOUT =
  process.env.BENCH_POOL_TIMEOUT === undefined ? 0 : Number(process.env.BENCH_POOL_TIMEOUT);

const LOAD_PROFILES = [
  { name: '0% variable', variableFraction: 0 },
  { name: '25% variable', variableFraction: 0.25 },
  { name: '50% variable', variableFraction: 0.5 },
  { name: '75% variable', variableFraction: 0.75 },
  { name: '100% variable', variableFraction: 1 },
];

function sampleIterations(baseIterations) {
  return Math.max(
    1,
    Math.round(randomNormalArray(1, baseIterations, Math.max(1, baseIterations * 0.25))[0])
  );
}

function buildLoadProfile(tasks, baseIterations, variableFraction) {
  const uniqueTaskCount = Math.round(tasks * variableFraction);
  const repeatedTaskCount = tasks - uniqueTaskCount;
  const repeatedKeyCount =
    variableFraction === 0
      ? Math.max(1, Math.min(10, Math.round(repeatedTaskCount / 100)))
      : Math.max(1, Math.min(10, Math.round(repeatedTaskCount / 10)));
  const repeatedIterations = new Array(repeatedKeyCount)
    .fill(null)
    .map(() => sampleIterations(baseIterations));

  const taskEntries = [];
  for (let i = 0; i < repeatedTaskCount; i += 1) {
    const keyIndex = i % repeatedKeyCount;
    taskEntries.push({
      key: `rep:${keyIndex}`,
      iterations: repeatedIterations[keyIndex],
    });
  }
  for (let i = 0; i < uniqueTaskCount; i += 1) {
    taskEntries.push({
      key: `uni:${i}`,
      iterations: sampleIterations(baseIterations),
    });
  }

  for (let i = taskEntries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [taskEntries[i], taskEntries[j]] = [taskEntries[j], taskEntries[i]];
  }

  return {
    iterations: taskEntries.map((entry) => entry.iterations),
    keys: taskEntries.map((entry) => entry.key),
  };
}

// Generate samples from a normal distribution using Box-Muller transform.
// Works like numpy.random.normal: mean and std can be provided.
function randomNormalArray(n, mean = 0, std = 1) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.random() || 1e-12;
    const u2 = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    out[i] = z0 * std + mean;
    if (i + 1 < n) out[i + 1] = z1 * std + mean;
  }
  return out;
}

function heavy(iterations) {
  let s = 0;
  for (let i = 0; i < iterations; i++) s += Math.sqrt(i);
  return s;
}

async function runSingleThreaded(tasks, iterations) {
  const durations = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    const s0 = process.hrtime.bigint();
    heavy(iterations);
    const s1 = process.hrtime.bigint();
    durations.push(Number(s1 - s0) / 1e6);
  }
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const durationStats = computeDurationStats(durations);
  return {
    totalMs,
    avgMs: durationStats.avg,
    throughput: totalMs > 0 ? tasks / (totalMs / 1000) : 0,
    durations,
    durationStats,
  };
}

async function runSingleThreadedVariable(tasks, iterationsArray) {
  const durations = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    const iters = Math.max(1, Math.round(iterationsArray[i]));
    const s0 = process.hrtime.bigint();
    heavy(iters);
    const s1 = process.hrtime.bigint();
    durations.push(Number(s1 - s0) / 1e6);
  }
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const durationStats = computeDurationStats(durations);
  return {
    totalMs,
    avgMs: durationStats.avg,
    throughput: totalMs > 0 ? tasks / (totalMs / 1000) : 0,
    durations,
    durationStats,
  };
}

function createWorkerPool(poolSize, autoscale = false, queuePolicy = 'enqueue') {
  const options = {
    size: autoscale ? 1 : poolSize,
    minSize: autoscale ? 1 : poolSize,
    maxSize: poolSize,
    idleTimeout: 10000,
    taskQueue: true,
    queuePolicy,
    lazy: autoscale,
    workerOptions: { type: 'module' },
  };
  if (autoscale) {
    options.maxTasksPerWorker = 1;
    options.autoScale = {
      enabled: true,
      intervalMs: 50,
      targetMs: 10,
      cooldownMs: 100,
      hysteresis: 0.2,
      backoffFactor: 2,
      backoffResetMs: 1000,
    };
  }
  return new PowerPool('./bench/worker.js', options);
}

function makePayload(iterations, opts = {}) {
  const payload = { iterations };
  if (typeof opts.asyncWaitMs === 'number') payload.asyncWaitMs = opts.asyncWaitMs;
  if (typeof opts.payloadSize === 'number' && opts.payloadSize > 0) {
    payload.payload = 'x'.repeat(opts.payloadSize);
  }
  return payload;
}

function normalizeIteration(iterations, index) {
  return Array.isArray(iterations) ? Math.max(1, Math.round(iterations[index])) : iterations;
}

function repeatedKey(i, uniqueKeys) {
  return `key:${i % uniqueKeys}`;
}

async function runWorkerPool(poolSize, tasks, iterations) {
  const pool = createWorkerPool(poolSize, false);
  const instrumentation = {
    encodeTotalMs: 0,
    postTotalMs: 0,
    messagesReceived: 0,
    decodeTotalMs: 0,
    computeTotalMs: 0,
  };

  pool.onmessage = (e) => {
    const payload = e && e.data ? e.data : e;
    if (payload && typeof payload === 'object') {
      if (typeof payload.decodeDuration === 'number')
        instrumentation.decodeTotalMs += payload.decodeDuration;
      if (typeof payload.duration === 'number') instrumentation.computeTotalMs += payload.duration;
      instrumentation.messagesReceived++;
    }
  };

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    const iters = normalizeIteration(iterations, i);
    const encStart = process.hrtime.bigint();
    const payload = o2u8({ iterations: iters });
    instrumentation.encodeTotalMs += Number(process.hrtime.bigint() - encStart) / 1e6;

    const postStart = process.hrtime.bigint();
    pool.postMessage(payload, [payload.buffer]);
    instrumentation.postTotalMs += Number(process.hrtime.bigint() - postStart) / 1e6;
  }

  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs =
    perf.timePerTask && typeof perf.timePerTask.average === 'number' && perf.timePerTask.average > 0
      ? perf.timePerTask.average
      : tasks
        ? totalMs / tasks
        : 0;

  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation };
}

async function runWorkerPoolOptimized(poolSize, tasks, iterations, keys) {
  const pool = createWorkerPool(poolSize, false);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });

  const taskPromises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    const iters = normalizeIteration(iterations, i);
    const key = keys && keys[i] != null ? keys[i] : `key:${i}`;
    taskPromises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage({ iterations: iters }, undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
  }

  await Promise.all(taskPromises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;

  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolAutoscale(poolSize, tasks, iterations) {
  const pool = createWorkerPool(poolSize, true);
  const taskPromises = new Array(tasks);
  const t0 = process.hrtime.bigint();

  for (let i = 0; i < tasks; i++) {
    const iters = normalizeIteration(iterations, i);
    taskPromises[i] = pool.postMessage({ iterations: iters }, undefined, { awaitResponse: true });
  }

  await Promise.all(taskPromises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;

  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolAutoscaleOptimized(poolSize, tasks, iterations, keys) {
  const pool = createWorkerPool(poolSize, true);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });

  const taskPromises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    const iters = normalizeIteration(iterations, i);
    const key = keys && keys[i] != null ? keys[i] : `key:${i}`;
    taskPromises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage({ iterations: iters }, undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
  }

  await Promise.all(taskPromises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;

  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a pool benchmark function POOL_RUNS times and return the result
 * whose totalMs is closest to the median (preserving the full result object).
 */
async function poolMedian(fn) {
  if (POOL_RUNS === 1) return fn();
  const results = [];
  for (let i = 0; i < POOL_RUNS; i++) results.push(await fn());
  const times = results.map((r) => r.totalMs);
  const med = medianOf(times);
  // Return the result whose totalMs is closest to the median.
  return results.reduce((a, b) => (Math.abs(a.totalMs - med) <= Math.abs(b.totalMs - med) ? a : b));
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ─── Statistics helpers ────────────────────────────────────────────────────

/** Return the p-th percentile (0–100) of a pre-sorted numeric array. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Compute summary stats from a durations array (ms). */
function computeDurationStats(durations) {
  if (!durations || !durations.length) return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = durations.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** Median of a numeric array (mutates a copy). */
function medianOf(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/** Current heap usage in kilobytes. */
function heapKb() {
  return Math.round(process.memoryUsage().heapUsed / 1024);
}

/** Load the previous results.json at the repository root, or null. */
function loadPreviousResults() {
  try {
    return JSON.parse(readFileSync('results.json', 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build a flat lookup: scenario/profile key -> best totalMs across pool sizes.
 * Key format: "<profiles|scenarios>/<name>/<pattern>"
 */
function buildDeltaMap(report) {
  const map = new Map();
  if (!report) return map;
  const patternKeys = ['pool', 'optimizedPool', 'autoscalePool', 'autoscaleOptimizedPool'];
  for (const section of ['profiles', 'scenarios']) {
    for (const item of report[section] || []) {
      for (const pk of patternKeys) {
        const arr = item[pk];
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
          if (typeof entry.totalMs === 'number' && entry.totalMs > 0) {
            map.set(`${section}/${item.name}/${pk}/${entry.size}`, entry.totalMs);
          }
        }
      }
    }
  }
  // Helper benchmarks
  for (const h of report.helpers || []) {
    for (const v of h.variants || []) {
      if (typeof v.totalMs === 'number') {
        map.set(`helpers/${h.name}/${v.label}`, v.totalMs);
      }
    }
  }
  return map;
}

/**
 * Format a delta string like "+12.3%" / "-8.1%" / "(new)" given current and previous values.
 */
function formatDelta(current, prev) {
  if (prev == null || prev === 0) return '(new)';
  const pct = ((current - prev) / prev) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function buildMixedSizeProfile(tasks, baseIterations) {
  const smallIterations = Math.max(1, Math.round(baseIterations * 0.1));
  const largeIterations = Math.max(1, Math.round(baseIterations * 2));
  const repeatedKeyCount = Math.max(1, Math.min(20, Math.round(tasks / 10)));
  const entries = [];
  for (let i = 0; i < tasks; i += 1) {
    const iters = i % 2 === 0 ? smallIterations : largeIterations;
    entries.push({ iterations: iters, key: `mix:${i % repeatedKeyCount}` });
  }
  const shuffled = shuffleArray(entries);
  return {
    iterations: shuffled.map((entry) => entry.iterations),
    keys: shuffled.map((entry) => entry.key),
  };
}

function buildCacheHitRatioProfile(tasks, baseIterations, hitRatio) {
  const repeatedCount = Math.round(tasks * hitRatio);
  const uniqueCount = tasks - repeatedCount;
  const repeatedKeyCount = Math.max(1, Math.min(50, Math.round(repeatedCount / 10)));
  const entries = [];
  for (let i = 0; i < repeatedCount; i += 1) {
    entries.push({ iterations: baseIterations, key: `hot:${i % repeatedKeyCount}` });
  }
  for (let i = 0; i < uniqueCount; i += 1) {
    entries.push({ iterations: baseIterations, key: `uni:${i}` });
  }
  const shuffled = shuffleArray(entries);
  return {
    iterations: shuffled.map((entry) => entry.iterations),
    keys: shuffled.map((entry) => entry.key),
  };
}

function buildThunderingHerdProfile(tasks, baseIterations) {
  return {
    iterations: new Array(tasks).fill(baseIterations),
    keys: new Array(tasks).fill('herd:key'),
  };
}

function buildBurstKeys(tasks, activeKeys = 10) {
  return Array.from({ length: tasks }, (_, i) => `burst:${i % activeKeys}`);
}

async function runWorkerPoolBurst(poolSize, tasks, iterations) {
  const pool = createWorkerPool(poolSize, false);
  const t0 = process.hrtime.bigint();
  const burstCount = 3;
  const tasksPerBurst = Math.ceil(tasks / burstCount);
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const payload = o2u8({ iterations: iters });
    pool.postMessage(payload, [payload.buffer]);
    if ((i + 1) % tasksPerBurst === 0 && i + 1 < tasks) {
      await delay(25);
    }
  }
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolBurstOptimized(poolSize, tasks, iterations, keys) {
  const pool = createWorkerPool(poolSize, false);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const t0 = process.hrtime.bigint();
  const burstCount = 3;
  const tasksPerBurst = Math.ceil(tasks / burstCount);

  const promises = new Array(tasks);
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage({ iterations: iters }, undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
    if ((i + 1) % tasksPerBurst === 0 && i + 1 < tasks) {
      await delay(25);
    }
  }

  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolBurstAutoscale(poolSize, tasks, iterations) {
  const pool = createWorkerPool(poolSize, true);
  const t0 = process.hrtime.bigint();
  const burstCount = 3;
  const tasksPerBurst = Math.ceil(tasks / burstCount);
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    pool.postMessage({ iterations: iters }, undefined, { awaitResponse: true });
    if ((i + 1) % tasksPerBurst === 0 && i + 1 < tasks) {
      await delay(25);
    }
  }
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolBurstAutoscaleOptimized(poolSize, tasks, iterations, keys) {
  const pool = createWorkerPool(poolSize, true);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const t0 = process.hrtime.bigint();
  const burstCount = 3;
  const tasksPerBurst = Math.ceil(tasks / burstCount);

  const promises = new Array(tasks);
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage({ iterations: iters }, undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
    if ((i + 1) % tasksPerBurst === 0 && i + 1 < tasks) {
      await delay(25);
    }
  }

  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

function buildRampTrafficProfile(tasks, baseIterations) {
  const keyCount = Math.max(1, Math.min(20, Math.round(tasks / 10)));
  const keys = Array.from({ length: tasks }, (_, i) => `ramp:${i % keyCount}`);
  return { iterations: new Array(tasks).fill(baseIterations), keys };
}

async function runWorkerPoolRampTraffic(poolSize, tasks, iterations) {
  const pool = createWorkerPool(poolSize, false);
  const t0 = process.hrtime.bigint();
  const phases = [15, 30, 60, 30];
  const tasksPerPhase = Math.ceil(tasks / phases.length);

  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const payload = o2u8(makePayload(iters));
    pool.postMessage(payload, [payload.buffer]);
    const phase = Math.min(Math.floor(i / tasksPerPhase), phases.length - 1);
    if ((i + 1) % tasksPerPhase === 0 && i + 1 < tasks) {
      await delay(phases[phase]);
    }
  }

  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolRampTrafficOptimized(poolSize, tasks, iterations, keys) {
  const pool = createWorkerPool(poolSize, false);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const t0 = process.hrtime.bigint();
  const phases = [15, 30, 60, 30];
  const tasksPerPhase = Math.ceil(tasks / phases.length);

  const promises = new Array(tasks);
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage(makePayload(iters), undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
    const phase = Math.min(Math.floor(i / tasksPerPhase), phases.length - 1);
    if ((i + 1) % tasksPerPhase === 0 && i + 1 < tasks) {
      await delay(phases[phase]);
    }
  }

  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolRampTrafficAutoscale(poolSize, tasks, iterations) {
  const pool = createWorkerPool(poolSize, true);
  const t0 = process.hrtime.bigint();
  const phases = [15, 30, 60, 30];
  const tasksPerPhase = Math.ceil(tasks / phases.length);

  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    pool.postMessage(makePayload(iters), undefined, { awaitResponse: true });
    const phase = Math.min(Math.floor(i / tasksPerPhase), phases.length - 1);
    if ((i + 1) % tasksPerPhase === 0 && i + 1 < tasks) {
      await delay(phases[phase]);
    }
  }

  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolRampTrafficAutoscaleOptimized(poolSize, tasks, iterations, keys) {
  const pool = createWorkerPool(poolSize, true);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const t0 = process.hrtime.bigint();
  const phases = [15, 30, 60, 30];
  const tasksPerPhase = Math.ceil(tasks / phases.length);

  const promises = new Array(tasks);
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage(makePayload(iters), undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
    const phase = Math.min(Math.floor(i / tasksPerPhase), phases.length - 1);
    if ((i + 1) % tasksPerPhase === 0 && i + 1 < tasks) {
      await delay(phases[phase]);
    }
  }

  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

function buildPayloadSizeProfile(tasks, baseIterations) {
  const payloadSizes = [0, 1000, 5000, 15000];
  const keyCount = Math.max(1, Math.min(20, Math.round(tasks / 10)));
  const entries = Array.from({ length: tasks }, (_, i) => ({
    iterations: baseIterations,
    key: `payload:${i % keyCount}`,
    payloadSize: payloadSizes[i % payloadSizes.length],
  }));
  const shuffled = shuffleArray(entries);
  return {
    iterations: shuffled.map((entry) => entry.iterations),
    keys: shuffled.map((entry) => entry.key),
    payloadSizes: shuffled.map((entry) => entry.payloadSize),
  };
}

async function runWorkerPoolPayloadSize(poolSize, tasks, iterations, payloadSizes) {
  const pool = createWorkerPool(poolSize, false);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const payload = makePayload(iters, { payloadSize: payloadSizes[i] });
    const enc = o2u8(payload);
    pool.postMessage(enc, [enc.buffer]);
  }
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolPayloadSizeOptimized(poolSize, tasks, iterations, keys, payloadSizes) {
  const pool = createWorkerPool(poolSize, false);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const promises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    const payloadSize = payloadSizes[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () =>
        pool.postMessage(makePayload(iters, { payloadSize }), undefined, { awaitResponse: true }),
      { ttl: 60000 }
    );
  }
  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolPayloadSizeAutoscale(poolSize, tasks, iterations, payloadSizes) {
  const pool = createWorkerPool(poolSize, true);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const payload = makePayload(iters, { payloadSize: payloadSizes[i] });
    pool.postMessage(payload, undefined, { awaitResponse: true });
  }
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolPayloadSizeAutoscaleOptimized(
  poolSize,
  tasks,
  iterations,
  keys,
  payloadSizes
) {
  const pool = createWorkerPool(poolSize, true);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const promises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () =>
        pool.postMessage(makePayload(iters, { payloadSize: payloadSizes[i] }), undefined, {
          awaitResponse: true,
        }),
      { ttl: 60000 }
    );
  }
  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

function buildIOBoundProfile(tasks, baseIterations) {
  const keyCount = Math.max(1, Math.min(20, Math.round(tasks / 10)));
  return {
    iterations: new Array(tasks).fill(baseIterations),
    keys: Array.from({ length: tasks }, (_, i) => `io:${i % keyCount}`),
    asyncWaitMs: new Array(tasks).fill(5),
  };
}

async function runWorkerPoolIOBound(poolSize, tasks, iterations, waitMs) {
  const pool = createWorkerPool(poolSize, false);
  const t0 = process.hrtime.bigint();

  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    pool.postMessage(makePayload(iters, { asyncWaitMs: waitMs }), undefined, {
      awaitResponse: true,
    });
  }

  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolIOBoundOptimized(poolSize, tasks, iterations, keys, waitMs) {
  const pool = createWorkerPool(poolSize, false);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const promises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () =>
        pool.postMessage(makePayload(iters, { asyncWaitMs: waitMs }), undefined, {
          awaitResponse: true,
        }),
      { ttl: 60000 }
    );
  }
  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolIOBoundAutoscale(poolSize, tasks, iterations, waitMs) {
  const pool = createWorkerPool(poolSize, true);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    pool.postMessage(makePayload(iters, { asyncWaitMs: waitMs }), undefined, {
      awaitResponse: true,
    });
  }
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

async function runWorkerPoolIOBoundAutoscaleOptimized(poolSize, tasks, iterations, keys, waitMs) {
  const pool = createWorkerPool(poolSize, true);
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const promises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i += 1) {
    const iters = normalizeIteration(iterations, i);
    const key = keys[i];
    promises[i] = cache.getOrSetAsync(
      key,
      () =>
        pool.postMessage(makePayload(iters, { asyncWaitMs: waitMs }), undefined, {
          awaitResponse: true,
        }),
      { ttl: 60000 }
    );
  }
  await Promise.all(promises);
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  const perf = (statsObj && statsObj.performance) || {};
  const avgMs = tasks ? totalMs / tasks : 0;
  pool.terminate();
  return { totalMs, avgMs, results: null, stats: perf, instrumentation: null };
}

function buildCacheWarmupProfile(tasks, baseIterations) {
  const keyCount = Math.max(1, Math.min(20, Math.round(tasks / 10)));
  const keys = Array.from({ length: tasks }, (_, i) => `warm:${i % keyCount}`);
  return { iterations: new Array(tasks).fill(baseIterations), keys };
}

async function runCacheWarmupBenchmark(tasks, iterations) {
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const profile = buildCacheWarmupProfile(tasks, iterations);

  const coldStart = await runCacheWarmupPhase(cache, profile.iterations, profile.keys);
  const warmStart = await runCacheWarmupPhase(cache, profile.iterations, profile.keys);
  return { coldStart, warmStart, keysCount: new Set(profile.keys).size };
}

async function runCacheWarmupPhase(cache, iterations, keys) {
  const promises = new Array(iterations.length);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations.length; i += 1) {
    const key = keys[i];
    const iters = iterations[i];
    promises[i] = cache.getOrSetAsync(key, () => Promise.resolve(heavy(iters)), {
      ttl: 60000,
    });
  }
  await Promise.all(promises);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

// ─── Helper micro-benchmarks ───────────────────────────────────────────────
// Each function returns { name, ops, variants: [{ label, totalMs, opsPerSec, ...extra }] }.
// A silent warmup pass runs before timing to stabilise JIT.
// When BENCH_RUNS > 1, the variant is run that many times and the median totalMs is reported.

async function benchVariantRepeat(runs, fn) {
  // Silent warmup — lets V8 JIT-compile the hot path before we start timing.
  await fn();
  const times = [];
  for (let r = 0; r < runs; r++) times.push(await fn());
  return medianOf(times);
}

// ── PowerRateLimit ──────────────────────────────────────────────────────────
async function runBenchmarkPowerRateLimit(ops) {
  const warmOps = Math.min(1000, Math.ceil(ops / 100));

  // Under rate: bucket has more tokens than ops — every tryConsume succeeds.
  const underRateMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const throttle = new PowerThrottle({ capacity: ops * 2, tokens: ops * 2, refillRate: 0 });
    const limiter = new PowerRateLimit([throttle]);
    for (let i = 0; i < warmOps; i++) limiter.tryConsume(1);
    const throttle2 = new PowerThrottle({ capacity: ops * 2, tokens: ops * 2, refillRate: 0 });
    const limiter2 = new PowerRateLimit([throttle2]);
    const t0 = process.hrtime.bigint();
    let passed = 0;
    for (let i = 0; i < ops; i++) {
      if (limiter2.tryConsume(1)) passed++;
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Over rate: bucket holds ops/2 tokens — ~50 % of calls are rejected.
  const overRateMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const throttle = new PowerThrottle({
      capacity: Math.ceil(ops / 2),
      tokens: Math.ceil(ops / 2),
      refillRate: 0,
    });
    const limiter = new PowerRateLimit([throttle]);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) limiter.tryConsume(1);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerRateLimit',
    ops,
    variants: [
      {
        label: 'under rate (all pass)',
        totalMs: underRateMs,
        opsPerSec: ops / (underRateMs / 1000),
      },
      {
        label: 'over rate (~50% reject)',
        totalMs: overRateMs,
        opsPerSec: ops / (overRateMs / 1000),
      },
    ],
  };
}

// ── PowerCircuit ─────────────────────────────────────────────────────────────
async function runBenchmarkPowerCircuit(ops) {
  const smallOps = Math.min(ops, 20000);

  // Closed state: happy-path overhead of call() wrapping a sync fn.
  const closedMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const circuit = new PowerCircuit({ threshold: smallOps + 1, timeout: 60000 });
    // warmup
    for (let i = 0; i < Math.min(100, smallOps / 10); i++) await circuit.call(() => 1);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) await circuit.call(() => 1);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Open state: fast-fail overhead after circuit is tripped.
  const openMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const circuit = new PowerCircuit({ threshold: 1, timeout: 60000 });
    try {
      await circuit.call(() => {
        throw new Error('trip');
      });
    } catch (_) {}
    const t0 = process.hrtime.bigint();
    let rejections = 0;
    for (let i = 0; i < smallOps; i++) {
      try {
        await circuit.call(() => 1);
      } catch (_) {
        rejections++;
      }
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerCircuit',
    ops: smallOps,
    variants: [
      { label: 'closed (happy path)', totalMs: closedMs, opsPerSec: smallOps / (closedMs / 1000) },
      { label: 'open (fast-fail)', totalMs: openMs, opsPerSec: smallOps / (openMs / 1000) },
    ],
  };
}

// ── PowerRetry ───────────────────────────────────────────────────────────────
async function runBenchmarkPowerRetry(ops) {
  const smallOps = Math.min(ops, 10000);

  // 1 attempt, always succeeds — measures wrapper overhead only.
  const successMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    // warmup
    for (let i = 0; i < Math.min(50, smallOps / 100); i++) {
      await PowerRetry.run(() => 1, { maxAttempts: 3, baseDelay: 0, jitter: false });
    }
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) {
      await PowerRetry.run(() => 1, { maxAttempts: 3, baseDelay: 0, jitter: false });
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Fail-once: function rejects on attempt 1, succeeds on attempt 2.
  const retryOnceMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) {
      let calls = 0;
      await PowerRetry.run(
        () => {
          if (++calls < 2) throw new Error('transient');
          return 1;
        },
        { maxAttempts: 3, baseDelay: 0, jitter: false }
      );
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerRetry',
    ops: smallOps,
    variants: [
      {
        label: '1 attempt (no retry)',
        totalMs: successMs,
        opsPerSec: smallOps / (successMs / 1000),
      },
      {
        label: '2 attempts (1 retry, baseDelay=0)',
        totalMs: retryOnceMs,
        opsPerSec: smallOps / (retryOnceMs / 1000),
      },
    ],
  };
}

// ── PowerSemaphore ────────────────────────────────────────────────────────────
async function runBenchmarkPowerSemaphore(ops) {
  const smallOps = Math.min(ops, 50000);

  // Limit=1: exclusive lock, fully serial.
  const serial1Ms = await benchVariantRepeat(BENCH_RUNS, async () => {
    const sem = new PowerSemaphore(1);
    for (let i = 0; i < Math.min(50, smallOps / 100); i++) await sem.run(() => 1);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) await sem.run(() => 1);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Limit=8: concurrent pool — all tasks fly in parallel.
  const conc8Ms = await benchVariantRepeat(BENCH_RUNS, async () => {
    const sem = new PowerSemaphore(8);
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: smallOps }, () => sem.run(() => 1)));
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerSemaphore',
    ops: smallOps,
    variants: [
      {
        label: 'limit=1 (exclusive lock, serial)',
        totalMs: serial1Ms,
        opsPerSec: smallOps / (serial1Ms / 1000),
      },
      {
        label: 'limit=8 (concurrent pool)',
        totalMs: conc8Ms,
        opsPerSec: smallOps / (conc8Ms / 1000),
      },
    ],
  };
}

// ── PowerBulkhead ─────────────────────────────────────────────────────────────
async function runBenchmarkPowerBulkhead(ops) {
  const smallOps = Math.min(ops, 20000);
  const half = Math.floor(smallOps / 2);

  // Mixed critical + background lanes under the same bulkhead.
  const mixedMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const bh = new PowerBulkhead({ partitions: 2, maxConcurrency: 8, queueCapacity: smallOps });
    const t0 = process.hrtime.bigint();
    const critTasks = Array.from({ length: half }, () => bh.run(() => 1, { partitionKey: 0 }));
    const bgTasks = Array.from({ length: half }, () => bh.run(() => 1, { partitionKey: 1 }));
    await Promise.all([...critTasks, ...bgTasks]);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Single partition as baseline (no isolation overhead).
  const singleMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const bh = new PowerBulkhead({ partitions: 1, maxConcurrency: 8, queueCapacity: smallOps });
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: smallOps }, () => bh.run(() => 1)));
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerBulkhead',
    ops: smallOps,
    variants: [
      {
        label: '1 partition (baseline)',
        totalMs: singleMs,
        opsPerSec: smallOps / (singleMs / 1000),
      },
      {
        label: '2 partitions (critical vs background)',
        totalMs: mixedMs,
        opsPerSec: smallOps / (mixedMs / 1000),
      },
    ],
  };
}

// ── PowerBatch ────────────────────────────────────────────────────────────────
async function runBenchmarkPowerBatch(ops) {
  const smallOps = Math.min(ops, 100000);

  // Individual dispatch: maxSize=1 so every add() triggers an immediate flush.
  let handlerCallsIndividual = 0;
  const individualMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    handlerCallsIndividual = 0;
    const batch = new PowerBatch(
      (items) => {
        handlerCallsIndividual += items.length;
      },
      { maxSize: 1 }
    );
    const t0 = process.hrtime.bigint();
    const ps = [];
    for (let i = 0; i < smallOps; i++) ps.push(batch.add(i));
    await Promise.all(ps);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Coalesced dispatch: large maxSize — all items land in one (or few) handler calls.
  let handlerCallsCoalesced = 0;
  const coalescedMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    handlerCallsCoalesced = 0;
    const batch = new PowerBatch(
      (items) => {
        handlerCallsCoalesced++;
      },
      { maxSize: smallOps }
    );
    const t0 = process.hrtime.bigint();
    const ps = [];
    for (let i = 0; i < smallOps; i++) ps.push(batch.add(i));
    await Promise.all(ps);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerBatch',
    ops: smallOps,
    variants: [
      {
        label: 'individual dispatch (maxSize=1)',
        totalMs: individualMs,
        opsPerSec: smallOps / (individualMs / 1000),
        handlerCalls: handlerCallsIndividual,
      },
      {
        label: 'coalesced dispatch (maxSize=ops)',
        totalMs: coalescedMs,
        opsPerSec: smallOps / (coalescedMs / 1000),
        handlerCalls: handlerCallsCoalesced,
      },
    ],
  };
}

// ── PowerBackpressure ─────────────────────────────────────────────────────────
async function runBenchmarkPowerBackpressure(ops) {
  const smallOps = Math.min(ops, 30000);

  // No backpressure: capacity >> task count, acquire never blocks.
  const noPresMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const bp = new PowerBackpressure({ capacity: smallOps * 2, queueCapacity: smallOps * 2 });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) {
      const rel = await bp.acquire();
      rel();
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // With backpressure: capacity = 100, producers queue up.
  const presMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    const bp = new PowerBackpressure({ capacity: 100, queueCapacity: smallOps, refillInterval: 1 });
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: smallOps }, () => bp.acquire().then((rel) => rel())));
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerBackpressure',
    ops: smallOps,
    variants: [
      {
        label: 'no pressure (capacity >> ops)',
        totalMs: noPresMs,
        opsPerSec: smallOps / (noPresMs / 1000),
      },
      {
        label: 'with pressure (capacity=100)',
        totalMs: presMs,
        opsPerSec: smallOps / (presMs / 1000),
      },
    ],
  };
}

// ── PowerTTLMap ───────────────────────────────────────────────────────────────
async function runBenchmarkPowerTTLMap(ops) {
  const keyCount = Math.min(1000, Math.ceil(ops / 10));

  // Long TTL: entries never expire during the benchmark run.
  const longMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const m = new PowerTTLMap(60000);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) {
      const k = `key:${i % keyCount}`;
      m.set(k, i);
      m.get(k);
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Short TTL (1 ms): entries expire rapidly, measuring eviction overhead.
  const shortMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const m = new PowerTTLMap(1);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) {
      const k = `key:${i % keyCount}`;
      m.set(k, i);
      m.get(k);
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerTTLMap',
    ops,
    variants: [
      { label: 'long TTL (60 s, no eviction)', totalMs: longMs, opsPerSec: ops / (longMs / 1000) },
      {
        label: 'short TTL (1 ms, high eviction)',
        totalMs: shortMs,
        opsPerSec: ops / (shortMs / 1000),
      },
    ],
  };
}

// ── PowerEventBus ─────────────────────────────────────────────────────────────
async function runBenchmarkPowerEventBus(ops) {
  const smallOps = Math.min(ops, 100000);
  const subscriberCounts = [1, 10, 50, 100];
  const variants = [];

  for (const subCount of subscriberCounts) {
    const ms = await benchVariantRepeat(BENCH_RUNS, () => {
      const bus = new PowerEventBus();
      let received = 0;
      for (let s = 0; s < subCount; s++)
        bus.on('evt', () => {
          received++;
        });
      // warmup
      for (let i = 0; i < Math.min(100, smallOps / 100); i++) bus.emit('evt', i);
      received = 0;
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < smallOps; i++) bus.emit('evt', i);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    });
    variants.push({
      label: `${subCount} subscriber${subCount > 1 ? 's' : ''}`,
      totalMs: ms,
      opsPerSec: smallOps / (ms / 1000),
      totalDeliveries: smallOps * subCount,
    });
  }

  return { name: 'PowerEventBus', ops: smallOps, variants };
}

// ── PowerDeadline ─────────────────────────────────────────────────────────────
async function runBenchmarkPowerDeadline(ops) {
  const smallOps = Math.min(ops, 5000);

  // Success path: task resolves well within deadline.
  const successMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    for (let i = 0; i < Math.min(20, smallOps / 50); i++) {
      await PowerDeadline.run(() => 1, { totalTimeout: 1000 });
    }
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) await PowerDeadline.run(() => 1, { totalTimeout: 1000 });
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Abort path: every task outlives its 1 ms deadline.
  let deadlineHits = 0;
  const abortMs = await benchVariantRepeat(BENCH_RUNS, async () => {
    deadlineHits = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < smallOps; i++) {
      try {
        await PowerDeadline.run(() => new Promise((r) => setTimeout(r, 5)), {
          totalTimeout: 1,
          maxAttempts: 1,
        });
      } catch (_) {
        deadlineHits++;
      }
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerDeadline',
    ops: smallOps,
    variants: [
      {
        label: 'success (task within deadline)',
        totalMs: successMs,
        opsPerSec: smallOps / (successMs / 1000),
      },
      {
        label: 'abort (task exceeds 1 ms deadline)',
        totalMs: abortMs,
        opsPerSec: smallOps / (abortMs / 1000),
        deadlineHits,
      },
    ],
  };
}

// ── PowerSlidingWindow ────────────────────────────────────────────────────────
async function runBenchmarkPowerSlidingWindow(ops) {
  // Under capacity: window is large enough to accept all ops.
  const underMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const win = new PowerSlidingWindow({ capacity: ops + 1, windowMs: 60000 });
    // warmup
    for (let i = 0; i < Math.min(1000, ops / 100); i++) win.tryConsume(1);
    const win2 = new PowerSlidingWindow({ capacity: ops + 1, windowMs: 60000 });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) win2.tryConsume(1);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // At capacity: half the tokens available — ~50 % of calls rejected.
  const capMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const win = new PowerSlidingWindow({ capacity: Math.ceil(ops / 2), windowMs: 60000 });
    const t0 = process.hrtime.bigint();
    let consumed = 0;
    for (let i = 0; i < ops; i++) {
      if (win.tryConsume(1)) consumed++;
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerSlidingWindow',
    ops,
    variants: [
      { label: 'under capacity (all pass)', totalMs: underMs, opsPerSec: ops / (underMs / 1000) },
      { label: 'at capacity (~50% reject)', totalMs: capMs, opsPerSec: ops / (capMs / 1000) },
    ],
  };
}

// ── PowerQueue ────────────────────────────────────────────────────────────────
async function runBenchmarkPowerQueue(ops) {
  // Bulk push then bulk shift.
  const pushShiftMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const q = new PowerQueue(Math.min(ops, 65536));
    for (let i = 0; i < 1000; i++) {
      q.push(i);
      q.shift();
    } // warmup
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) q.push(i);
    while (q.length > 0) q.shift();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  // Interleaved push+shift (ring-buffer steady state).
  const interleavedMs = await benchVariantRepeat(BENCH_RUNS, () => {
    const q = new PowerQueue(64);
    const half = 32;
    for (let i = 0; i < half; i++) q.push(i); // pre-fill
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ops; i++) {
      q.push(i);
      q.shift();
    }
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });

  return {
    name: 'PowerQueue',
    ops,
    variants: [
      {
        label: `push x${ops} + shift x${ops}`,
        totalMs: pushShiftMs,
        opsPerSec: ops / (pushShiftMs / 1000),
      },
      {
        label: 'interleaved push+shift (steady state)',
        totalMs: interleavedMs,
        opsPerSec: ops / (interleavedMs / 1000),
      },
    ],
  };
}

// ── Cache eviction under tight capacity ──────────────────────────────────────
async function runCacheEvictionPressure(tasks, iterations) {
  // maxEntries = 20 % of unique keys → heavy eviction on every miss
  const uniqueKeys = tasks;
  const maxEntries = Math.max(1, Math.ceil(uniqueKeys * 0.2));
  const cache = new PowerCache({ maxEntries, defaultTTL: 60000 });
  const keys = Array.from({ length: tasks }, (_, i) => `evict:${i}`);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    let v = cache.get(keys[i]);
    if (v === undefined) {
      v = heavy(iterations);
      cache.set(keys[i], v);
    }
  }
  const t1 = process.hrtime.bigint();
  const missTotal = Number(t1 - t0) / 1e6;

  // Second pass: cache is full with the most recently inserted entries (LRU
  // evicted the oldest). Read from the tail of the keys array so every access
  // hits a live entry and we measure true hit throughput under eviction pressure.
  const hitStartIdx = uniqueKeys - maxEntries;
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) cache.get(keys[hitStartIdx + (i % maxEntries)]);
  const t3 = process.hrtime.bigint();
  const hitTotal = Number(t3 - t2) / 1e6;

  return { missTotal, hitTotal, maxEntries, keysCount: uniqueKeys };
}

// ── Serial vs concurrent cache getOrSetAsync ─────────────────────────────────
async function runCacheSerialVsConcurrent(tasks, iterations) {
  const uniqueKeys = 10;
  // Use a 1-ms async factory to simulate I/O latency so in-flight deduplication
  // can activate. A sync factory (e.g. Promise.resolve(heavy())) caches the
  // value before a second caller can observe the in-flight promise, making serial
  // and concurrent behave identically and defeating the purpose of this benchmark.
  const asyncFactory = () => new Promise((r) => setTimeout(r, 1));

  // Serial: one getOrSetAsync at a time — no in-flight deduplication benefit.
  // Each unique key's factory runs once then subsequent calls are cache hits.
  const serialCache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    await serialCache.getOrSetAsync(`s:${i % uniqueKeys}`, asyncFactory, { ttl: 60000 });
  }
  const t1 = process.hrtime.bigint();
  const serialMs = Number(t1 - t0) / 1e6;

  // Concurrent: all getOrSetAsync calls fired at once — identical keys coalesce
  // to a single underlying call (in-flight deduplication).
  const concCache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const t2 = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: tasks }, (_, i) =>
      concCache.getOrSetAsync(`c:${i % uniqueKeys}`, asyncFactory, { ttl: 60000 })
    )
  );
  const t3 = process.hrtime.bigint();
  const concurrentMs = Number(t3 - t2) / 1e6;

  return { serialMs, concurrentMs, tasks, uniqueKeys };
}

async function runScenarioBurstiness() {
  const scenario = {
    name: 'Burstiness',
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const keys = buildBurstKeys(TASKS, Math.max(1, Math.min(20, Math.round(TASKS / 10))));

  for (const size of POOL_SIZES) {
    const r = await runWorkerPoolBurst(size, TASKS, ITERS);
    const rOpt = await runWorkerPoolBurstOptimized(size, TASKS, ITERS, keys);
    const rAuto = await runWorkerPoolBurstAutoscale(size, TASKS, ITERS);
    const rAutoOpt = await runWorkerPoolBurstAutoscaleOptimized(size, TASKS, ITERS, keys);

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runScenarioMixedTaskSizes() {
  const scenario = {
    name: 'Mixed task sizes',
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const profile = buildMixedSizeProfile(TASKS, ITERS);

  for (const size of POOL_SIZES) {
    const r = await runWorkerPool(size, TASKS, profile.iterations);
    const rOpt = await runWorkerPoolOptimized(size, TASKS, profile.iterations, profile.keys);
    const rAuto = await runWorkerPoolAutoscale(size, TASKS, profile.iterations);
    const rAutoOpt = await runWorkerPoolAutoscaleOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys
    );

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runScenarioRampTraffic() {
  const scenario = {
    name: 'Ramp traffic',
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const profile = buildRampTrafficProfile(TASKS, ITERS);

  for (const size of POOL_SIZES) {
    const r = await runWorkerPoolRampTraffic(size, TASKS, profile.iterations);
    const rOpt = await runWorkerPoolRampTrafficOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys
    );
    const rAuto = await runWorkerPoolRampTrafficAutoscale(size, TASKS, profile.iterations);
    const rAutoOpt = await runWorkerPoolRampTrafficAutoscaleOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys
    );

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runScenarioPayloadSize() {
  const scenario = {
    name: 'Variable payload sizes',
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const profile = buildPayloadSizeProfile(TASKS, ITERS);

  for (const size of POOL_SIZES) {
    const r = await runWorkerPoolPayloadSize(size, TASKS, profile.iterations, profile.payloadSizes);
    const rOpt = await runWorkerPoolPayloadSizeOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys,
      profile.payloadSizes
    );
    const rAuto = await runWorkerPoolPayloadSizeAutoscale(
      size,
      TASKS,
      profile.iterations,
      profile.payloadSizes
    );
    const rAutoOpt = await runWorkerPoolPayloadSizeAutoscaleOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys,
      profile.payloadSizes
    );

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runScenarioIOBound() {
  const scenario = {
    name: 'I/O bound',
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const profile = buildIOBoundProfile(TASKS, ITERS);
  const waitMs = profile.asyncWaitMs[0];

  for (const size of POOL_SIZES) {
    const r = await runWorkerPoolIOBound(size, TASKS, profile.iterations, waitMs);
    const rOpt = await runWorkerPoolIOBoundOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys,
      waitMs
    );
    const rAuto = await runWorkerPoolIOBoundAutoscale(size, TASKS, profile.iterations, waitMs);
    const rAutoOpt = await runWorkerPoolIOBoundAutoscaleOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys,
      waitMs
    );

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runScenarioThunderingHerd() {
  const scenario = {
    name: 'Thundering herd',
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const profile = buildThunderingHerdProfile(TASKS, ITERS);

  for (const size of POOL_SIZES) {
    const r = await runWorkerPool(size, TASKS, profile.iterations);
    const rOpt = await runWorkerPoolOptimized(size, TASKS, profile.iterations, profile.keys);
    const rAuto = await runWorkerPoolAutoscale(size, TASKS, profile.iterations);
    const rAutoOpt = await runWorkerPoolAutoscaleOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys
    );

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runScenarioCacheHitRatio(hitRatio) {
  const scenario = {
    name: `Cache hit ratio ${Math.round(hitRatio * 100)}%`,
    pool: [],
    optimizedPool: [],
    autoscalePool: [],
    autoscaleOptimizedPool: [],
  };
  const profile = buildCacheHitRatioProfile(TASKS, ITERS, hitRatio);

  for (const size of POOL_SIZES) {
    const r = await runWorkerPool(size, TASKS, profile.iterations);
    const rOpt = await runWorkerPoolOptimized(size, TASKS, profile.iterations, profile.keys);
    const rAuto = await runWorkerPoolAutoscale(size, TASKS, profile.iterations);
    const rAutoOpt = await runWorkerPoolAutoscaleOptimized(
      size,
      TASKS,
      profile.iterations,
      profile.keys
    );

    scenario.pool.push({ size, totalMs: r.totalMs });
    scenario.optimizedPool.push({ size, totalMs: rOpt.totalMs });
    scenario.autoscalePool.push({ size, totalMs: rAuto.totalMs });
    scenario.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
  }

  return scenario;
}

async function runCacheWarmupScenario() {
  const result = await runCacheWarmupBenchmark(TASKS, ITERS);
  return result;
}

async function runCacheGetOrSetAsyncBenchmark(
  tasks,
  iterations,
  uniqueKeys = CACHE_DUPLICATE_KEYS
) {
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const promises = new Array(tasks);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    const key = repeatedKey(i, uniqueKeys);
    promises[i] = cache.getOrSetAsync(key, () => Promise.resolve(heavy(iterations)), {
      ttl: 60000,
    });
  }
  await Promise.all(promises);
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  return { totalMs, avgMs: tasks ? totalMs / tasks : 0, uniqueKeys };
}

function runMemoizerBenchmark(tasks, iterations, uniqueKeys = MEMOIZER_DUPLICATE_KEYS) {
  const memo = new PowerMemoizer({ cacheOptions: { maxEntries: uniqueKeys, defaultTTL: 60000 } });
  const fn = memo.memoize((key) => heavy(iterations));

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    fn(repeatedKey(i, uniqueKeys));
  }
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  return { totalMs, avgMs: tasks ? totalMs / tasks : 0, uniqueKeys };
}

async function runWorkerThreadBaseline(tasks, iterations) {
  return new Promise((resolve, reject) => {
    const worker = new NodeWorker('./bench/worker.js', { type: 'module' });
    let received = 0;
    const t0 = process.hrtime.bigint();

    worker.on('message', () => {
      received += 1;
      if (received === tasks) {
        const t1 = process.hrtime.bigint();
        worker
          .terminate()
          .then(() =>
            resolve({
              totalMs: Number(t1 - t0) / 1e6,
              avgMs: tasks ? Number(t1 - t0) / 1e6 / tasks : 0,
            })
          )
          .catch(reject);
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0 && received !== tasks) {
        reject(new Error(`worker exited with code ${code}`));
      }
    });

    for (let i = 0; i < tasks; i++) {
      const payload = o2u8({ iterations });
      worker.postMessage(payload, [payload.buffer]);
    }
  });
}

async function runWorkerThreadBaselineVariable(tasks, iterationsArray) {
  return new Promise((resolve, reject) => {
    const worker = new NodeWorker('./bench/worker.js', { type: 'module' });
    let received = 0;
    const t0 = process.hrtime.bigint();

    worker.on('message', () => {
      received += 1;
      if (received === tasks) {
        const t1 = process.hrtime.bigint();
        worker
          .terminate()
          .then(() =>
            resolve({
              totalMs: Number(t1 - t0) / 1e6,
              avgMs: tasks ? Number(t1 - t0) / 1e6 / tasks : 0,
            })
          )
          .catch(reject);
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0 && received !== tasks) {
        reject(new Error(`worker exited with code ${code}`));
      }
    });

    for (let i = 0; i < tasks; i++) {
      const iters = Math.max(1, Math.round(iterationsArray[i]));
      const payload = o2u8({ iterations: iters });
      worker.postMessage(payload, [payload.buffer]);
    }
  });
}

// Note: removed runWorkerPoolSimple fallback — we now rely on PowerPool only.

async function runCacheBenchmark(tasks, iterations) {
  const cache = new PowerCache({ maxEntries: Infinity, defaultTTL: 60000 });
  const keys = Array.from({ length: tasks }, (_, i) => `key:${i}`);
  // Miss scenario
  const t0 = process.hrtime.bigint();
  for (const k of keys) {
    let v = cache.get(k);
    if (v === undefined) {
      v = heavy(iterations);
      cache.set(k, v);
    }
  }
  const t1 = process.hrtime.bigint();
  const missTotal = Number(t1 - t0) / 1e6;

  // Hit scenario: repeated gets
  const reps = 5;
  const t2 = process.hrtime.bigint();
  for (let r = 0; r < reps; r++) for (const k of keys) cache.get(k);
  const t3 = process.hrtime.bigint();
  const hitTotal = Number(t3 - t2) / 1e6;
  return { missTotal, hitTotal, keysCount: keys.length, reps };
}

// ─── Helper benchmarks orchestrator ───────────────────────────────────────────
async function runAllHelperBenchmarks() {
  const results = [];
  const runners = [
    ['PowerRateLimit', () => runBenchmarkPowerRateLimit(HELPER_OPS)],
    ['PowerCircuit', () => runBenchmarkPowerCircuit(HELPER_OPS)],
    ['PowerRetry', () => runBenchmarkPowerRetry(HELPER_OPS)],
    ['PowerSemaphore', () => runBenchmarkPowerSemaphore(HELPER_OPS)],
    ['PowerBulkhead', () => runBenchmarkPowerBulkhead(HELPER_OPS)],
    ['PowerBatch', () => runBenchmarkPowerBatch(HELPER_OPS)],
    ['PowerBackpressure', () => runBenchmarkPowerBackpressure(HELPER_OPS)],
    ['PowerTTLMap', () => runBenchmarkPowerTTLMap(HELPER_OPS)],
    ['PowerEventBus', () => runBenchmarkPowerEventBus(HELPER_OPS)],
    ['PowerDeadline', () => runBenchmarkPowerDeadline(HELPER_OPS)],
    ['PowerSlidingWindow', () => runBenchmarkPowerSlidingWindow(HELPER_OPS)],
    ['PowerQueue', () => runBenchmarkPowerQueue(HELPER_OPS)],
  ];

  for (const [name, fn] of runners) {
    const heapBefore = heapKb();
    console.log(`  Running helper: ${name}...`);
    try {
      const result = await fn();
      result.memDeltaKb = heapKb() - heapBefore;
      for (const v of result.variants) {
        const opsPerSec = v.opsPerSec ? Math.round(v.opsPerSec).toLocaleString() : '?';
        console.log(`    [${v.label}]  ${v.totalMs.toFixed(2)} ms  ${opsPerSec} ops/sec`);
      }
      results.push(result);
    } catch (err) {
      console.warn(`  Helper benchmark ${name} failed:`, err && err.message);
      results.push({ name, ops: HELPER_OPS, variants: [], error: err && err.message });
    }
  }

  return results;
}

function formatMd(report, filename, prevDeltaMap = new Map()) {
  const lines = [];
  // Labels map and helper for rendering short, descriptive column headers
  const LABELS = {
    size: 'Pool Size',
    totalMs: 'T Total',
    avgMs: 'Avg',
    poolLiveDuration: 'T Pool',
    totalWorkersCreated: 'Workers',
    totalTasksPerformed: 'Tasks',
    averageTasksPerWorkerUntilTermination: 'tasks/worker',
    'timePerTask.max': 'T Max',
    'timePerTask.min': 'T Min',
    'timePerTask.average': 'T Avg',
    'timePerTask.stddev': 'T Std',
    percentSlowTasks: '% Slow',
  };
  function headerLabel(k) {
    if (LABELS[k]) return LABELS[k];
    if (k.includes('.')) {
      const [a, b] = k.split('.');
      const pa = LABELS[a] || a;
      const pb = LABELS[`${a}.${b}`] || b;
      return `${pa} ${pb}`;
    }
    return k
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/^./, (s) => s.toUpperCase());
  }

  function renderPoolSection(lines, poolItems) {
    if (!poolItems || !poolItems.length) {
      lines.push('- No pool results');
      return;
    }

    const perfKeys = new Set();
    for (const pr of poolItems) {
      const p = pr.stats || {};
      for (const k of Object.keys(p)) {
        if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) {
          for (const sub of Object.keys(p[k])) perfKeys.add(`${k}.${sub}`);
        } else {
          perfKeys.add(k);
        }
      }
    }
    perfKeys.delete('totalWorkersCreated');
    perfKeys.delete('totalTasksPerformed');
    perfKeys.delete('averageTasksPerWorkerUntilTermination');

    const keys = ['size', 'totalMs', ...Array.from(perfKeys)];
    lines.push('');
    lines.push(`| ${keys.map((k) => headerLabel(k)).join(' | ')} |`);
    lines.push(
      `| ${keys.map((k) => (k === 'size' ? '----------:' : '-----------:')).join(' | ')} |`
    );

    for (const pr of poolItems) {
      const p = pr.stats || {};
      const row = [];
      for (const k of keys) {
        if (k === 'size') {
          row.push(String(pr.size));
          continue;
        }
        if (k === 'totalMs') {
          row.push(pr.totalMs == null ? '' : pr.totalMs.toFixed(2));
          continue;
        }
        if (k.includes('.')) {
          const [a, b] = k.split('.');
          const v = p[a] && typeof p[a] === 'object' ? p[a][b] : undefined;
          row.push(v == null ? '' : typeof v === 'number' ? v.toFixed(2) : String(v));
        } else {
          const v = p[k];
          row.push(v == null ? '' : typeof v === 'number' ? v.toFixed(2) : String(v));
        }
      }
      lines.push(`| ${row.join(' | ')} |`);
    }
  }

  lines.push('# Benchmark Results');
  lines.push(`\nGenerated: ${report.timestamp}\n`);
  lines.push('## Configuration\n');
  lines.push(`- MODE: ${report.config.mode}`);
  lines.push(`- TASKS: ${report.config.TASKS}`);
  lines.push(`- ITERS: ${report.config.ITERS}`);
  lines.push(`- POOL_SIZES: ${report.config.POOL_SIZES.join(', ')}`);
  lines.push(`- LOAD_PROFILES: ${report.config.PROFILES.join(', ')}`);
  if (report.config.BENCH_RUNS > 1) lines.push(`- BENCH_RUNS: ${report.config.BENCH_RUNS}`);
  if (report.config.POOL_RUNS > 1) lines.push(`- POOL_RUNS: ${report.config.POOL_RUNS}`);
  if (report.config.HELPER_OPS) lines.push(`- HELPER_OPS: ${report.config.HELPER_OPS}`);

  lines.push('\nLearn more about the benchmarks [here](README.md)\n');

  lines.push('\n## Synthetic scenario benchmarks\n');

  const patternKeys = ['pool', 'optimizedPool', 'autoscalePool', 'autoscaleOptimizedPool'];

  function renderProfileSection(profile, section = 'profiles') {
    lines.push(`\n### Load profile: ${profile.name}`);
    if (profile.singleThreaded) {
      const st = profile.singleThreaded;
      const throughput = st.throughput
        ? ` | throughput: ${Math.round(st.throughput).toLocaleString()} tasks/s`
        : '';
      let statsStr = '';
      if (st.durationStats) {
        const ds = st.durationStats;
        statsStr = ` | p50: ${ds.p50.toFixed(2)} ms | p95: ${ds.p95.toFixed(2)} ms | p99: ${ds.p99.toFixed(2)} ms`;
      }
      lines.push(`- Single-threaded total: ${st.totalMs.toFixed(2)} ms${throughput}${statsStr}`);
    }
    if (profile.workerThread) {
      lines.push(`- Worker-thread total: ${profile.workerThread.totalMs.toFixed(2)} ms`);
    }
    lines.push('');

    const patterns = [
      { label: 'Pool', key: 'pool', results: profile.pool },
      { label: 'Pool + Autoscale', key: 'autoscalePool', results: profile.autoscalePool },
      { label: 'Pool + Cache', key: 'optimizedPool', results: profile.optimizedPool },
      {
        label: 'Pool + Cache + Autoscale',
        key: 'autoscaleOptimizedPool',
        results: profile.autoscaleOptimizedPool,
      },
    ];

    const singleThreadedMs =
      profile.singleThreaded && profile.singleThreaded.totalMs > 0
        ? profile.singleThreaded.totalMs
        : null;

    const allValues = [];
    for (const pattern of patterns) {
      for (const size of report.config.POOL_SIZES) {
        const row = pattern.results?.find((item) => item.size === size);
        if (row && typeof row.totalMs === 'number') allValues.push(row.totalMs);
      }
    }
    const minValue = allValues.length ? Math.min(...allValues) : null;

    // Build header: one column per pool size + optional speedup column
    const sizeHeaders = report.config.POOL_SIZES.map((size) => `${size}`);
    const hasDelta = prevDeltaMap && prevDeltaMap.size > 0;
    lines.push(
      `| Pattern \\ Pool size  | ${sizeHeaders.join(' | ')} |${singleThreadedMs ? ' Speedup |' : ''}`
    );
    lines.push(
      `| :--- | ${report.config.POOL_SIZES.map(() => '---:').join(' | ')} |${singleThreadedMs ? ' ---: |' : ''}`
    );

    for (const pattern of patterns) {
      const values = report.config.POOL_SIZES.map((size) => {
        const row = pattern.results?.find((item) => item.size === size);
        if (row && typeof row.totalMs === 'number') {
          let cell = row.totalMs.toFixed(2);
          if (minValue !== null && row.totalMs === minValue) cell = `\`${cell}\``;
          // Inline delta from previous run
          const deltaKey = `${section}/${profile.name}/${pattern.key}/${size}`;
          const prev = prevDeltaMap && prevDeltaMap.get(deltaKey);
          if (prev != null && prev > 0) {
            cell += ` *(${formatDelta(row.totalMs, prev)})*`;
          }
          return cell;
        }
        return '';
      });

      // Best speedup across pool sizes for this pattern
      let speedupCell = '';
      if (singleThreadedMs) {
        const bestMs = Math.min(
          ...report.config.POOL_SIZES.map(
            (size) => pattern.results?.find((item) => item.size === size)?.totalMs
          ).filter((v) => v != null && v > 0)
        );
        if (isFinite(bestMs) && bestMs > 0) {
          speedupCell = ` ${(singleThreadedMs / bestMs).toFixed(2)}x |`;
        } else {
          speedupCell = ' — |';
        }
      }

      lines.push(`| ${pattern.label} | ${values.join(' | ')} |${speedupCell}`);
    }
  }

  if (report.profiles && report.profiles.length) {
    for (const profile of report.profiles) {
      renderProfileSection(profile, 'profiles');
    }
  } else {
    lines.push('- No profile benchmark results');
  }

  if (report.scenarios && report.scenarios.length) {
    lines.push('\n## Realistic scenario benchmarks\n');
    for (const scenario of report.scenarios) {
      renderProfileSection(scenario, 'scenarios');
    }
  }

  lines.push('\n## Cache benchmark\n');
  if (report.cache) {
    lines.push(`- Miss total: ${report.cache.missTotal.toFixed(2)} ms`);
    lines.push(`- Hit total (${report.cache.reps} reps): ${report.cache.hitTotal.toFixed(2)} ms`);
    lines.push(`- Keys tested: ${report.cache.keysCount}`);
    lines.push('');
  } else {
    lines.push('- No cache results');
    lines.push('');
  }

  if (report.cacheEviction) {
    const ev = report.cacheEviction;
    lines.push('### Cache eviction under pressure\n');
    lines.push(`- maxEntries: ${ev.maxEntries} (20% of ${ev.keysCount} unique keys)`);
    lines.push(`- Miss pass total: ${ev.missTotal.toFixed(2)} ms`);
    lines.push(`- Hit pass under eviction: ${ev.hitTotal.toFixed(2)} ms`);
    lines.push('');
  }

  if (report.cacheSerialVsConcurrent) {
    const sv = report.cacheSerialVsConcurrent;
    const improvement =
      sv.serialMs > 0 ? ` (${((1 - sv.concurrentMs / sv.serialMs) * 100).toFixed(1)}% faster)` : '';
    lines.push('### Serial vs concurrent getOrSetAsync (in-flight deduplication)\n');
    lines.push(`- Tasks: ${sv.tasks} | Unique keys: ${sv.uniqueKeys}`);
    lines.push(`- Serial (no dedup): ${sv.serialMs.toFixed(2)} ms`);
    lines.push(`- Concurrent (dedup): ${sv.concurrentMs.toFixed(2)} ms${improvement}`);
    lines.push('');
  }

  if (report.cacheDedupe) {
    lines.push(`- Cache getOrSetAsync dedupe total: ${report.cacheDedupe.totalMs.toFixed(2)} ms`);
    lines.push(`- Cache getOrSetAsync avg per task: ${report.cacheDedupe.avgMs.toFixed(2)} ms`);
    lines.push(`- Cache getOrSetAsync duplicate keys: ${report.cacheDedupe.uniqueKeys}`);
    lines.push('');
  }

  if (report.cacheWarmup) {
    lines.push('\n## Cache warmup benchmark\n');
    lines.push(`- Keys tested: ${report.cacheWarmup.keysCount}`);
    lines.push(`- Cold-start total: ${report.cacheWarmup.coldStart.toFixed(2)} ms`);
    lines.push(`- Warm-start total: ${report.cacheWarmup.warmStart.toFixed(2)} ms`);
    lines.push('');
  }

  if (report.memoizer) {
    lines.push(`- PowerMemoizer total: ${report.memoizer.totalMs.toFixed(2)} ms`);
    lines.push(`- PowerMemoizer avg per call: ${report.memoizer.avgMs.toFixed(2)} ms`);
    lines.push(`- PowerMemoizer duplicate keys: ${report.memoizer.uniqueKeys}`);
    lines.push('');
  }

  // ── Helper micro-benchmark section ────────────────────────────────────────
  if (report.helpers && report.helpers.length) {
    lines.push('\n## Helper micro-benchmarks\n');
    lines.push(
      `_${HELPER_OPS.toLocaleString()} ops per variant${BENCH_RUNS > 1 ? `, median of ${BENCH_RUNS} runs` : ''}_\n`
    );
    lines.push('| Helper | Variant | Total (ms) | ops/sec | Δ prev |');
    lines.push('| :--- | :--- | ---: | ---: | ---: |');

    for (const h of report.helpers) {
      if (h.error) {
        lines.push(`| **${h.name}** | *error: ${h.error}* | — | — | — |`);
        continue;
      }
      for (const v of h.variants) {
        const opsPerSec = v.opsPerSec ? Math.round(v.opsPerSec).toLocaleString() : '?';
        const deltaKey = `helpers/${h.name}/${v.label}`;
        const prev = prevDeltaMap && prevDeltaMap.get(deltaKey);
        const deltaStr = prev != null ? formatDelta(v.totalMs, prev) : '(new)';
        lines.push(
          `| **${h.name}** | ${v.label} | ${v.totalMs.toFixed(2)} | ${opsPerSec} | ${deltaStr} |`
        );
      }
    }
    lines.push('');
  }

  // ── Historical delta summary ───────────────────────────────────────────────
  // Thresholds:
  //   pool/scenario — multi-threaded wall-clock; OS/thermal jitter is large.
  //     Require pct > 35% AND abs diff > 50 ms before flagging.
  //   helper — median of BENCH_RUNS with warmup; much more stable.
  //     Require pct > 20% AND abs diff > 8 ms before flagging.
  //
  //   These thresholds reflect real hardware noise floors on developer machines:
  //   CPU turbo/thermal state changes between benchmark invocations easily cause
  //   25–35% wall-clock swings for multi-threaded pool runs. Async helpers are
  //   subject to event-loop scheduler variance. To get tighter numbers, lock CPU
  //   frequency (e.g. `sudo cpupower frequency-set -g performance`) and run on
  //   a quiescent machine.
  const POOL_PCT_THRESHOLD = 35;
  const POOL_ABS_FLOOR_MS = 50;
  const HELPER_PCT_THRESHOLD = 20;
  const HELPER_ABS_FLOOR_MS = 8;

  if (prevDeltaMap && prevDeltaMap.size > 0) {
    const deltas = [];
    // Collect pool/scenario deltas
    for (const section of ['profiles', 'scenarios']) {
      for (const item of report[section] || []) {
        for (const pk of patternKeys) {
          for (const entry of item[pk] || []) {
            if (typeof entry.totalMs !== 'number' || entry.totalMs <= 0) continue;
            const deltaKey = `${section}/${item.name}/${pk}/${entry.size}`;
            const prev = prevDeltaMap.get(deltaKey);
            if (prev == null || prev <= 0) continue;
            // Skip sub-floor absolute differences — they are measurement noise.
            if (Math.abs(entry.totalMs - prev) < POOL_ABS_FLOOR_MS) continue;
            deltas.push({
              key: deltaKey,
              current: entry.totalMs,
              prev,
              pct: ((entry.totalMs - prev) / prev) * 100,
              category: 'pool',
            });
          }
        }
      }
    }
    // Helper deltas
    for (const h of report.helpers || []) {
      for (const v of h.variants || []) {
        const deltaKey = `helpers/${h.name}/${v.label}`;
        const prev = prevDeltaMap.get(deltaKey);
        if (prev == null || prev <= 0 || typeof v.totalMs !== 'number') continue;
        // Skip sub-floor absolute differences — too fast for meaningful comparison.
        if (Math.abs(v.totalMs - prev) < HELPER_ABS_FLOOR_MS) continue;
        deltas.push({
          key: deltaKey,
          current: v.totalMs,
          prev,
          pct: ((v.totalMs - prev) / prev) * 100,
          category: 'helper',
        });
      }
    }

    if (deltas.length) {
      const regressions = deltas
        .filter(
          (d) =>
            (d.category === 'pool' && d.pct > POOL_PCT_THRESHOLD) ||
            (d.category === 'helper' && d.pct > HELPER_PCT_THRESHOLD)
        )
        .sort((a, b) => b.pct - a.pct);
      const improvements = deltas
        .filter(
          (d) =>
            (d.category === 'pool' && d.pct < -POOL_PCT_THRESHOLD) ||
            (d.category === 'helper' && d.pct < -HELPER_PCT_THRESHOLD)
        )
        .sort((a, b) => a.pct - b.pct);

      lines.push('\n## Δ vs previous run\n');
      lines.push(
        `_Pool/scenario: flagged when >±${POOL_PCT_THRESHOLD}% AND >±${POOL_ABS_FLOOR_MS} ms. ` +
          `Helpers: flagged when >±${HELPER_PCT_THRESHOLD}% AND >±${HELPER_ABS_FLOOR_MS} ms._\n`
      );
      if (regressions.length) {
        lines.push('### Regressions\n');
        lines.push('| Key | prev (ms) | current (ms) | Δ |');
        lines.push('| :--- | ---: | ---: | ---: |');
        for (const d of regressions.slice(0, 20)) {
          lines.push(
            `| ${d.key} | ${d.prev.toFixed(2)} | ${d.current.toFixed(2)} | **${formatDelta(d.current, d.prev)}** |`
          );
        }
        lines.push('');
      }
      if (improvements.length) {
        lines.push('### Improvements\n');
        lines.push('| Key | prev (ms) | current (ms) | Δ |');
        lines.push('| :--- | ---: | ---: | ---: |');
        for (const d of improvements.slice(0, 20)) {
          lines.push(
            `| ${d.key} | ${d.prev.toFixed(2)} | ${d.current.toFixed(2)} | ${formatDelta(d.current, d.prev)} |`
          );
        }
        lines.push('');
      }
      if (!regressions.length && !improvements.length) {
        lines.push('_All results within thresholds — no significant changes detected._\n');
      }
    }
  }

  // write raw JSON file alongside the markdown and add a link to it at the end
  const jsonFilename = 'results.json';
  try {
    writeFileSync(jsonFilename, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write JSON results file', err);
  }

  const md = lines.join('\n');
  writeFileSync(filename, md, 'utf8');
}

async function main() {
  // Load previous results for delta comparison before anything is overwritten.
  const prevResults = loadPreviousResults();
  const prevDeltaMap = buildDeltaMap(prevResults);

  const report = {
    timestamp: new Date().toISOString(),
    config: {
      mode,
      TASKS,
      ITERS,
      POOL_SIZES,
      BENCH_RUNS,
      POOL_RUNS,
      HELPER_OPS,
      PROFILES: LOAD_PROFILES.map((profile) => profile.name),
      SCENARIOS: [
        'Burstiness',
        'Mixed task sizes',
        'Ramp traffic',
        'Variable payload sizes',
        'I/O bound',
        'Thundering herd',
        'Cache hit ratio 10%',
        'Cache hit ratio 50%',
        'Cache hit ratio 90%',
      ],
    },
    profiles: [],
    scenarios: [],
    cache: null,
    cacheEviction: null,
    cacheSerialVsConcurrent: null,
    cacheDedupe: null,
    memoizer: null,
    cacheWarmup: null,
    helpers: [],
    prevDeltaMap: prevDeltaMap ? Object.fromEntries(prevDeltaMap) : null,
  };

  console.log('Bench config:', { mode, TASKS, ITERS, POOL_SIZES, BENCH_RUNS, HELPER_OPS });
  const runProfiles = new Set(['all', 'pool', 'variable', 'profiles']).has(mode);
  const runScenarios = new Set(['all', 'pool', 'profiles', 'scenarios']).has(mode);
  const runCacheWarmup = new Set(['all', 'cache', 'scenarios']).has(mode);
  const runHelpers = new Set(['all', 'helpers']).has(mode);

  if (runProfiles) {
    const withTimeout = (p, ms) =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    for (const profile of LOAD_PROFILES) {
      console.log(`\nRunning profile ${profile.name}...`);
      const workload = buildLoadProfile(TASKS, ITERS, profile.variableFraction);
      const profileReport = {
        name: profile.name,
        singleThreaded: null,
        workerThread: null,
        pool: [],
        optimizedPool: [],
        autoscalePool: [],
        autoscaleOptimizedPool: [],
      };

      if (profile.variableFraction === 0) {
        profileReport.singleThreaded = await runSingleThreaded(TASKS, ITERS);
        profileReport.workerThread = await runWorkerThreadBaseline(TASKS, ITERS);
      } else {
        profileReport.singleThreaded = await runSingleThreadedVariable(TASKS, workload.iterations);
        profileReport.workerThread = await runWorkerThreadBaselineVariable(
          TASKS,
          workload.iterations
        );
      }

      const st = profileReport.singleThreaded;
      console.log(
        `  single-threaded total ${st.totalMs.toFixed(2)}ms avg ${st.avgMs.toFixed(2)}ms` +
          (st.durationStats
            ? ` p95=${st.durationStats.p95.toFixed(2)}ms p99=${st.durationStats.p99.toFixed(2)}ms`
            : '')
      );
      console.log(
        `  worker-thread total ${profileReport.workerThread.totalMs.toFixed(2)}ms avg ${profileReport.workerThread.avgMs.toFixed(2)}ms`
      );

      for (const size of POOL_SIZES) {
        console.log(`  Running pool size=${size}...`);
        let r;
        try {
          r = await poolMedian(() =>
            POOL_TIMEOUT > 0
              ? withTimeout(runWorkerPool(size, TASKS, workload.iterations), POOL_TIMEOUT)
              : runWorkerPool(size, TASKS, workload.iterations)
          );
        } catch (err) {
          console.warn('  PowerPool run failed or timed out:', err && err.message);
          r = { totalMs: 0, avgMs: 0, results: null, stats: {} };
        }
        const stMs = st.totalMs;
        const speedup = stMs > 0 && r.totalMs > 0 ? (stMs / r.totalMs).toFixed(2) : '?';
        console.log(
          `    pool total ${r.totalMs.toFixed(2)}ms avg ${r.avgMs.toFixed(2)}ms  speedup=${speedup}x`
        );
        profileReport.pool.push({ size, totalMs: r.totalMs });

        let rOpt;
        try {
          rOpt = await poolMedian(() =>
            POOL_TIMEOUT > 0
              ? withTimeout(
                  runWorkerPoolOptimized(size, TASKS, workload.iterations, workload.keys),
                  POOL_TIMEOUT
                )
              : runWorkerPoolOptimized(size, TASKS, workload.iterations, workload.keys)
          );
        } catch (err) {
          console.warn('  Optimized PowerPool run failed or timed out:', err && err.message);
          rOpt = { totalMs: 0, avgMs: 0, results: null, stats: {} };
        }
        console.log(
          `    pool+cache total ${rOpt.totalMs.toFixed(2)}ms avg ${rOpt.avgMs.toFixed(2)}ms`
        );
        profileReport.optimizedPool.push({ size, totalMs: rOpt.totalMs });

        let rAuto;
        try {
          rAuto = await poolMedian(() =>
            POOL_TIMEOUT > 0
              ? withTimeout(runWorkerPoolAutoscale(size, TASKS, workload.iterations), POOL_TIMEOUT)
              : runWorkerPoolAutoscale(size, TASKS, workload.iterations)
          );
        } catch (err) {
          console.warn('  Autoscale PowerPool run failed or timed out:', err && err.message);
          rAuto = { totalMs: 0, avgMs: 0, results: null, stats: {} };
        }
        console.log(
          `    pool+autoscale total ${rAuto.totalMs.toFixed(2)}ms avg ${rAuto.avgMs.toFixed(2)}ms`
        );
        profileReport.autoscalePool.push({ size, totalMs: rAuto.totalMs });

        let rAutoOpt;
        try {
          rAutoOpt = await poolMedian(() =>
            POOL_TIMEOUT > 0
              ? withTimeout(
                  runWorkerPoolAutoscaleOptimized(size, TASKS, workload.iterations, workload.keys),
                  POOL_TIMEOUT
                )
              : runWorkerPoolAutoscaleOptimized(size, TASKS, workload.iterations, workload.keys)
          );
        } catch (err) {
          console.warn('  Autoscale+cache PowerPool run failed or timed out:', err && err.message);
          rAutoOpt = { totalMs: 0, avgMs: 0, results: null, stats: {} };
        }
        console.log(
          `    pool+cache+autoscale total ${rAutoOpt.totalMs.toFixed(2)}ms avg ${rAutoOpt.avgMs.toFixed(2)}ms`
        );
        profileReport.autoscaleOptimizedPool.push({ size, totalMs: rAutoOpt.totalMs });
      }

      report.profiles.push(profileReport);
    }
  }
  if (runScenarios) {
    const scenarios = [
      runScenarioBurstiness,
      runScenarioMixedTaskSizes,
      runScenarioRampTraffic,
      runScenarioPayloadSize,
      runScenarioIOBound,
      runScenarioThunderingHerd,
      () => runScenarioCacheHitRatio(0.1),
      () => runScenarioCacheHitRatio(0.5),
      () => runScenarioCacheHitRatio(0.9),
    ];
    for (const fn of scenarios) {
      try {
        const scenarioReport = await fn();
        console.log(`\nRunning scenario: ${scenarioReport.name}...`);
        report.scenarios.push(scenarioReport);
      } catch (err) {
        console.warn('Scenario benchmark failed:', err && err.message);
      }
    }
  }
  if (mode === 'all' || mode === 'cache') {
    console.log('Running cache benchmark...');
    const r = await runCacheBenchmark(TASKS, Math.max(1, Math.floor(ITERS / 1000)));
    console.log(
      `Cache miss total ${r.missTotal.toFixed(2)}ms, hit total (${r.reps} reps) ${r.hitTotal.toFixed(2)}ms`
    );
    report.cache = r;

    // Cache eviction under tight capacity
    try {
      console.log('Running cache eviction pressure benchmark...');
      report.cacheEviction = await runCacheEvictionPressure(
        TASKS,
        Math.max(1, Math.floor(ITERS / 1000))
      );
      console.log(
        `Cache eviction: miss=${report.cacheEviction.missTotal.toFixed(2)}ms hit=${report.cacheEviction.hitTotal.toFixed(2)}ms maxEntries=${report.cacheEviction.maxEntries}`
      );
    } catch (err) {
      console.warn('Cache eviction benchmark failed:', err && err.message);
    }

    // Serial vs concurrent getOrSetAsync
    try {
      console.log('Running serial vs concurrent cache benchmark...');
      report.cacheSerialVsConcurrent = await runCacheSerialVsConcurrent(TASKS, ITERS);
      console.log(
        `Serial ${report.cacheSerialVsConcurrent.serialMs.toFixed(2)}ms  Concurrent ${report.cacheSerialVsConcurrent.concurrentMs.toFixed(2)}ms`
      );
    } catch (err) {
      console.warn('Serial vs concurrent cache benchmark failed:', err && err.message);
    }

    try {
      const rCacheDedupe = await runCacheGetOrSetAsyncBenchmark(TASKS, ITERS);
      console.log(
        `Cache getOrSetAsync dedupe total ${rCacheDedupe.totalMs.toFixed(2)}ms avg ${rCacheDedupe.avgMs.toFixed(2)}ms`
      );
      report.cacheDedupe = rCacheDedupe;
    } catch (err) {
      console.warn('Cache getOrSetAsync benchmark failed:', err && err.message);
      report.cacheDedupe = { totalMs: 0, avgMs: 0, uniqueKeys: CACHE_DUPLICATE_KEYS };
    }

    try {
      const rMemo = runMemoizerBenchmark(TASKS, ITERS);
      console.log(
        `PowerMemoizer total ${rMemo.totalMs.toFixed(2)}ms avg ${rMemo.avgMs.toFixed(2)}ms`
      );
      report.memoizer = rMemo;
    } catch (err) {
      console.warn('PowerMemoizer benchmark failed:', err && err.message);
      report.memoizer = { totalMs: 0, avgMs: 0, uniqueKeys: MEMOIZER_DUPLICATE_KEYS };
    }
  }

  if (runCacheWarmup) {
    try {
      report.cacheWarmup = await runCacheWarmupScenario();
      console.log(
        `Cache warmup cold=${report.cacheWarmup.coldStart.toFixed(2)}ms warm=${report.cacheWarmup.warmStart.toFixed(2)}ms`
      );
    } catch (err) {
      console.warn('Cache warmup benchmark failed:', err && err.message);
      report.cacheWarmup = { coldStart: 0, warmStart: 0, keysCount: 0 };
    }
  }

  if (runHelpers) {
    console.log('\nRunning helper micro-benchmarks...');
    report.helpers = await runAllHelperBenchmarks();
  }

  const fname = 'bench/results.md';
  formatMd(report, fname, prevDeltaMap);
  console.log('Wrote results to', fname);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
