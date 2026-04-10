import { Worker as NodeWorker } from 'worker_threads';
import { writeFileSync } from 'fs';
// Expose Node Worker as global Worker so PowerPool can use it
globalThis.Worker = NodeWorker;

import { PowerPool } from '../src/helpers/powerPool.js';
import { PowerCache, PowerMemoizer } from '../src/helpers/powerCache.js';
import { o2u8 } from '../src/helpers/powerBuffer.js';

const args = process.argv.slice(2);
const mode = args[0] || 'all';
const TASKS = Number(process.env.BENCH_TASKS || 1000);
const ITERS = Number(process.env.BENCH_ITERS || 1000000);
const POOL_SIZES = (process.env.BENCH_POOLS || '1,2,4,8').split(',').map((s) => Number(s));
const CACHE_DUPLICATE_KEYS = Number(process.env.BENCH_CACHE_DUPLICATE_KEYS || 10);
const MEMOIZER_DUPLICATE_KEYS = Number(process.env.BENCH_MEMOIZER_DUPLICATE_KEYS || 10);
const AUTOSCALE_CACHE_KEYS = Number(process.env.BENCH_AUTOSCALE_CACHE_KEYS || 10);
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
    variableFraction === 0 ? 1 : Math.max(1, Math.min(10, Math.round(repeatedTaskCount / 10)));
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
  return {
    totalMs: Number(t1 - t0) / 1e6,
    avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
    durations,
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
  return {
    totalMs: Number(t1 - t0) / 1e6,
    avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
    durations,
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

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
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
    const payload = makePayload(iters, { payloadSize: payloadSizes[i] });
    promises[i] = cache.getOrSetAsync(
      key,
      () => pool.postMessage(payload, undefined, { awaitResponse: true }),
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

function formatMd(report, filename) {
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

  lines.push('\nLearn more about the benchmarks [here](README.md)\n');

  lines.push('\n## Synthetic scenario benchmarks\n');

  function renderProfileSection(profile) {
    lines.push(`\n### Load profile: ${profile.name}`);
    if (profile.singleThreaded) {
      lines.push(`- Single-threaded total: ${profile.singleThreaded.totalMs.toFixed(2)} ms`);
    }
    if (profile.workerThread) {
      lines.push(`- Worker-thread total: ${profile.workerThread.totalMs.toFixed(2)} ms`);
    }
    lines.push('');

    const sizeHeaders = report.config.POOL_SIZES.map((size) => `${size}`);
    lines.push(`| Pattern \\ Pool size  | ${sizeHeaders.join(' | ')} |`);
    lines.push(`| :--- | ${report.config.POOL_SIZES.map(() => '---:').join(' | ')} |`);

    const patterns = [
      { label: 'Pool', results: profile.pool },
      { label: 'Pool + Autoscale', results: profile.autoscalePool },
      { label: 'Pool + Cache', results: profile.optimizedPool },
      { label: 'Pool + Cache + Autoscale', results: profile.autoscaleOptimizedPool },
    ];

    const allValues = [];
    for (const pattern of patterns) {
      for (const size of report.config.POOL_SIZES) {
        const row = pattern.results?.find((item) => item.size === size);
        if (row && typeof row.totalMs === 'number') {
          allValues.push(row.totalMs);
        }
      }
    }
    const minValue = allValues.length ? Math.min(...allValues) : null;

    for (const pattern of patterns) {
      const values = report.config.POOL_SIZES.map((size) => {
        const row = pattern.results?.find((item) => item.size === size);
        if (row && typeof row.totalMs === 'number') {
          const formatted = row.totalMs.toFixed(2);
          if (minValue !== null && row.totalMs === minValue) {
            return `\`${formatted}\``;
          }
          return formatted;
        }
        return '';
      });
      lines.push(`| ${pattern.label} | ${values.join(' | ')} |`);
    }
  }

  if (report.profiles && report.profiles.length) {
    for (const profile of report.profiles) {
      renderProfileSection(profile);
    }
  } else {
    lines.push('- No profile benchmark results');
  }

  if (report.scenarios && report.scenarios.length) {
    lines.push('\n## Realistic scenario benchmarks\n');
    for (const scenario of report.scenarios) {
      renderProfileSection(scenario);
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
  const report = {
    timestamp: new Date().toISOString(),
    config: {
      mode,
      TASKS,
      ITERS,
      POOL_SIZES,
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
    cacheDedupe: null,
    memoizer: null,
    cacheWarmup: null,
  };

  console.log('Bench config:', { mode, TASKS, ITERS, POOL_SIZES });
  const runProfiles = new Set(['all', 'pool', 'variable', 'profiles']).has(mode);
  const runScenarios = new Set(['all', 'pool', 'profiles', 'scenarios']).has(mode);
  const runCacheWarmup = new Set(['all', 'cache', 'scenarios']).has(mode);

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

      console.log(
        `  single-threaded total ${profileReport.singleThreaded.totalMs.toFixed(2)}ms avg ${profileReport.singleThreaded.avgMs.toFixed(2)}ms`
      );
      console.log(
        `  worker-thread total ${profileReport.workerThread.totalMs.toFixed(2)}ms avg ${profileReport.workerThread.avgMs.toFixed(2)}ms`
      );

      for (const size of POOL_SIZES) {
        console.log(`  Running pool size=${size}...`);
        let r;
        try {
          if (POOL_TIMEOUT > 0)
            r = await withTimeout(runWorkerPool(size, TASKS, workload.iterations), POOL_TIMEOUT);
          else r = await runWorkerPool(size, TASKS, workload.iterations);
        } catch (err) {
          console.warn('  PowerPool run failed or timed out:', err && err.message);
          r = { totalMs: 0, avgMs: 0, results: null, stats: {} };
        }
        console.log(`    pool total ${r.totalMs.toFixed(2)}ms avg ${r.avgMs.toFixed(2)}ms`);
        profileReport.pool.push({ size, totalMs: r.totalMs });

        let rOpt;
        try {
          if (POOL_TIMEOUT > 0)
            rOpt = await withTimeout(
              runWorkerPoolOptimized(size, TASKS, workload.iterations, workload.keys),
              POOL_TIMEOUT
            );
          else rOpt = await runWorkerPoolOptimized(size, TASKS, workload.iterations, workload.keys);
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
          if (POOL_TIMEOUT > 0)
            rAuto = await withTimeout(
              runWorkerPoolAutoscale(size, TASKS, workload.iterations),
              POOL_TIMEOUT
            );
          else rAuto = await runWorkerPoolAutoscale(size, TASKS, workload.iterations);
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
          if (POOL_TIMEOUT > 0)
            rAutoOpt = await withTimeout(
              runWorkerPoolAutoscaleOptimized(size, TASKS, workload.iterations, workload.keys),
              POOL_TIMEOUT
            );
          else
            rAutoOpt = await runWorkerPoolAutoscaleOptimized(
              size,
              TASKS,
              workload.iterations,
              workload.keys
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

  const fname = 'bench/results.md';
  formatMd(report, fname);
  console.log('Wrote results to', fname);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
