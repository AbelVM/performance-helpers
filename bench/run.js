import { Worker as NodeWorker } from 'worker_threads';
import { writeFileSync } from 'fs';
// Expose Node Worker as global Worker so PowerPool can use it
globalThis.Worker = NodeWorker;

import { PowerPool } from '../src/helpers/powerPool.js';
import { PowerCache } from '../src/helpers/powerCache.js';
import { o2u8 } from '../src/helpers/powerBuffer.js';

const args = process.argv.slice(2);
const mode = args[0] || 'all';
const TASKS = Number(process.env.BENCH_TASKS || 1000);
const ITERS = Number(process.env.BENCH_ITERS || 1000000);
const POOL_SIZES = (process.env.BENCH_POOLS || '1,2,4,8').split(',').map((s) => Number(s));
// Timeout for PowerPool per-pool run in ms. Set to 0 to disable timeout.
// Default to 0 so the harness exercises PowerPool fully unless overridden.
const POOL_TIMEOUT =
  process.env.BENCH_POOL_TIMEOUT === undefined ? 0 : Number(process.env.BENCH_POOL_TIMEOUT);

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

async function runWorkerPool(poolSize, tasks, iterations) {
  // Ensure Node worker loads as an ES module
  const pool = new PowerPool('./bench/worker.js', {
    size: poolSize,
    minSize: poolSize,
    maxSize: poolSize,
    idleTimeout: 10000,
    taskQueue: true,
    workerOptions: { type: 'module' },
  });

  // Instrumentation: measure encode/post durations (ms) and collect
  // per-task decode/compute timings reported back by workers.
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

  // Simplified flow: post all tasks, wait for the pool to become idle (drain),
  // then read `getStats().performance` for detailed timing metrics.
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < tasks; i++) {
    // fire-and-forget; PowerPool will track task timings
    // Encode each payload to a fresh Uint8Array and transfer its buffer
    // to avoid the pool's plain-object encoding path which may reuse
    // internal cached buffers and cause unsupported transfer errors.
    const encStart = process.hrtime.bigint();
    const payload = o2u8({ iterations });
    instrumentation.encodeTotalMs += Number(process.hrtime.bigint() - encStart) / 1e6;

    const postStart = process.hrtime.bigint();
    pool.postMessage(payload, [payload.buffer]);
    instrumentation.postTotalMs += Number(process.hrtime.bigint() - postStart) / 1e6;
  }

  // Wait until pool drains (queue empty and workers idle). `drain()` resolves with getStats().
  const statsObj = await pool.drain();
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;

  // Derive average from pool stats when available, fallback to total/tasks
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

