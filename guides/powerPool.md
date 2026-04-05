# PowerPool

A small, dependency-free worker pool that wraps underlying Worker instances. It encodes plain object messages to transferable `Uint8Array` for efficient transfer, decodes incoming binary messages back to objects, and provides queuing / grow / reaper behavior.

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `workerSource` | `Function \| string` | — | Either a Worker factory/constructor (callable) or a relative path string passed to `new Worker(new URL(path, import.meta.url))`. |
| `options.size` | `number` | `min(navigator.hardwareConcurrency \|\| 2, 2)` | Initial number of workers to spawn. |
| `options.minSize` | `number` | `1` | Minimum workers to keep alive. |
| `options.maxSize` | `number` | `Math.max(size, hwConcurrency)` | Maximum workers allowed in the pool. |
| `options.workerOptions` | `Object` | `{}` | Options forwarded to the Worker constructor when using a string `workerSource`. |
| `options.maxTasksPerWorker` | `number` | `Infinity` | Soft capacity per worker before it is considered busy. |
| `options.idleTimeout` | `number` | `60000` | Milliseconds after which idle workers (beyond `minSize`) are terminated. |
| `options.taskQueue` | `boolean` | `true` | Whether to queue tasks when pool is saturated. |
| `options.lazy` | `boolean` | `true` | When `true` defer creating workers up to `size` until demand; only `minSize` workers are created at construction. Use this for low-load deployments to avoid unnecessary worker startup cost. |
| `options.listenerMaxListeners` / `options.maxListeners` | `number` | `0` (unlimited) | Maximum listeners per internal pool event (see notes). `0` means unlimited. If set to a positive number the pool will throw when registering additional listeners beyond that limit. |
| `options.weakListeners` | `boolean` | `false` | When `true` the pool stores listeners as weak references (when supported by the runtime). This avoids retaining large closures but requires `FinalizationRegistry`/`WeakRef` support; you can call `pool._bus.cleanup()` to force cleanup of dead weak refs in environments without deterministic GC (primarily useful for tests). |
| `options.autoScale` | `boolean \| Object` | `false` | When provided (or `true`), enables autoscaling. Supply `true` to use defaults, or an object to tune behavior. See the **Autoscaling** section below for properties and tuning recommendations. |

## API

- `postMessage(message, transfer, options)` — Dispatch a single message to the pool. Returns `true` when dispatched/queued successfully, or when `options.awaitResponse` (or `options.correlationId`) is present returns a `Promise` that resolves with the worker response. When sending plain objects the pool will attempt to encode them into `Uint8Array` transferables (via `o2u8`) automatically unless an explicit `transfer` list is supplied. Pass `options.workerId` to route the message to a specific worker id; targeting a missing or saturated worker will fail (returns `false` or a rejected Promise).

	- Note: `options.awaitResponse` requires the outgoing `message` to be a plain-object (not a TypedArray/ArrayBuffer). The implementation augments the object with a `correlationId` and will throw if a non-plain-object is supplied when `awaitResponse` is requested.
	- `options.workerId` may be a `number` or `string` (the pool coerces ids to strings internally for correlation handling).

- `drain()` — Returns a `Promise` that resolves once the pool is idle (internal queue empty and all workers have `tasks === 0`). Resolves with the same snapshot shape as `getStats()` to aid in shutdown reporting.

- `resize(n)` / `resize({ minSize, maxSize })` — Dynamically alter sizing. Passing a number adjusts `maxSize`; passing an object sets `minSize`/`maxSize` atomically. Shrinking may terminate excess workers (but preserves `minSize`), while growing allows the pool to spawn workers on demand up to `maxSize`. A `resize` event is emitted when workers are added/terminated.

- `broadcast(message, transfer)` — Send `message` to every worker in the pool. Each worker receives either the provided transferable or an independently encoded `Uint8Array` when `transfer` is omitted and a plain object is provided. Broadcasting increments each worker's `tasks` counter.

- `postMessageBatch(items, options)` — Enqueue or dispatch a batch of messages in a single call. `items` is an array of `{ message, transfer? }`. Returns an array of per-item results (booleans or Promises when `awaitResponse` is requested). Use this to amortize queue push overhead for many items.

- `prepareBuffer(obj, { clone = true })` — Prepare a single transferable `Uint8Array` for `obj`. When `clone` is `true` returns a clone safe to transfer; when `clone` is `false` returns a cached internal buffer that must not be transferred. Useful to pre-encode hot payloads.

