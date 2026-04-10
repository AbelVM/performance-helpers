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

function createWorkerPool(poolSize, autoscale = false) {
  const options = {
    size: autoscale ? 1 : poolSize,
    minSize: autoscale ? 1 : poolSize,
    maxSize: poolSize,
    idleTimeout: 10000,
    taskQueue: true,
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

  function renderProfileSection(profile) {
    lines.push(`\n## Load profile: ${profile.name}`);
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
    },
    profiles: [],
    cache: null,
    cacheDedupe: null,
    memoizer: null,
  };

  console.log('Bench config:', { mode, TASKS, ITERS, POOL_SIZES });
  const runProfiles = new Set(['all', 'pool', 'variable', 'profiles']).has(mode);

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

  const fname = 'bench/results.md';
  formatMd(report, fname);
  console.log('Wrote results to', fname);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
