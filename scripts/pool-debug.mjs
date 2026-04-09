import { PowerPool } from '../src/helpers/powerPool.js';
import { o2u8 } from '../src/helpers/powerBuffer.js';
import { Worker as NodeWorker } from 'worker_threads';
globalThis.Worker = NodeWorker;
import { performance } from 'perf_hooks';

async function run() {
  const pool = new PowerPool('./bench/worker.js', {
    size: 1,
    minSize: 1,
    maxSize: 1,
    idleTimeout: 10000,
    taskQueue: true,
    workerOptions: { type: 'module' },
  });
  const payload = o2u8({ iterations: 1000000 });
  const p0 = pool.postMessage(payload, [payload.buffer]);
  console.log('after first dispatch, tasks=', pool.workers[0]?.tasks, 'queue=', pool.queue.length);
  const payload2 = o2u8({ iterations: 1000000 });
  const p1 = pool.postMessage(payload2, [payload2.buffer]);
  console.log('after second dispatch, tasks=', pool.workers[0]?.tasks, 'queue=', pool.queue.length);
  await pool.drain();
  console.log('final tasks=', pool.workers[0]?.tasks, 'queue=', pool.queue.length);
  pool.terminate();
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