- `prepareBuffers(items, { clone = true })` — Prepare an array of normalized `{ message, transfer }` entries for use with `postMessageBatch`. Each returned entry is ready to be dispatched or queued and avoids per-item encoding overhead at send time.

- `stopThePressBatch(items, options)` — Atomically clear the queue, terminate (and optionally recreate) inflight workers, reject pending awaitResponse promises, then forward the provided batch. Returns per-item results like `postMessageBatch`. Useful for emergency replacement of queued work with a new batch.

- `stopThePress(message, transfer, options)` — Clear the internal queue, terminate running workers (rejecting pending response Promises), and send the provided `message` through the same dispatch semantics as `postMessage`. By default the pool will recreate replacement workers; pass `options.recreateWorkers = false` to keep the pool reduced.

- `addWorker()` / `removeWorker()` — Programmatically create or terminate a single worker from the pool.

- Event APIs: `addEventListener(type, cb)` / `removeEventListener(type, cb)` — Manage listeners for `'message'`, `'error'`, `'messageerror'`, and `'idle'`. `idle` listeners are invoked immediately if the pool is currently idle.

- `terminate()` — Immediately terminate all workers, clear queues, and stop the reaper interval.

- Disposal hooks: `[Symbol.dispose]()` calls `terminate()` synchronously; `[Symbol.asyncDispose]()` awaits `drain()` then terminates.

- `getStats()` — Return a snapshot `{ status: Array<{id,tasks,lastActive}>, performance: Object }` with per-worker status and aggregated performance metrics (EWMA/time-per-task stats). This is useful for logging and autoscale decisions.

## Autoscaling

`PowerPool` supports an optional autoscaling mode that grows or shrinks the worker pool based on recent observed task latency (EWMA) and queue pressure. Enable it by passing `options.autoScale` to the constructor.

When `autoScale` is a boolean `true` the pool uses sensible defaults. For production workloads pass an object to tune behavior:

```js
const pool = new PowerPool(WorkerScript, {
	minSize: 1,
	maxSize: 16,
	autoScale: {
		intervalMs: 1000,   // evaluation interval (ms)
		targetMs: 50,       // target per-task latency (ms)
		alpha: 0.2,         // EWMA smoothing factor (0..1)
		cooldownMs: 5000,   // minimum time between scale actions (ms)
		hysteresis: 0.2     // fractional hysteresis (0..1) to avoid flapping
	}
});
```

Behavior summary:

- The pool maintains a pool-level EWMA of recent task durations.
- Every `intervalMs` the pool evaluates scaling decisions:
	- Scale up when EWMA exceeds `targetMs * (1 + hysteresis)` or when queue pressure is high.
	- Scale down when EWMA falls below `targetMs * (1 - hysteresis)` and the queue is empty.
- `cooldownMs` prevents rapid oscillation by requiring a minimum delay between scale actions.

Tuning tips:

- Increase `targetMs` for longer-running tasks.
- Lower `alpha` to smooth noisy workloads; increase it to react faster.
- Use `cooldownMs` (e.g., 3–10s) to avoid repeated add/remove cycles.
- `hysteresis` values of 0.1–0.3 are typically effective at preventing flapping.

See [autscale guide](autoscale.md) for more details and examples.

## Events and handlers

- `onmessage`, `onerror`, `onidle` — setter/getter properties for convenient handlers. `onidle` and `'idle'` listeners receive events with `data.type === 'pool:idle'` and `data.stats` containing `{ status, performance }` where `status` is the per-worker snapshot and `performance` is aggregated metrics.
- `idle` event is fired inmediately at event registration time if the pool is currently idle

## Example
## Realistic Example — image thumbnail worker

This example shows a common pattern: a pool of workers that produce thumbnail images from large binary blobs. The pool dispatches work, awaits per-task responses, and drains before graceful shutdown.