async function runWorkerPoolVariable(poolSize, tasks, iterationsArray) {
  const pool = new PowerPool('./bench/worker.js', {
    size: poolSize,
    minSize: poolSize,
    maxSize: poolSize,
    idleTimeout: 10000,
    taskQueue: true,
    workerOptions: { type: 'module' },
  });

  // Instrumentation like `runWorkerPool`
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
    const iters = Math.max(1, Math.round(iterationsArray[i]));
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
  lines.push('# Benchmark Results');
  lines.push(`\nGenerated: ${report.timestamp}\n`);
  lines.push('## Configuration\n');
  lines.push(`- TASKS: ${report.config.TASKS}`);
  lines.push(`- ITERS: ${report.config.ITERS}`);
  lines.push(`- POOL_SIZES: ${report.config.POOL_SIZES.join(', ')}`);
  // Constant-load benchmark (single-threaded + pool)
  lines.push('\n## Constant-load benchmark\n');
  if (report.singleThreaded) {
    lines.push(`- Single-threaded total: ${report.singleThreaded.totalMs.toFixed(2)} ms`);
    lines.push(`- Single-threaded avg per task: ${report.singleThreaded.avgMs.toFixed(2)} ms`);
  }
  if (report.workerThread) {
    lines.push(`- Worker-thread total: ${report.workerThread.totalMs.toFixed(2)} ms`);
    lines.push(`- Worker-thread avg per task: ${report.workerThread.avgMs.toFixed(2)} ms`);
  }

  if (report.pool && report.pool.length) {
    // determine all performance keys (flatten nested objects)
    const perfKeys = new Set();
    for (const pr of report.pool) {
      const p = pr.stats || {};
      for (const k of Object.keys(p)) {
        if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) {
          for (const sub of Object.keys(p[k])) perfKeys.add(`${k}.${sub}`);
        } else {
          perfKeys.add(k);
        }
      }
    }
    // remove verbose worker/task-count fields we don't want in the tables
    perfKeys.delete('totalWorkersCreated');
    perfKeys.delete('totalTasksPerformed');
    perfKeys.delete('averageTasksPerWorkerUntilTermination');
    // include runner totals to match variable-load table structure
    const keys = ['size', 'totalMs', ...Array.from(perfKeys)];
    // header labels mapping defined at function scope
    // header
    lines.push('');
    lines.push(`| ${keys.map((k) => headerLabel(k)).join(' | ')} |`);
    lines.push(
      `| ${keys.map((k) => (k === 'size' ? '----------:' : '-----------:')).join(' | ')} |`
    );
    // rows
    for (const pr of report.pool) {
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
  } else {
    lines.push('- No pool results');
  }

  // Variable-load benchmark reporting
  lines.push('\n## Variable-load benchmark\n');
  if (report.variable) {
    if (report.variable.singleThreaded) {
      lines.push(
        `- Single-threaded total: ${report.variable.singleThreaded.totalMs.toFixed(2)} ms`
      );
      lines.push(
        `- Single-threaded avg per task: ${report.variable.singleThreaded.avgMs.toFixed(2)} ms`
      );
    }
    if (report.variable.workerThread) {
      lines.push(`- Worker-thread total: ${report.variable.workerThread.totalMs.toFixed(2)} ms`);
      lines.push(
        `- Worker-thread avg per task: ${report.variable.workerThread.avgMs.toFixed(2)} ms`
      );
    }

    if (report.variable.pool && report.variable.pool.length) {
      lines.push('');
      // determine perf keys from variable pool stats
      const varPerfKeys = new Set();
      for (const pr of report.variable.pool) {
        const p = pr.stats || {};
        for (const k of Object.keys(p)) {
          if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) {
            for (const sub of Object.keys(p[k])) varPerfKeys.add(`${k}.${sub}`);
          } else {
            varPerfKeys.add(k);
          }
        }
      }
      // remove verbose worker/task-count fields from variable table as well
      varPerfKeys.delete('totalWorkersCreated');
      varPerfKeys.delete('totalTasksPerformed');
      varPerfKeys.delete('averageTasksPerWorkerUntilTermination');
      // include runner-level totals/avg as columns
      const keysVar = ['size', 'totalMs', ...Array.from(varPerfKeys)];
      lines.push(`| ${keysVar.map((k) => headerLabel(k)).join(' | ')} |`);
      lines.push(
        `| ${keysVar.map((k) => (k === 'size' ? '----------:' : '-----------:')).join(' | ')} |`
      );
      for (const pr of report.variable.pool) {
        const p = pr.stats || {};
        const row = [];
        for (const k of keysVar) {
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
    } else {
      lines.push('- No variable pool results');
    }
  } else {
    lines.push('- No variable-load results');
  }
  lines.push('\n## Cache benchmark');
  if (report.cache) {
    lines.push(`- Miss total: ${report.cache.missTotal.toFixed(2)} ms`);
    lines.push(`- Hit total (${report.cache.reps} reps): ${report.cache.hitTotal.toFixed(2)} ms`);
    lines.push(`- Keys tested: ${report.cache.keysCount}`);
  }

  // write raw JSON file alongside the markdown and add a link to it at the end
  const jsonFilename = 'results.json';
  try {
    writeFileSync(jsonFilename, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write JSON results file', err);
  }
  /*   lines.push(`\n## Raw results data`);
  lines.push('');
  lines.push(`[Raw JSON file](${jsonFilename})`);
 */
  const md = lines.join('\n');
  writeFileSync(filename, md, 'utf8');
}

async function main() {
  const report = {
    timestamp: new Date().toISOString(),
    config: { mode, TASKS, ITERS, POOL_SIZES },
    singleThreaded: null,
    workerThread: null,
    pool: [],
    cache: null,
  };

  console.log('Bench config:', { mode, TASKS, ITERS, POOL_SIZES });
  if (mode === 'all' || mode === 'single') {
    console.log('Running single-threaded compute benchmark...');
    const r = await runSingleThreaded(TASKS, ITERS);
    console.log(`Single-threaded total ${r.totalMs.toFixed(2)}ms avg ${r.avgMs.toFixed(2)}ms`);
    report.singleThreaded = r;
  }
  if (mode === 'all' || mode === 'pool') {
    console.log('Running worker-thread baseline benchmark...');
    try {
      report.workerThread = await runWorkerThreadBaseline(TASKS, ITERS);
      console.log(
        `Worker-thread baseline total ${report.workerThread.totalMs.toFixed(2)}ms avg ${report.workerThread.avgMs.toFixed(2)}ms`
      );
    } catch (err) {
      console.warn('Worker-thread baseline failed:', err && err.message);
      report.workerThread = { totalMs: 0, avgMs: 0 };
    }

    for (const size of POOL_SIZES) {
      console.log(`Running worker pool benchmark with poolSize=${size}...`);
      let r;
      try {
        // attempt PowerPool but allow configurable per-pool timeout (0 = no timeout)
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
          ]);
        if (POOL_TIMEOUT > 0)
          r = await withTimeout(runWorkerPool(size, TASKS, ITERS), POOL_TIMEOUT);
        else r = await runWorkerPool(size, TASKS, ITERS);
      } catch (err) {
        console.warn('PowerPool run failed or timed out:', err && err.message);
        // No fallback: report an empty result for this pool size.
        r = { totalMs: 0, avgMs: 0, results: null, stats: {} };
      }
      console.log(`Pool size ${size} total ${r.totalMs.toFixed(2)}ms avg ${r.avgMs.toFixed(2)}ms`);
      report.pool.push({ size, ...r });
    }
  }
  if (mode === 'all' || mode === 'cache') {
    console.log('Running cache benchmark...');
    const r = await runCacheBenchmark(TASKS, Math.max(1, Math.floor(ITERS / 1000)));
    console.log(
      `Cache miss total ${r.missTotal.toFixed(2)}ms, hit total (${r.reps} reps) ${r.hitTotal.toFixed(2)}ms`
    );
    report.cache = r;
  }

  // Variable-load benchmark: per-task iterations sampled from a normal distribution.
  if (mode === 'all' || mode === 'variable') {
    console.log('Running variable-load benchmark (per-task iterations sampled from normal)...');
    // Generate samples centered at 0.5 (so mapping v*2*ITERS produces values around ITERS)
    const samples = randomNormalArray(TASKS, 0.5, 0.15).map((v) => Math.max(0, v) * 2 * ITERS);
    // single-threaded variable load
    report.variable = report.variable || { singleThreaded: null, workerThread: null, pool: [] };
    try {
      const rVarSingle = await runSingleThreadedVariable(TASKS, samples);
      console.log(
        `Single-threaded (variable) total ${rVarSingle.totalMs.toFixed(2)}ms avg ${rVarSingle.avgMs.toFixed(2)}ms`
      );
      report.variable.singleThreaded = rVarSingle;
    } catch (err) {
      console.warn('Single-threaded variable run failed:', err && err.message);
      report.variable.singleThreaded = { totalMs: 0, avgMs: 0 };
    }

    // worker-thread variable baseline
    try {
      const rVarWorker = await runWorkerThreadBaselineVariable(TASKS, samples);
      console.log(
        `Worker-thread variable baseline total ${rVarWorker.totalMs.toFixed(2)}ms avg ${rVarWorker.avgMs.toFixed(2)}ms`
      );
      report.variable.workerThread = rVarWorker;
    } catch (err) {
      console.warn('Worker-thread variable baseline failed:', err && err.message);
      report.variable.workerThread = { totalMs: 0, avgMs: 0 };
    }

    // pool variable runs
    for (const size of POOL_SIZES) {
      console.log(`Running worker pool (variable) benchmark with poolSize=${size}...`);
      let r;
      try {
        const withTimeout = (p, ms) =>
          Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
          ]);
        if (POOL_TIMEOUT > 0)
          r = await withTimeout(runWorkerPoolVariable(size, TASKS, samples), POOL_TIMEOUT);
        else r = await runWorkerPoolVariable(size, TASKS, samples);
      } catch (err) {
        console.warn('PowerPool variable run failed or timed out:', err && err.message);
        r = { totalMs: 0, avgMs: 0, results: null, stats: {} };
      }
      console.log(
        `Pool variable size ${size} total ${r.totalMs.toFixed(2)}ms avg ${r.avgMs.toFixed(2)}ms`
      );
      report.variable = report.variable || { singleThreaded: null, pool: [] };
      report.variable.pool.push({ size, ...r });
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
