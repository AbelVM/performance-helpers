# PowerPool

A small, dependency-free worker pool that wraps underlying Worker instances. It encodes plain object messages to transferable `Uint8Array` for efficient transfer, decodes incoming binary messages back to objects, and provides queuing / grow / reaper behavior.

## Constructor

| option                                                  |                                                type |                                        default | description                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------: | ---------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workerSource`                                          |                                `Function \| string` |                                              — | Either a Worker factory/constructor (callable) or a relative path string passed to `new Worker(new URL(path, import.meta.url))`.                                                                                                                                                                                                   |
| `options.size`                                          |                                            `number` | `min(navigator.hardwareConcurrency \|\| 2, 2)` | Initial number of workers to spawn.                                                                                                                                                                                                                                                                                                |
| `options.minSize`                                       |                                            `number` |                                            `1` | Minimum workers to keep alive.                                                                                                                                                                                                                                                                                                     |
| `options.maxSize`                                       |                                            `number` |                `Math.max(size, hwConcurrency)` | Maximum workers allowed in the pool.                                                                                                                                                                                                                                                                                               |
| `options.workerOptions`                                 |                                            `Object` |                                           `{}` | Options forwarded to the Worker constructor when using a string `workerSource`.                                                                                                                                                                                                                                                    |
| `options.maxTasksPerWorker`                             |                                            `number` |                                     `Infinity` | Soft capacity per worker before it is considered busy.                                                                                                                                                                                                                                                                             |
| `options.idleTimeout`                                   |                                            `number` |                                        `60000` | Milliseconds after which idle workers (beyond `minSize`) are terminated.                                                                                                                                                                                                                                                           |
| `options.messageCodec`                                  |                              `'framed' \| 'legacy'` |                                     `'framed'` | Wire protocol for object messages. `'framed'` posts a `PowerMessageCodec` envelope; `'legacy'` restores the 1.x bare-JSON body. See [Migrating to the framed protocol](#migrating-to-the-framed-protocol-breaking-change-in-20).                                                                                                   |
| `options.taskQueue`                                     |                                           `boolean` |                                         `true` | Whether to queue tasks when pool is saturated.                                                                                                                                                                                                                                                                                     |
| `options.queuePolicy`                                   | `'enqueue'\|'drop-oldest'\|'drop-newest'\|'reject'` |                                      `enqueue` | Policy to apply when the pool is saturated and the queue would otherwise grow. See the queue policy section below.                                                                                                                                                                                                                 |
| `options.maxQueueLength`                                 |                                            `number` |                                      `Infinity` | **Hard cap on queued tasks.** With the default `'enqueue'` policy and no cap, a saturated pool grows its queue until the process runs out of memory — the failure mode this option exists to make observable. Set a finite cap and see [Bounding the queue](#bounding-the-queue). |
| `options.maxDrainWaiters`                                |                                            `number` |                                          `100` | Maximum number of `drain()` calls that may be *waiting* at once. Beyond it, `drain()` rejects with `ERR_POOL_DRAIN_TOO_MANY_WAITERS` instead of accumulating an unbounded number of `idle` listeners. |
| `options.lazy`                                          |                                           `boolean` |                                         `true` | When `true` defer creating workers up to `size` until demand; only `minSize` workers are created at construction. Use this for low-load deployments to avoid unnecessary worker startup cost.                                                                                                                                      |
| `options.listenerMaxListeners` / `options.maxListeners` |                                            `number` |                                `0` (unlimited) | Maximum listeners per internal pool event (see notes). `0` means unlimited. If set to a positive number the pool will throw when registering additional listeners beyond that limit.                                                                                                                                               |
| `options.weakListeners`                                 |                                           `boolean` |                                        `false` | When `true` the pool stores listeners as weak references (when supported by the runtime). This avoids retaining large closures but requires `FinalizationRegistry`/`WeakRef` support; you can call `pool._bus.cleanup()` to force cleanup of dead weak refs in environments without deterministic GC (primarily useful for tests). |
| `options.autoScale`                                     |                                 `boolean \| Object` |                                        `false` | When provided (or `true`), enables autoscaling. Supply `true` to use defaults, or an object to tune behavior. See the **Autoscaling** section below for properties and tuning recommendations.                                                                                                                                     |

## API

- `postMessage(message, transfer, options)` — Dispatch a single message to the pool. Returns `true` when dispatched/queued successfully, or when `options.awaitResponse` (or `options.correlationId`) is present returns a `Promise` that resolves with the worker response. When sending plain objects the pool encodes them into a transferable `Uint8Array` automatically, wrapped in a [`PowerMessageCodec`](powerMessageCodec.md) envelope. **See [Migrating to the framed protocol](#migrating-to-the-framed-protocol) — this changed in 2.0 and requires a one-line edit in every worker.**

  - Pass `options.workerId` to route the message to a specific worker id; targeting a missing or saturated worker will fail (returns `false` or a rejected Promise).
  - When `options.taskQueue` is enabled, `options.queuePolicy` controls overload behavior:
    - `'enqueue'` (default) queues all overflow tasks — **without a `maxQueueLength` cap, without bound.**
    - `'drop-oldest'` drops the oldest queued task when new work arrives.
    - `'drop-newest'` drops the newest incoming task when there is already queued backlog.
    - `'reject'` rejects new overflow tasks immediately instead of queueing.

    - A refused task returns `false`, or — when the caller passed `awaitResponse` or an explicit `correlationId` — rejects with `code === 'ERR_POOL_QUEUE_FULL'`. See [Bounding the queue](#bounding-the-queue).
    - Note: `options.awaitResponse` requires the outgoing `message` to be a plain-object (not a TypedArray/ArrayBuffer). The implementation augments the object with a `correlationId` and will throw if a non-plain-object is supplied when `awaitResponse` is requested.
    - `options.workerId` may be a `number` or `string` (the pool coerces ids to strings internally for correlation handling).

- `broadcast(message, transfer)` — Send `message` to every worker in the pool. Each worker receives either the provided transferable or an independently encoded `Uint8Array` when `transfer` is omitted and a plain object is provided. Broadcasting increments each worker's `tasks` counter.

- `postMessageBatch(items, options)` — Enqueue or dispatch a batch of messages in a single call. `items` is an array of `{ message, transfer? }`. Returns an array of per-item results (booleans or Promises when `awaitResponse` is requested). Use this to amortize queue push overhead for many items.

  - When `options.awaitResponse` is enabled, each batch item is handled through the same internal `postMessage()` path as a single-item request. That means the batch preserves correlation behavior and returns Promises for response-waiting entries.
  - For stable per-item identity in response mode, pass `options.correlationIdFactory(index, item)` to generate a unique `correlationId` for each batch entry.
  - **The factory is resolved once, up front, and validated before anything is dispatched.** If it returns a duplicate id — within this batch, or one that is already in flight from an earlier call — the whole `postMessageBatch` throws `code === 'ERR_POOL_DUPLICATE_CORRELATION_ID'` and **nothing is sent**. This is deliberately stronger than the alternative: dispatching item-by-item would leave the first caller holding a promise that the second registration already rejected, with two messages already on the wire. The error names the duplicated id and its item index. Because the ids are resolved once, the factory is called exactly `items.length` times even if it is impure.
  - A fixed `options.correlationId` may only be used when the batch contains a single item. For multiple items the API throws because the pool cannot safely reuse one identifier for many pending responses.
  - Specifying `options.workerId` targets the batch to a single worker. Targeted batch dispatch is fail-fast: a missing or busy worker will not queue the batch item, and the corresponding return value is `false`.
  - When `options.taskQueue` is enabled, `options.queuePolicy` also applies to batch enqueue behavior in the fire-and-forget path.
  - The return array always matches `items.length`.

- `prepareBuffer(obj, { clone = true })` — Prepare a single transferable `Uint8Array` for `obj`. When `clone` is `true` returns a clone safe to transfer; when `clone` is `false` returns a cached internal buffer that must not be transferred. Useful to pre-encode hot payloads.

- `prepareBuffers(items, { clone = true })` — Prepare an array of normalized `{ message, transfer }` entries for use with `postMessageBatch`. Each returned entry is ready to be dispatched or queued and avoids per-item encoding overhead at send time.

- `stopThePressBatch(items, options)` — Atomically clear the queue, terminate (and optionally recreate) inflight workers, reject pending awaitResponse promises, then forward the provided batch. Returns per-item results like `postMessageBatch`. Useful for emergency replacement of queued work with a new batch.

- `stopThePress(message, transfer, options)` — Clear the internal queue, terminate running workers (rejecting pending response Promises), and send the provided `message` through the same dispatch semantics as `postMessage`. By default the pool will recreate replacement workers; pass `options.recreateWorkers = false` to keep the pool reduced.

- `pauseQueue()` / `resumeQueue()` — Temporarily pause and resume dispatching tasks from the internal queue. Use `pauseQueue()` when downstream consumers are overloaded or a transient outage occurs; queued tasks are retained and resumed later.
- `pause()` / `resume()` — Ergonomic aliases for `pauseQueue()` and `resumeQueue()`, respectively.

- `queuePaused` — Read-only boolean property indicating whether queued dispatch is currently paused.

- `addWorker()` / `removeWorker()` — Programmatically create or terminate a single worker from the pool.

- Event APIs: `addEventListener(type, cb)` / `removeEventListener(type, cb)` — Manage listeners for `'message'`, `'error'`, `'messageerror'`, and `'idle'`. `idle` listeners are invoked immediately if the pool is currently idle.

- `terminate()` — Immediately terminate all workers, clear queues, and stop the reaper interval.

- Disposal hooks: `[Symbol.dispose]()` calls `terminate()` synchronously; `[Symbol.asyncDispose]()` awaits `drain()` then terminates.

- `getStats()` — Return a snapshot `{ status: Array<{id,tasks,lastActive}>, performance: Object }` with per-worker status and aggregated performance metrics (EWMA/time-per-task stats). This is useful for logging and autoscale decisions.
- `drain({ signal, timeout })` — Resolves with the pool's stats once the queue is empty and no task is in flight. The wait is bounded three ways, and **every one of them abandons the wait, never the work**: the pool keeps dispatching and keeps serving every other caller, because someone who stopped watching a drain does not get to stop the work.

  - `signal` — an `AbortSignal` rejects with its reason. An `AbortError` unless you aborted with your own `Error`. An already-aborted signal rejects without waiting.
  - `timeout` — rejects with `code === 'ERR_POOL_DRAIN_TIMEOUT'` after `timeout` ms. Without it, a drain against a wedged worker waits forever, which is indistinguishable from a hang.
  - `maxDrainWaiters` (constructor option) — rejects with `code === 'ERR_POOL_DRAIN_TOO_MANY_WAITERS'` once that many are already waiting. Each waiting drain holds an `idle` listener, so a caller that drains in a loop would otherwise accumulate one per call.

  Whatever ends the wait, the `idle` listener is detached and the waiter slot released — there is no path that leaves either behind.

### Await-response and targeted worker semantics

When `options.awaitResponse` is requested, the pool tracks the outgoing request with a generated or provided `correlationId`. Generated ids look like `k3f9qz-1a2b` — a process-unique base-36 tag, a dash, and a process-monotonic base-36 sequence. They are unique across every pool in the process, so a shared log or a shared worker cannot confuse two pools' ids, and they carry no timestamp, so they do not leak anything about when a message was sent. **Do not parse them** — pass `options.correlationId` or `options.correlationIdFactory` if you need a shape you control. The returned Promise resolves only when a worker replies with a matching response payload. If the response never arrives, the Promise rejects when the optional `timeout` expires, and the internal pending entry is removed.

When `options.workerId` is supplied, the pool routes the message to that worker only. Targeting a missing or currently saturated worker fails immediately rather than silently queuing the request. For `awaitResponse` callers this means the returned Promise rejects with an immediate failure instead of waiting in the queue.

If a worker is terminated while it still has pending `awaitResponse` requests, the pool rejects those Promises and removes the associated pending state. This ensures there are no leaked Promise entries after worker teardown or pool shutdown.

## Bounding the queue

`options.queuePolicy` decides what happens when the pool is saturated; `options.maxQueueLength` decides *whether that situation can keep going*. They are different questions, and the defaults answer the second one with "forever".

With the default `queuePolicy: 'enqueue'` and no cap, a pool whose workers are slower than its producers accumulates queued tasks without limit. There is no error, no event, and no threshold that stops it — the failure is the process running out of memory, which by then is a long way from the cause. If your producers are not rate-limited against your consumers, set a cap:

```js
const pool = new PowerPool(ImageWorker, {
  minSize: 2,
  maxSize: 8,
  taskQueue: true,
  queuePolicy: 'enqueue',
  maxQueueLength: 500, // refuse the 501st task rather than growing until OOM
});
```

**Which task gets refused.** With a finite cap, the *incoming* task is the one that does not fit. A bound the caller asked for is a statement about the newest arrival, and refusing it keeps the work already accepted — with one deliberate exception:

- `'drop-oldest'` keeps its documented meaning and evicts the oldest to make room for the newest, so the queue holds a steady number and the newest work is the work that runs. Note this policy was already self-bounding before `maxQueueLength` existed: it evicts one and admits one, so the cap never turns it into a refusal.
- `'drop-newest'` and `'reject'` refuse the incoming task, exactly as they already did.

**What refusal looks like.** A refused task returns `false` from `postMessage` / the corresponding slot in a `postMessageBatch` result array. If the caller passed `awaitResponse` or an explicit `correlationId`, the returned Promise rejects with `code === 'ERR_POOL_QUEUE_FULL'` instead, so you can tell "the queue was full" from "the worker failed":

```js
try {
  const result = await pool.postMessage(payload, undefined, { awaitResponse: true });
} catch (err) {
  if (err.code === 'ERR_POOL_QUEUE_FULL') {
    // shed load: 429, drop the request, or back off
  }
  throw err;
}
```

A batch is capped as a group: if 8 of 10 items do not fit, the first 2 are queued and the remaining 8 slots in the result array are `false`. The pool does not queue what fits and then silently drop the rest.

If you would rather be **told** about pressure without refusing anything, set `options.queueHighThreshold` instead. It emits `pool:queue:high` on the first crossing (and not again until the queue drains back below it) and changes nothing else — see [Events and handlers](#events-and-handlers). The two compose: use the threshold for alerting, the cap for safety.

## Autoscaling

`PowerPool` supports an optional autoscaling mode that grows or shrinks the worker pool based on recent observed task latency (EWMA) and queue pressure. Enable it by passing `options.autoScale` to the constructor.

When `autoScale` is a boolean `true` the pool uses sensible defaults. For production workloads pass an object to tune behavior:

```js
const pool = new PowerPool(WorkerScript, {
  minSize: 1,
  maxSize: 16,
  autoScale: {
    intervalMs: 1000, // evaluation interval (ms)
    targetMs: 50, // target per-task latency (ms)
    alpha: 0.2, // EWMA smoothing factor (0..1)
    cooldownMs: 5000, // minimum time between scale actions (ms)
    hysteresis: 0.2, // fractional hysteresis (0..1) to avoid flapping
  },
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

See [autoscale guide](autoscale.md) for more details and examples.

### Adaptive concurrency policies

The default controller above is a **latency-threshold heuristic**: it compares one EWMA against a fixed `targetMs`. That is a reasonable first cut, but it is a guess about the right fleet size rather than a measurement of it.

`autoScale.policy` swaps in a real feedback loop — a concurrency controller that treats the worker count as a congestion window. The pool already tracks every signal these need, so nothing new has to be instrumented:

| policy        | behaviour                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'ewma'`      | _(default, unchanged)_ the `targetMs` heuristic above. Reports `concurrencyLimit: null`.                                                                                             |
| `'aimd'`      | Additive increase while healthy, multiplicative decrease (`aimdBeta`, default `0.7`) on a congestion signal. Simplest and most robust.                                               |
| `'vegas'`     | Estimates the bottleneck queue as `limit * (1 - minRtt / currentRtt)` and moves by `alpha`/`beta` (`3*log10(limit)` / `6*log10(limit)`), as in the reference implementation.         |
| `'gradient2'` | `gradient = clamp(longRtt / currentRtt, 0.5, 1)`, then `limit = gradient * limit + queueSize`. Unlike Vegas it does not use the window _minimum_ latency, which biases the estimate. |

```js
const pool = new PowerPool(WorkerScript, {
  minSize: 1,
  maxSize: 16,
  autoScale: {
    policy: 'gradient2',
    limitMin: 1,
    limitMax: 16,
    longWindowAlpha: 0.05,
  },
});
```

Extra options: `policy` (`'ewma'|'aimd'|'vegas'|'gradient2'`), `limitMin`, `limitMax`, `longWindowAlpha` (smoothing for the long-window RTT EWMA, default `0.05`), `aimdBeta`.

Observability — `getStats().performance` gains:

- `concurrencyLimit` — the controller's current limit, or `null` for the `ewma` policy.
- `autoScalePolicy` — the active policy name, or `null` when autoscaling is off.
- `congestion` — whether the controller currently believes it is over-provisioned.

Notes:

- `'aimd'` and `'vegas'` only move the limit once there is at least one latency sample. A pool that has never completed a task holds its seed value rather than guessing.
- Vegas's `alpha`/`beta` scale with `log10(limit)`, so at small limits the queue estimate lands in a neutral band and the limit holds steady. It needs a limit above roughly 3 before it will step down. That is the algorithm's behaviour, not a stall.
- `'gradient2'` has no queue-pressure term to grow from, so an idle pool with an empty queue correctly holds its limit steady. Depth is what drives it up.
- The limit is a **float**, smoothed by 0.2 each tick so a single noisy sample cannot swing the fleet. `getStats()` rounds it to two decimals.
- This is a separate signal from the worker add/remove step, which still runs the existing `cooldown`/`backoff` logic. The controller steers; the existing machinery applies.

## Events and handlers

`onmessage`, `onerror`, `onidle` — setter/getter properties for convenient handlers. `onidle` and `'idle'` listeners receive an event with `data.type === 'pool:idle'` and two separate payloads:

- `data.workers` — the per-worker snapshot: an array of `{ id, tasks, lastActive }`. This is the pool's account of *which* workers it believes are idle. A worker with `tasks !== 0` here means the pool's active-task accounting has drifted from the per-worker counts, so this is the field to log when investigating a drain that never settles.
- `data.stats` — the aggregate `getStats()` summary: `{ status, performance, queueLength, activeTasks, workerCount, ... }`.

Both are computed lazily, so an idle transition costs nothing when no listener reads them. They used to be one field called `stats` that the documentation described as an array while the code produced a summary — the split names each for what it actually is, and `stats` keeps its key so existing listeners are unaffected.

`pool:queue:high` — emitted on the internal event bus when the internal task queue length crosses the configured `options.queueHighThreshold`. Payload: `{ length, threshold }`. Configure `queueHighThreshold` in constructor options to enable this event. This is a **notification, not a limit** — nothing is refused when the threshold is crossed. Use `options.maxQueueLength` to actually bound the queue.

`pool:scale` — emitted when workers are added or removed. Payloads vary by origin: when workers are created the payload is `{ action: 'add', id, minSize, maxSize }`; when workers are terminated the payload contains `{ action: 'remove', terminated: [ids], count }`. The existing `resize` event is still emitted for API compatibility.

## Example

## Realistic Example — image thumbnail worker

This example shows a common pattern: a pool of workers that produce thumbnail images from large binary blobs. The pool dispatches work, awaits per-task responses, and drains before graceful shutdown.

```javascript
import ImageWorker from './image-worker.js?worker';
import { PowerPool } from '../src/helpers/powerPool.js';

// Create a small pool tuned for CPU-bound thumbnailing
const pool = new PowerPool(ImageWorker, { size: 2, maxSize: 4, idleTimeout: 30_000 });
// For low-load deployments avoid eager worker startup:
// (example alternative: lazy startup omitted for brevity)

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

- If a worker is terminated while it still has pending `awaitResponse` requests, the pool rejects those Promises immediately and removes the associated pending state. This avoids leaked promise bookkeeping during worker teardown or replacement.

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

const responseBatch = pool.postMessageBatch(batch, {
  awaitResponse: true,
  correlationIdFactory: (index, item) => `job-${item.message.a}-${index}`,
});
const responses = await Promise.all(responseBatch);
responses.forEach((resp, index) => {
  console.log('job', index, 'correlationId', resp.correlationId);
});
// results: [ true, true ] — dispatched or queued

// Await per-item responses (each entry returns a Promise)
const r = pool.postMessageBatch([{ message: { req: 'a' } }, { message: { req: 'b' } }], {
  awaitResponse: true,
  timeout: 5000,
});
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

## Migrating to the framed protocol (breaking change in 2.0)

### What changed

In 1.x, `PowerPool` encoded a plain object to a **bare `Uint8Array` of JSON** with no
header, and decided what it received on the way back by _sniffing_ — "if this looks like an
`ArrayBuffer`, `JSON.parse` it". That had three problems: the wire format had no version, so it
could never evolve; a genuinely binary worker message was silently corrupted by `JSON.parse`; and
every worker had to hand-decode the bytes.

From 2.0 the pool sends a [`PowerMessageCodec`](powerMessageCodec.md) frame instead:

```
byte  0      protocol version
byte  1      codec id
bytes 2..5   payload length (uint32 little-endian)
bytes 6..    payload
```

### How to migrate a worker

One line changes, in the worker's message handler.

```js
// 1.x — bare JSON bytes
import { u82o } from 'performance-helpers';
self.onmessage = (e) => handle(u82o(e.data));

// 2.0 — framed
import { decodeMessage } from 'performance-helpers';
self.onmessage = (e) => handle(decodeMessage(e.data).value);
```

`decodeMessage` also accepts a raw `ArrayBuffer` or `DataView`, so a worker that receives a plain
binary `ArrayBuffer` you posted yourself (not a frame) should branch:

```js
const isFrame = e.data instanceof Uint8Array && e.data.length >= 6 && e.data[0] === 1;
const data = isFrame ? decodeMessage(e.data).value : e.data;
```

A robust worker that must interoperate with both can simply try the frame and fall back, which is
what `PowerChunker`'s inline worker does internally:

```js
let data;
try {
  data = decodeMessage(e.data).value;
} catch {
  data = u82o(e.data); // 1.x peer
}
```

> **Your worker must also _reply_ in the shape it received.** This trips people up. A
> `messageCodec: 'legacy'` pool sniffs its _replies_ with `u82o`, so a framed reply is
> unreadable to it and a pending `awaitResponse` promise will simply never settle. Track
> which shape arrived and mirror it:
>
> ```js
> let framed = true;
> let data;
> try {
>   data = decodeMessage(e.data).value;
> } catch {
>   framed = false;
>   data = u82o(e.data);
> }
>
> const body = { correlationId: data.correlationId, result: run(data) };
> self.postMessage(framed ? encodeMessage(body) : o2u8(body));
> ```

### What you get in exchange

- **Binary survives.** A `Uint8Array`/`ArrayBuffer` task is framed under the `raw` codec and arrives
  intact instead of being `JSON.parse`d into nonsense. A binary message passed **without** a
  `transfer` list is framed like anything else, so a worker always sees one protocol regardless of
  what it was handed. If you supply your own `transfer` list the pool leaves your buffer completely
  alone — that is the documented "I am sending this exact buffer, already in the form I want" case,
  and it is how you post a pre-framed shared buffer.
- **A version byte.** The protocol can change again without another flag day — `decodeMessage`
  throws on an unknown version rather than mis-parsing.
- **Self-delimiting frames.** `decodeMessage` reports `byteLength`, so one receive can carry
  several messages.

### Escape hatch

Pass `messageCodec: 'legacy'` to restore the 1.x wire format, on a per-pool basis. This is intended
to let a worker be migrated on its own schedule, not as a permanent setting.

```js
const pool = new PowerPool(WorkerScript, { messageCodec: 'legacy' });
```

| `messageCodec`         | Outbound                     | Inbound                       |
| ---------------------- | ---------------------------- | ----------------------------- |
| `'framed'` _(default)_ | `PowerMessageCodec` envelope | `decodeMessage` — no sniffing |
| `'legacy'`             | bare `Uint8Array` of JSON    | `u82o` — sniffed              |

### Sending a pre-encoded buffer

If you pre-encode to share one buffer across many workers, frame it once and reuse the frame.
Do **not** use `o2u8` on its own any more: an unframed body will fail to decode under the default
protocol.

```js
import { encodeMessage } from 'performance-helpers';

const shared = encodeMessage({ big: 'payload', repeated: true });
const batch = Array.from({ length: 100 }, () => ({ message: shared, transfer: [shared.buffer] }));
pool.postMessageBatch(batch);
```

## Recommendations

- Use `PowerPool` when you need a small, managed pool of Workers with automatic queuing and idle termination.
- Prefer sending plain objects — `PowerPool` encodes them into a framed, transferable `Uint8Array` to avoid structured-clone copies. For broadcasts, each worker receives an independently encoded transferable buffer when no transfer list is provided.
- Register `error` / `messageerror` listeners to handle and log underlying Worker problems; the pool forwards these events to registered listeners.
  Note: Node's `worker_threads` does not emit `messageerror` natively. `PowerPool` normalizes cross-platform behavior: when binary decoding fails the pool will emit a `messageerror` event on the pool-level bus so listeners receive the event even if the underlying worker implementation lacks native `messageerror` support. The pool also still forwards the raw binary payload to `onmessage` so existing consumers receive the data.
- Tune `size`, `maxSize`, `idleTimeout` and `maxTasksPerWorker` for your workload. When using many short tasks, a small pool with aggressive queuing often performs best.

## Complexity & Performance Tips

- **Amortized cost:** `postMessage` and `broadcast` will try direct dispatch first and then queue. Use `postMessageBatch` to amortize per-item overhead when enqueuing many tasks.
- **Encoding & transfers:** When `transfer` is omitted and you supply a plain object, `PowerPool` encodes the object to a framed, transferable `Uint8Array`. This avoids structured-clone copies but does allocate a buffer per encoded item. If you share the same large payload across many workers, `encodeMessage` it once and pass the frame in `transfer` to avoid repeated encoding.
- **Batched enqueue:** `postMessageBatch` prepares each item once and uses `PowerQueue.pushMany` to enqueue remaining items in one operation, reducing O(n) push overhead.
- **Awaiting responses:** `options.awaitResponse` introduces per-item Promise bookkeeping and correlation ids; for very large batches prefer fire-and-forget and implement separate result aggregation inside workers if possible.
- **Tuning concurrency:** `maxTasksPerWorker` controls soft saturation per worker. Raising it increases parallelism per worker but can make latency variance higher; use `getStats()` and EWMA metrics to tune the smoothing and thresholds.
- **stopThePress usage:** `stopThePress` and `stopThePressBatch` terminate inflight work and reject pending responses. By default they recreate replacement workers; pass `options.recreateWorkers = false` to skip recreation when you prefer to keep the pool reduced.

## PowerPool Examples — Advanced

```javascript
// Efficient batch with pre-encoded transferable buffer (avoid per-item encoding)
const shared = encodeMessage({ big: 'payload', repeated: true });
const batch = Array.from({ length: 100 }, () => ({ message: shared, transfer: [shared.buffer] }));
// All workers will receive the same transferable buffer (caller responsible for reuse semantics).
pool.postMessageBatch(batch);

// Use stopThePress to cancel queued work and replace with urgent tasks
pool.stopThePress({ command: 'flush-and-run' }, null, { recreateWorkers: true });

// Await responses for a small batch (per-item Promises)
const r = pool.postMessageBatch([{ message: { req: 'a' } }, { message: { req: 'b' } }], {
  awaitResponse: true,
  timeout: 5000,
});
const responses = await Promise.all(r.map((p) => (p instanceof Promise ? p : Promise.resolve(p))));
console.log('batch responses', responses);
```