```javascript
import ImageWorker from './image-worker.js?worker';
import { PowerPool } from '../src/helpers/powerPool.js';

// Create a small pool tuned for CPU-bound thumbnailing
const pool = new PowerPool(ImageWorker, { size: 2, maxSize: 4, idleTimeout: 30_000 });
// For low-load deployments avoid eager worker startup:
// const pool = new PowerPool(ImageWorker, { size: 2, maxSize: 4, idleTimeout: 30_000, lazy: true });

// Helper to post a job and await the worker's response
async function makeThumbnail(imageBuffer) {
	// workers are expected to echo back { correlationId, response }
	const req = { op: 'thumbnail', payload: imageBuffer };
	return pool.postMessage(req, undefined, { awaitResponse: true, timeout: 10_000 });
}

// Process a batch of images concurrently but with backpressure from the pool
async function processImages(images) {
	const tasks = images.map((img) => makeThumbnail(img));
	// await all thumbnails (each item may be a Promise)
	const thumbs = await Promise.all(tasks);
	console.log('generated', thumbs.length, 'thumbnails');
}

// On shutdown ensure all inflight work completes
async function shutdown() {
	// Option A: graceful shutdown — wait for in-flight work to complete then stop the pool
	await pool.drain(); // wait until queue empty and workers idle
	// `terminate()` now delegates to `shutdown()` internally, but you can call either.
	pool.terminate();
}

// Example usage
(async () => {
	const images = await loadManyImages(); // user-defined helper
	await processImages(images);
	await shutdown();
})();
```

## Explicit shutdown vs terminate

`PowerPool` exposes two related lifecycle APIs:

- `shutdown()` — performs a full stop: clears the internal reaper interval, terminates workers, clears internal queues, and rejects any pending `awaitResponse` Promises with a `PowerPoolShutdownError`. Use this when you need to ensure no background timers remain and that any callers awaiting responses are notified.

- `terminate()` — delegates to `shutdown()` for consistent behavior. It is safe to call synchronously when tearing down resources; it will also reject pending Promises and clear timers.

Examples:

Graceful drain then explicit shutdown (preferred when you want in-flight work to finish):

```javascript
await pool.drain();
await pool.shutdown(); // rejects any stray pending promises and clears timers
```

Immediate stop (rejects pending awaits):

```javascript
pool.terminate(); // synchronous; delegates to shutdown internally
```

Handling shutdown rejections (when callers previously awaited a response):

```javascript
try {
	const p = pool.postMessage({ op: 'work' }, undefined, { awaitResponse: true });
	// somewhere else: pool.shutdown() or pool.terminate() may be called
	const resp = await p;
} catch (err) {
	if (err && err.name === 'PowerPoolShutdownError') {
		// pool was shut down while awaiting response
	} else {
		// other error
	}
}
```


## Batch examples

```javascript
// Fire-and-forget batch (optimized path)
const batch = [{ message: { task: 1 } }, { message: { task: 2 } }];
const results = pool.postMessageBatch(batch);
// results: [ true, true ] — dispatched or queued

// Await per-item responses (each entry returns a Promise)
const r = pool.postMessageBatch(
	[{ message: { req: 'a' } }, { message: { req: 'b' } }],
	{ awaitResponse: true, timeout: 5000 }
);
// r is an array like [ Promise, Promise ] — await as needed
const responses = await Promise.all(r.map((p) => (p instanceof Promise ? p : Promise.resolve(p))));
console.log('batch responses', responses);
```

### Preparing buffers for hotspot workloads

`prepareBuffers(items, { clone = true })` lets you pre-encode a batch of messages into transferable `Uint8Array` buffers so you can avoid repeated encoding during `postMessageBatch` or `broadcast`. Each `items` entry may be a plain object, a `Uint8Array`/TypedArray, or `{ message, transfer? }`.

Example — pre-encode a large shared payload and send cloned transferable buffers per worker:

```javascript
// Pre-encode 100 items (clone=true makes each returned buffer safe to transfer)
const prepared = pool.prepareBuffers(
	Array.from({ length: 100 }, () => ({ message: { big: 'payload', repeated: true } })),
	{ clone: true }
);
// prepared is an array of { message: Uint8Array, transfer: [ArrayBuffer] }
const res = pool.postMessageBatch(prepared);
```

Example — prepare once and reuse cached buffer references (clone=false). WARNING: do not transfer the returned buffers when `clone:false` — they are shared cached objects.

```javascript
const cached = pool.prepareBuffer({ heavy: 'payload' }, { clone: false });
// Use clone when sending to workers to avoid transferring the cached buffer itself:
pool.postMessage(cached.slice(), [cached.buffer]);
```

### Zero-copy: forwarding raw ArrayBuffers / TypedArrays

When your producer already has an `ArrayBuffer` or a `TypedArray` (for example a decoded image or a pre-serialized payload) you can avoid re-encoding and enable zero-copy transfers by passing the raw buffer directly. The pool will auto-add the underlying `ArrayBuffer` to the transfer list when no `transfer` is provided.

If you want to explicitly request zero-copy semantics (forward the exact buffer without cloning), pass the `zeroCopy: true` option to `postMessage`, `postMessageBatch`, or `broadcast`.

