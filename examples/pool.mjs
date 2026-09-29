/**
 * Worker pools: `PowerPool` over real worker threads.
 *
 * Run: `npm run example pool`
 *
 * This one spawns real workers, so it is the only example that costs anything.
 * The point it makes is the one that a mock cannot: a pool's *size* is a
 * latency decision, not a throughput one, and `getStats()` is how you find out
 * which regime you are in.
 *
 * The worker is a real file rather than an inline string, because Node's
 * `Worker` takes a path or a URL — passing a raw string fails with
 * `ERR_WORKER_PATH`, not with anything that mentions modules. That choice has
 * a cost, and the top of the file pays it — see the `preloadNode` note below.
 */
import { fileURLToPath } from 'node:url';
import { PowerPool, preloadNode } from 'performance-helpers';

// In pure ESM, `node:worker_threads` cannot be loaded synchronously, so a
// *path or string* worker source has no constructor to use. The error says
// exactly this, and the fix is one line — but you must call it before
// constructing the pool, not after, and a factory function avoids it entirely:
//
//   new PowerPool(() => new Worker(workerPath))    // no preload needed
//   new PowerPool(workerPathOrUrl)                // needs preloadNode()
//
// If you hit "Node worker_threads is not available synchronously in pure ESM",
// this is the line you are missing.
await preloadNode();

const workerUrl = new URL('./lib/worker.mjs', import.meta.url);

// The pool accepts a factory or a string, not a URL object, and Node's `Worker`
// rejects a `file://` *string* too — it wants a path, or a real URL. An
// absolute path is the one form both accept, so the URL is converted here.
const pool = new PowerPool(fileURLToPath(workerUrl), {
  size: 2,
  minSize: 1,
  maxSize: 4,
  lazy: false,
  idleTimeout: 30_000,
  // Without `awaitResponse` you get a boolean and no correlation bookkeeping —
  // cheaper, and the right default when you do not need the reply.
  messageCodec: 'framed',
});

console.log('PowerPool — 2 workers, 1..4, autoscaling off');
const first = pool.getStats();
console.log('  workers      :', first.status.length);
console.log('  activeTasks  :', first.activeTasks);
console.log('  per-worker   :', first.status.map((w) => `#${w.id}(tasks=${w.tasks})`).join(' '));
console.log('  pool is idle :', first.activeTasks === 0, '\n');

// --- Fire and forget -------------------------------------------------------
const accepted = [];
for (let i = 0; i < 6; i += 1) accepted.push(pool.postMessage({ n: 200_000, id: i }));
console.log('  6 rapid posts, results:', accepted.join(' '));
console.log('  ^ with size 2 the pool does not pretend to be bigger than it is.');
console.log('    `true` means accepted — dispatched *or* queued, not necessarily');
console.log('    already running. Use `getStats()` to tell those apart.\n');

// --- Awaiting replies ------------------------------------------------------
const started = Date.now();
const replies = await Promise.all(
  [0, 1, 2].map((id) => pool.postMessage({ n: 200_000, id }, undefined, { awaitResponse: true }))
);
console.log(
  `  3 awaited replies in ${Date.now() - started}ms:`,
  replies.map((r) => r.total).join(' ')
);
console.log('  ^ each reply came back on the worker that computed it, matched by');
console.log('    the correlationId the pool attached. The worker does not need to');
console.log('    know about that — it just echoes.\n');

const perf = pool.getStats().performance;
console.log('  after the work:');
console.log('    activeTasks :', pool.getStats().activeTasks);
console.log('    timePerTask :', {
  avg: `${perf.timePerTask.average.toFixed(1)} ms`,
  max: `${perf.timePerTask.max.toFixed(1)} ms`,
});

// --- Sizing ----------------------------------------------------------------
// This is the decision a pool exists to inform. Push more concurrent work than
// the workers can take and see where the excess goes.
await Promise.all(
  Array.from({ length: 12 }, (_, i) =>
    pool.postMessage({ n: 300_000, id: i }, undefined, { awaitResponse: true })
  )
);
console.log('\n  after 12 concurrent awaited tasks:');
console.log('    workers    :', pool.workers.length);
console.log('    activeTasks:', pool.getStats().activeTasks);
console.log('  ^ throughput is capped by worker count; anything above that waits.');
console.log('    Growing the pool is the lever, and it costs one thread per worker,');
console.log('    which is why `maxSize` exists as a ceiling rather than a default.\n');

await pool.drain();
pool.terminate();

console.log('  after drain, workers:', pool.workers.length);
console.log('\nOK');
