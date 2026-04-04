# Lightweight web worker pool

A small, dependency-free worker pool that wraps underlying Worker instances. It encodes plain object messages to transferable `Uint8Array` for efficient transfer, decodes incoming binary messages back to objects, and provides queuing / grow / reaper behavior.

## PowerPool

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

### API

| method | params | returns | description |
|---|---|---|---|
| `postMessage(message, transfer, options)` | `message`, `transfer?`, `options?` | `boolean \| Promise<response>` | When `options.awaitResponse` (or `options.correlationId`) is provided, returns a `Promise` that resolves when a worker responds with a matching `correlationId`. The outgoing `message` will be augmented with `correlationId` (auto-generated if omitted). |
| | | | `options.workerId` (number) — route this message to a specific worker by its numeric `id`. If the targeted worker does not exist or is currently at capacity the call will fail (returns `false` or rejects the returned Promise). |
| `drain()` | — | `Promise<object>` | Returns a Promise that resolves when the pool is idle (queue empty and all workers have `tasks === 0`). Resolves with the result of `getStats()`. |
| `resize(n)` | `number` | — | Dynamically change the pool `maxSize`. If `n` is smaller than the current number of workers, excess workers are terminated (at least `minSize` are kept). If `n` is larger, the pool may grow up to the new limit when demand increases. |
| `resize({ minSize, maxSize })` | `object` | — | Overload to atomically set both `minSize` and `maxSize`. The pool will spawn new workers to reach `minSize` (subject to `maxSize`) and terminate excess workers when shrinking. The pool emits a `resize` event and `onresize` callback with payload `{ terminated: number[], added: number, minSize, maxSize }` when resizing causes additions/terminations. |
| `broadcast(message, transfer)` | `message`, `transfer?` | `void` | Send a message to all workers. Increments each worker's `tasks` counter. |
| `addWorker()` | — | `WorkerObj` | Create and add one worker to the pool immediately. |
| `removeWorker()` | — | `void` | Remove and terminate the last worker. |
| `addEventListener(type, cb)` | `type`, `cb` | `void` | Add listeners for `'message'|'error'|'messageerror'|'idle'`. Idle listeners are invoked immediately if pool is idle. |
| `removeEventListener(type, cb)` | `type`, `cb` | `void` | Remove listener. |
| `terminate()` | — | `void` | Terminate all workers, clear queue and reaper interval. |
| `[Symbol.dispose]()` | — | `void` | Synchronous disposal hook that calls `terminate()`. |
| `[Symbol.asyncDispose]()` | — | `Promise<void>` | Asynchronous disposal hook that awaits `drain()` then `terminate()`. |
| `getStats()` | — | `{status: Array<{id,tasks,lastActive}>, performance: Object}` | Snapshot of live per-worker stats plus aggregated performance metrics. `timePerTask` (min/max/average/stddev) is computed using O(1) streaming (Welford) statistics; `percentSlowTasks` is not computed exactly by default. |

### Events and handlers

- `onmessage`, `onerror`, `onidle` — setter/getter properties for convenient handlers. `onidle` and `'idle'` listeners receive events with `data.type === 'pool:idle'` and `data.stats` containing `{ status, performance }` where `status` is the per-worker snapshot and `performance` is aggregated metrics.
- `idle` event is fired inmediately at event registration time if the pool is currently idle

### Example

```javascript
import MyWorker from './my-worker.js?worker'
const pool = createPool(MyWorker, { size: 2 })
pool.onmessage = (e) => console.log('pool message', e.data)
pool.postMessage({ hello: 'world' })
```

### Recommendations

- Use `PowerPool` when you need a small, managed pool of Workers with automatic queuing and idle termination.
- Prefer sending plain objects — `PowerPool` will encode them to `Uint8Array` and mark the underlying `ArrayBuffer` transferable to avoid copies.
- Register `error` / `messageerror` listeners to handle and log underlying Worker problems; the pool forwards these events to registered listeners.
- Tune `size`, `maxSize`, `idleTimeout` and `maxTasksPerWorker` for your workload. When using many short tasks, a small pool with aggressive queuing often performs best.