```javascript
// Send a pre-serialized Uint8Array directly (auto-transfer when transfer omitted)
const buf = new Uint8Array(largePayload);
pool.postMessage(buf); // pool will auto-add buf.buffer to transfer list

// Explicit zero-copy (caller accepts that buffer may be neutered/transferred):
pool.postMessage(buf, undefined, { zeroCopy: true });

// For batches, pass options.zeroCopy to postMessageBatch so prepared items are forwarded as-is
const batch = Array.from({ length: 10 }, () => ({ message: new Uint8Array(1024) }));
pool.postMessageBatch(batch, { zeroCopy: true });
```

Notes:
- `zeroCopy: true` only affects `ArrayBuffer`/TypedArray messages — plain objects cannot be forwarded zero-copy and will be encoded as before.
- When using cached buffers via `prepareBuffer(..., { clone: false })`, do NOT transfer the cached buffer itself; clone it first via `slice()` if you need a transferable copy.

## Recommendations

- Use `PowerPool` when you need a small, managed pool of Workers with automatic queuing and idle termination.
- Prefer sending plain objects — `PowerPool` will encode them to `Uint8Array` and mark the underlying `ArrayBuffer` transferable to avoid copies. For broadcasts, each worker receives an independently encoded transferable buffer when no transfer list is provided.
- Register `error` / `messageerror` listeners to handle and log underlying Worker problems; the pool forwards these events to registered listeners.
 - Register `error` / `messageerror` listeners to handle and log underlying Worker problems; the pool forwards these events to registered listeners.
	 Note: Node's `worker_threads` does not emit `messageerror` natively. `PowerPool` normalizes cross-platform behavior: when binary decoding fails the pool will emit a `messageerror` event on the pool-level bus so listeners receive the event even if the underlying worker implementation lacks native `messageerror` support. The pool also still forwards the raw binary payload to `onmessage` so existing consumers receive the data.
- Tune `size`, `maxSize`, `idleTimeout` and `maxTasksPerWorker` for your workload. When using many short tasks, a small pool with aggressive queuing often performs best.

## Complexity & Performance Tips

- **Amortized cost:** `postMessage` and `broadcast` will try direct dispatch first and then queue. Use `postMessageBatch` to amortize per-item overhead when enqueuing many tasks.
- **Encoding & transfers:** When `transfer` is omitted and you supply a plain object, `PowerPool` encodes the object to a transferable `Uint8Array` (via `o2u8`). This avoids structured-clone copies but does allocate a buffer per encoded item. If you share the same large payload across many workers, consider pre-creating a transferable `ArrayBuffer` and passing it in `transfer` to avoid repeated encoding.
- **Batched enqueue:** `postMessageBatch` prepares each item once and uses `PowerQueue.pushMany` to enqueue remaining items in one operation, reducing O(n) push overhead.
- **Awaiting responses:** `options.awaitResponse` introduces per-item Promise bookkeeping and correlation ids; for very large batches prefer fire-and-forget and implement separate result aggregation inside workers if possible.
- **Tuning concurrency:** `maxTasksPerWorker` controls soft saturation per worker. Raising it increases parallelism per worker but can make latency variance higher; use `getStats()` and EWMA metrics to tune the smoothing and thresholds.
- **stopThePress usage:** `stopThePress` and `stopThePressBatch` terminate inflight work and reject pending responses. By default they recreate replacement workers; pass `options.recreateWorkers = false` to skip recreation when you prefer to keep the pool reduced.

## PowerPool Examples — Advanced

```javascript
// Efficient batch with pre-encoded transferable buffer (avoid per-item encoding)
const shared = o2u8({ big: 'payload', repeated: true });
const batch = Array.from({ length: 100 }, () => ({ message: shared, transfer: [shared.buffer] }));
// All workers will receive the same transferable buffer (caller responsible for reuse semantics).
pool.postMessageBatch(batch);

// Use stopThePress to cancel queued work and replace with urgent tasks
pool.stopThePress({ command: 'flush-and-run' }, null, { recreateWorkers: true });

// Await responses for a small batch (per-item Promises)
const r = pool.postMessageBatch(
	[{ message: { req: 'a' } }, { message: { req: 'b' } }],
	{ awaitResponse: true, timeout: 5000 }
);
const responses = await Promise.all(r.map((p) => (p instanceof Promise ? p : Promise.resolve(p))));
console.log('batch responses', responses);
```
