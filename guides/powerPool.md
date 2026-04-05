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

## API

| method | params | returns | description |
|---|---|---|---|
| `postMessage(message, transfer, options)` | `message`, `transfer?`, `options?` | `boolean \| Promise<response>` | When `options.awaitResponse` (or `options.correlationId`) is provided, returns a `Promise` that resolves when a worker responds with a matching `correlationId`. The outgoing `message` will be augmented with `correlationId` (auto-generated if omitted). If `transfer` is omitted and a plain object is supplied, the pool will attempt to encode the object into a transferable `Uint8Array` (via `o2u8`) before dispatch so callers can omit manual encoding when sending large payloads. |
| | | | `options.workerId` (number) — route this message to a specific worker by its numeric `id`. If the targeted worker does not exist or is currently at capacity the call will fail (returns `false` or rejects the returned Promise). |
| `drain()` | — | `Promise<object>` | Returns a Promise that resolves when the pool is idle (queue empty and all workers have `tasks === 0`). Resolves with the result of `getStats()`. |
| `resize(n)` | `number` | — | Dynamically change the pool `maxSize`. If `n` is smaller than the current number of workers, excess workers are terminated (at least `minSize` are kept). If `n` is larger, the pool may grow up to the new limit when demand increases. |
| `resize({ minSize, maxSize })` | `object` | — | Overload to atomically set both `minSize` and `maxSize`. The pool will spawn new workers to reach `minSize` (subject to `maxSize`) and terminate excess workers when shrinking. The pool emits a `resize` event and `onresize` callback with payload `{ terminated: number[], added: number, minSize, maxSize }` when resizing causes additions/terminations. |
| `broadcast(message, transfer)` | `message`, `transfer?` | `void` | Send a message to all workers. Increments each worker's `tasks` counter. If `transfer` is omitted and a plain object is supplied, the pool will encode the object per-worker into transferable `Uint8Array` buffers so every worker receives an independent transferable buffer. |
| `postMessageBatch(items, options)` | `[{message, transfer?}]`, `options?` | `Array<boolean|Promise>` | Send a batch of messages to the pool. Each item is `{ message, transfer? }`. Returns an array with per-item results (boolean or Promise when `awaitResponse` is used). Useful to seed the queue in one call instead of iterating. |
| `stopThePressBatch(items, options)` | `[{message, transfer?}]`, `options?` | `Array<boolean|Promise>` | Clear the internal task queue, terminate inflight workers (optionally recreate them via `options.recreateWorkers`), reject pending response Promises, then forward the provided batch to the pool. Returns per-item results like `postMessageBatch`. |
| `stopThePress(message, transfer, options)` | `message`, `transfer?`, `options?` | `boolean \| Promise<response>` | Clear the internal task queue (cancelling all pending tasks) then send `message` to the pool using the same dispatch semantics as `postMessage`. Useful for stopping queued work and broadcasting a new control message atomically. `stopThePress` also terminates currently running tasks (by terminating worker instances) and rejects any in-flight `postMessage` Promises. By default the pool recreates replacement workers after termination; pass `options.recreateWorkers = false` to skip recreation. Use with care: any ongoing processing inside workers will be interrupted. |
| `addWorker()` | — | `WorkerObj` | Create and add one worker to the pool immediately. |
| `removeWorker()` | — | `void` | Remove and terminate the last worker. |
| `addEventListener(type, cb)` | `type`, `cb` | `void` | Add listeners for `'message'|'error'|'messageerror'|'idle'`. Idle listeners are invoked immediately if pool is idle. |
| `removeEventListener(type, cb)` | `type`, `cb` | `void` | Remove listener. |
| `terminate()` | — | `void` | Terminate all workers, clear queue and reaper interval. |
| `[Symbol.dispose]()` | — | `void` | Synchronous disposal hook that calls `terminate()`. |
| `[Symbol.asyncDispose]()` | — | `Promise<void>` | Asynchronous disposal hook that awaits `drain()` then `terminate()`. |
| `getStats()` | — | `{status: Array<{id,tasks,lastActive}>, performance: Object}` | Snapshot of live per-worker stats plus aggregated performance metrics. `timePerTask` (min/max/average/stddev) is computed using O(1) streaming (Welford) statistics; `percentSlowTasks` is not computed exactly by default. |

## Events and handlers

- `onmessage`, `onerror`, `onidle` — setter/getter properties for convenient handlers. `onidle` and `'idle'` listeners receive events with `data.type === 'pool:idle'` and `data.stats` containing `{ status, performance }` where `status` is the per-worker snapshot and `performance` is aggregated metrics.
- `idle` event is fired inmediately at event registration time if the pool is currently idle

## Example

```javascript
import MyWorker from './my-worker.js?worker'
// Optionally import the formatter for normalized error objects
// import { formatErrorObj } from '../src/utils/errors.js'
const pool = createPool(MyWorker, { size: 2 })
// Use a listener that formats normalized error objects when present
pool.addEventListener('message', (e) => {
	const d = e && e.data;
	if (d && d.error) {
		// console.error(formatErrorObj(d));
		console.error('worker error:', d.code || 'ERR', d.message || '');
		return;
	}
	console.log('pool message', d);
});
pool.postMessage({ hello: 'world' })
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

## Recommendations

- Use `PowerPool` when you need a small, managed pool of Workers with automatic queuing and idle termination.
- Prefer sending plain objects — `PowerPool` will encode them to `Uint8Array` and mark the underlying `ArrayBuffer` transferable to avoid copies. For broadcasts, each worker receives an independently encoded transferable buffer when no transfer list is provided.
- Register `error` / `messageerror` listeners to handle and log underlying Worker problems; the pool forwards these events to registered listeners.
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
