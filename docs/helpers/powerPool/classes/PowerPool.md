[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PowerPool

# Class: PowerPool

PowerPool

Manager for a pool of worker-like objects providing task dispatch, queuing,
autoscaling, and lifecycle management. See constructor docs for options.

 PowerPool

## Constructors

### Constructor

> **new PowerPool**(`workerSource`, `options`, ...`args?`): `PowerPool`

Create a PowerPool.

#### Parameters

##### workerSource

`string` \| `Function`

A Worker constructor, a worker factory, or a relative path string. If the provided function is not constructable, it is invoked directly; if a string path is provided, the pool attempts to resolve it via `new URL(path, import.meta.url)` before falling back to a plain `Worker(path)`.

##### options

`PowerPoolOptions` \| `undefined`

`PowerPoolOptions`

***

`undefined`

##### args?

...`any`[] = `{}`

#### Returns

`PowerPool`

## Properties

### \_activeTasks

> **\_activeTasks**: `number`

number of currently active (dispatched) tasks across all workers

***

### \_adaptiveLimit

> **\_adaptiveLimit**: `number` \| `undefined`

***

### \_autoScale

> **\_autoScale**: \{ `aimdBeta`: `number`; `alpha`: `number`; `backoffFactor`: `number`; `backoffMaxMultiplier`: `number`; `backoffResetMs`: `number`; `cooldownMs`: `number`; `enabled`: `boolean`; `hysteresis`: `number`; `intervalMs`: `number`; `limitMax`: `number`; `limitMin`: `number`; `longWindowAlpha`: `number`; `policy`: `"ewma"` \| `"aimd"` \| `"vegas"` \| `"gradient2"` \| `undefined`; `stepDown`: `number`; `stepUp`: `number`; `targetMs`: `number`; \} \| `null`

***

### \_autoScaleBackoffMultiplier

> **\_autoScaleBackoffMultiplier**: `number` \| `undefined`

***

### \_autoScaleInterval

> **\_autoScaleInterval**: `any`

***

### \_autoscaleServo

> **\_autoscaleServo**: [`PowerServo`](../../powerServo/classes/PowerServo.md) \| `null` \| `undefined`

***

### \_bus

> **\_bus**: [`PowerEventBus`](../../powerEventBus/classes/PowerEventBus.md)

***

### \_congestion

> **\_congestion**: `boolean` \| `undefined`

***

### \_createdAt

> **\_createdAt**: `number`

***

### \_defaultAwaitResponseTimeout

> **\_defaultAwaitResponseTimeout**: `number`

***

### \_drainWaiters

> **\_drainWaiters**: `number`

Number of `drain()` calls currently *waiting* for idle. Each one holds an
`idle` listener, so this is the bound that keeps a caller draining in a
loop from accumulating listeners without limit. See
`DEFAULT_MAX_DRAIN_WAITERS`.

***

### \_encodeCache

> **\_encodeCache**: `Map`\<`any`, `any`\>

***

### \_encodeCacheByteLimit

> **\_encodeCacheByteLimit**: `number`

***

### \_encodeCacheBytes

> **\_encodeCacheBytes**: `number`

***

### \_encodeCacheLimit

> **\_encodeCacheLimit**: `number`

***

### \_ewmaLatency

> **\_ewmaLatency**: `any`

***

### \_idempotency

> **\_idempotency**: `Map`\<`any`, `any`\> \| `null`

***

### \_idempotencyDuplicatesInFlight

> **\_idempotencyDuplicatesInFlight**: `number`

***

### \_idempotencyDuplicatesSettled

> **\_idempotencyDuplicatesSettled**: `number`

***

### \_idempotencyExpired

> **\_idempotencyExpired**: `number`

***

### \_idempotencyLookups

> **\_idempotencyLookups**: `number`

***

### \_idempotencySize

> **\_idempotencySize**: `number`

***

### \_idempotencyTtlMs

> **\_idempotencyTtlMs**: `number`

***

### \_isIdle

> **\_isIdle**: `boolean`

whether the pool is considered idle (no active tasks and empty queue)

***

### \_lastAdaptiveLimit

> **\_lastAdaptiveLimit**: `number` \| `undefined`

***

### \_lastAutoScaleAt

> **\_lastAutoScaleAt**: `number`

***

### \_logger

> **\_logger**: [`PowerLogger`](../../powerLogger/classes/PowerLogger.md)

***

### \_longEwmaLatency

> **\_longEwmaLatency**: `any`

***

### \_maxDrainWaiters

> **\_maxDrainWaiters**: `number`

***

### \_maxQueueLength

> **\_maxQueueLength**: `number`

***

### \_maxTasksPerWorker

> **\_maxTasksPerWorker**: `number`

***

### \_messageCodec

> **\_messageCodec**: `"framed"` \| `"legacy"` \| `"negotiated"`

Wire protocol for object messages.

- `'framed'` (**default since 2.0**) posts a `PowerMessageCodec`
  envelope: `[version][codec][length][payload]`. Workers read
  `decodeMessage(e.data).value` instead of `u82o(e.data)`, binary frames
  survive intact, and the version byte lets the protocol evolve without
  another flag day.
- `'legacy'` restores the 1.x behaviour: a bare `Uint8Array` of JSON,
  sniffed on the way back in. Provided so a worker can be migrated on its
  own schedule. See the migration note in guides/powerPool.md.
- `'negotiated'` starts out identical to `'framed'` and upgrades **per
  worker**: a worker that advertises the native carrier with
  `announceCapabilities()` is sent the structured-clone carrier instead,
  which preserves `Map`, `Set`, `Date`, `BigInt` and cycles that the JSON
  frame silently destroys. Workers that do not advertise keep getting the
  frame, so a pool can be switched on before any worker is ready.

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_minLatencyWindow

> **\_minLatencyWindow**: `number` \| `undefined`

***

### \_nativeCloneAvailable

> **\_nativeCloneAvailable**: `boolean`

Whether this runtime can structured-clone at all. Checked once here so
`'negotiated'` on a runtime without `structuredClone` degrades to the
framed path rather than throwing per message.

***

### \_nextIndex

> **\_nextIndex**: `number`

***

### \_nextWorkerId

> **\_nextWorkerId**: `number`

***

### \_onerror

> **\_onerror**: `Function` \| `null`

***

### \_onidle

> **\_onidle**: `Function` \| `null`

***

### \_onmessage

> **\_onmessage**: `Function` \| `null`

***

### \_onresize

> **\_onresize**: `Function` \| `null`

***

### \_pendingResponses

> **\_pendingResponses**: `Map`\<`any`, `any`\>

***

### \_postFailures

> **\_postFailures**: `number`

***

### \_queueHighCrossed

> **\_queueHighCrossed**: `boolean`

***

### \_queueHighThreshold

> **\_queueHighThreshold**: `number`

***

### \_queuePaused

> **\_queuePaused**: `boolean`

whether queued dispatch is paused

***

### \_queuePolicy

> **\_queuePolicy**: `"enqueue"` \| `"drop-oldest"` \| `"drop-newest"` \| `"reject"`

***

### \_reaperInterval

> **\_reaperInterval**: `any`

***

### \_slowTaskCount

> **\_slowTaskCount**: `number`

***

### \_slowTaskThreshold

> **\_slowTaskThreshold**: `number`

***

### \_taskDurationsMax

> **\_taskDurationsMax**: `number`

***

### \_taskDurationsMin

> **\_taskDurationsMin**: `number`

***

### \_taskDurationsWelfordCount

> **\_taskDurationsWelfordCount**: `number`

***

### \_taskDurationsWelfordM2

> **\_taskDurationsWelfordM2**: `number`

***

### \_taskDurationsWelfordMean

> **\_taskDurationsWelfordMean**: `number`

***

### \_terminated

> **\_terminated**: `boolean`

Terminal flag. Set by `shutdown()` / `terminate()`; once true the pool
refuses to dispatch, enqueue or grow, so a late `postMessage()` cannot
resurrect it (which previously created a worker with no reaper
interval, pinning the Node.js process).

***

### \_terminatedWorkerTaskCountsCount

> **\_terminatedWorkerTaskCountsCount**: `number`

***

### \_terminatedWorkerTaskCountsTotal

> **\_terminatedWorkerTaskCountsTotal**: `number`

***

### \_totalTasksCompleted

> **\_totalTasksCompleted**: `number`

***

### \_totalWorkersCreated

> **\_totalWorkersCreated**: `number`

***

### \_underlyingToWorkerObj

> **\_underlyingToWorkerObj**: `Map`\<`any`, `any`\>

***

### \_workerOptions

> **\_workerOptions**: `Object`

***

### \_workerSource

> **\_workerSource**: `string` \| `Function`

***

### idleTimeout

> **idleTimeout**: `number`

***

### maxSize

> **maxSize**: `number`

***

### minSize

> **minSize**: `number`

***

### queue

> **queue**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

***

### taskQueueEnabled

> **taskQueueEnabled**: `boolean`

***

### workers

> **workers**: `WorkerObj`[]

## Accessors

### onerror

#### Get Signature

> **get** **onerror**(): `Function` \| `null`

onerror handler called when a worker emits an error.

##### Returns

`Function` \| `null`

#### Set Signature

> **set** **onerror**(`cb`): `void`

##### Parameters

###### cb

`Function` \| `null`

##### Returns

`void`

***

### onidle

#### Get Signature

> **get** **onidle**(): `Function` \| `null`

onidle handler called when the pool becomes idle.

##### Returns

`Function` \| `null`

#### Set Signature

> **set** **onidle**(`cb`): `void`

##### Parameters

###### cb

`Function` \| `null`

##### Returns

`void`

***

### onmessage

#### Get Signature

> **get** **onmessage**(): `Function` \| `null`

onmessage handler called when any worker posts a message.

##### Returns

`Function` \| `null`

#### Set Signature

> **set** **onmessage**(`cb`): `void`

##### Parameters

###### cb

`Function` \| `null`

##### Returns

`void`

***

### onresize

#### Get Signature

> **get** **onresize**(): `Function` \| `null`

onresize handler called when the pool is resized and workers are terminated/added.
Receives an event object: `{ data: { type: 'pool:resize', terminated: Array<number>, added: number, minSize, maxSize } }`

##### Returns

`Function` \| `null`

#### Set Signature

> **set** **onresize**(`cb`): `void`

##### Parameters

###### cb

`Function` \| `null`

##### Returns

`void`

***

### queuePaused

#### Get Signature

> **get** **queuePaused**(): `boolean`

Whether queued dispatch is currently paused.

##### Returns

`boolean`

## Methods

### \_autoscaleSteps()

> **\_autoscaleSteps**(`ewma`, `targetMs`, `ceiling`, `dtSeconds`): `number`

How many workers this tick's scale action should move, given how far
latency currently sits from `targetMs`.

**The thresholds in `_autoScaleTick` still decide the direction.** This only
sets the magnitude, inside the caller's existing `stepUp` / `stepDown`
ceiling — which is why nothing changes at the default `stepUp: 1`: a ceiling
of one worker is one worker, whatever the controller says.

Before this, the step was a fixed count. A pool that was 20 % over target
added as many workers as one that was 300 % over, so the badly-over case
converged no faster than the marginal one. A PI controller on the relative
error scales the step by how far off the setpoint actually is, and its
integral term is what removes the residual: this is a *discrete* stepper, so
proportional action alone leaves a standing offset, which is exactly the
property `PowerServo`'s "converges to a setpoint a fixed gain cannot" test
pins.

Normalised, not absolute: `measured` is `ewma / targetMs` against a setpoint
of `1`, so the gains are dimensionless and do not have to be retuned when
`targetMs` changes. Only `|output|` is used — the sign is already settled by
the hysteresis band and the queue-pressure check.

`PowerServo` owns no timer, so `dt` is passed in; the tick's own
`intervalMs` is the right unit because that is the interval this runs on.

#### Parameters

##### ewma

`number`

Current latency EWMA in ms.

##### targetMs

`number`

Configured target.

##### ceiling

`number`

`stepUp` or `stepDown`; the caller's hard limit.

##### dtSeconds

`number`

Tick interval in seconds, for the integral.

#### Returns

`number`

A worker count in `[1, ceiling]`.

***

### \_createPendingResponsePromise()

> **\_createPendingResponsePromise**(`correlationId`, `options`): `object`

#### Parameters

##### correlationId

`any`

##### options

`any`

#### Returns

`object`

##### correlationKey

> **correlationKey**: `any`

##### pendingPromise

> **pendingPromise**: `Promise`\<`any`\>

***

### \_deleteWorkerUnderlyingMapping()

> **\_deleteWorkerUnderlyingMapping**(`workerObj`): `void`

#### Parameters

##### workerObj

`any`

#### Returns

`void`

***

### \_emitIdle()

> **\_emitIdle**(): `void`

#### Returns

`void`

***

### \_updateAdaptiveLimit()

> **\_updateAdaptiveLimit**(): `number` \| `undefined`

#### Returns

`number` \| `undefined`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook. Drains outstanding work and then terminates.
Use `await pool[Symbol.asyncDispose]()` in environments that support it.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### addEventListener()

> **addEventListener**(`type`, `cb`): `void`

Add an event listener for pool events. Supported types: 'message', 'error', 'messageerror', 'idle'.

#### Parameters

##### type

`"message"` \| `"error"` \| `"messageerror"` \| `"idle"`

##### cb

`Function`

#### Returns

`void`

***

### addWorker()

> **addWorker**(): `WorkerObj`

Add one worker to the pool immediately.

#### Returns

`WorkerObj`

The newly created worker entry.

***

### broadcast()

> **broadcast**(`message`, `transfer`): `void`

Broadcasts a message to all workers in the pool.

#### Parameters

##### message

`any`

##### transfer

`Transferable`[] \| `undefined`

Optional transfer list. If omitted and a
plain JS object is supplied, the pool will attempt to encode the object for
each worker into a transferable `Uint8Array` (via `o2u8`) so each worker
receives an independent transferable buffer to avoid structured-clone copies.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Named alias for the `Symbol.dispose` implementation, so callers who do not
want to reach for the symbol still have something to call.

#### Returns

`void`

***

### drain()

> **drain**(`options?`): `Promise`\<`object`\>

Return a Promise that resolves when the pool becomes idle (queue empty and all workers have tasks === 0).
Resolves with the result of `getStats()` at the time of idle.

The wait is bounded three ways, and every one of them **abandons the wait,
never the work** - the pool keeps dispatching and keeps serving every other
caller. That is the contract `drain()` has always had; what is new is that
the wait can actually be given up on without leaking anything:

- `signal` - an `AbortSignal` rejects with its reason. `AbortError` unless
  the caller aborted with their own `Error`.
- `timeout` - rejects with `ERR_POOL_DRAIN_TIMEOUT` after `timeout` ms.
  Without it a drain against a wedged worker waits forever, which is
  indistinguishable from a hang.
- `maxDrainWaiters` (constructor option) - rejects with
  `ERR_POOL_DRAIN_TOO_MANY_WAITERS` once too many are already waiting.

Previously only `signal` existed, and it leaked: `raceWithAbort` rejected
the returned promise but left the `idle` listener attached, so an aborted
drain retained a closure and a listener slot until the pool happened to go
idle again. This implementation owns the listener lifecycle directly and
detaches on *every* exit path.

#### Parameters

##### options?

###### signal?

`AbortSignal`

Abandons the wait when aborted.

###### timeout?

`number`

Abandons the wait after this many ms.

#### Returns

`Promise`\<`object`\>

Promise resolving to `getStats()`.

***

### getStats()

> **getStats**(): `object`

Return stats for debugging and telemetry.

#### Returns

`object`

##### activeTasks

> **activeTasks**: `number`

##### isIdle

> **isIdle**: `boolean`

##### maxSize

> **maxSize**: `number`

##### minSize

> **minSize**: `number`

##### performance

> **performance**: `Object`

##### queueLength

> **queueLength**: `number`

##### status

> **status**: `object`[]

##### workerCount

> **workerCount**: `number`

***

### pause()

> **pause**(): `void`

Alias for `pauseQueue()` to provide a simpler public API.

#### Returns

`void`

***

### pauseQueue()

> **pauseQueue**(): `void`

Pause dequeueing from the internal task queue.
Queued tasks remain in the queue until `resumeQueue()` is called.
This is useful for controlled backpressure when downstream consumers
are temporarily unable to accept more work.

#### Returns

`void`

***

### postMessage()

> **postMessage**(`message`, `transfer`, `options`): `boolean` \| `Promise`\<`any`\>

Post a message to a worker in the pool.
The pool will try to reuse an idle/least-loaded worker, grow the pool
(up to `maxSize`), or queue the task if configured.

#### Parameters

##### message

`any`

The message to post to a worker.

##### transfer

`Transferable`[] \| `undefined`

Optional transfer list. If omitted and
a plain JS object is supplied, the pool will internally encode the object
to a transferable `Uint8Array` (via `o2u8`) and pass its `ArrayBuffer` as
the transfer list to avoid structured-clone copies.

##### options

`PostMessageOptions` \| `undefined`

Optional flags controlling behavior such as `awaitResponse`, `timeout`, `workerId`, and `zeroCopy`.

#### Returns

`boolean` \| `Promise`\<`any`\>

When `options.awaitResponse` is truthy this returns a `Promise` that resolves with the worker response; otherwise returns `true` when the message was accepted (dispatched or queued) or `false` when it was rejected.

#### Throws

When `options.awaitResponse` is used but the provided `message` is not a plain object.

***

### postMessageBatch()

> **postMessageBatch**(`items`, `options`): (`boolean` \| `Promise`\<`any`\>)[]

Post a batch of messages to the pool.
Each entry is an object: `{ message, transfer? }`.
Returns an array with the same length as `items` where each element is
either a boolean (accepted) or a Promise (when `options.awaitResponse` is used).

#### Parameters

##### items

`object`[]

##### options

`PostMessageOptions` & `object` \| `undefined`

Optional options forwarded to each `postMessage` call.

#### Returns

(`boolean` \| `Promise`\<`any`\>)[]

#### Throws

When `items` is not an array.

***

### prepareBuffers()

> **prepareBuffers**(`items`, `options?`): [`PreparedItem`](../interfaces/PreparedItem.md)[]

Prepare an array of transferable buffers for a batch of items.
Each item may be a plain object, a TypedArray/ArrayBuffer view, or
an object `{ message, transfer? }`. The returned array contains
normalized `{ message, transfer }` entries ready for `postMessageBatch`.
## `clone` defaults to `false`, and the slice it avoided was the expensive part

`clone: true` copied every encoded buffer (`u8.slice()`) so it could be
**transferred** rather than copied by the structured clone. That looked like
the fast path: a transfer is zero-copy, so the copy must be worth avoiding.

It is not, and it is not close. Over a Zipf-ish repeat mix of 200
200-byte messages, comparing one variable at a time:

| path | per message |
|---|---:|
| encode + cache, `slice()`, transfer (the old default) | 2942 ns |
| encode + cache, hand the cached buffer over to be copied | **1557 ns** |
| encode every time, `slice()`, transfer (no cache) | 3441 ns |

The explicit `slice()` costs ~1385 ns — a JS-level `memcpy` of the whole
payload — and the structured-clone copy it was avoiding is a *native* one.
Paying an interpreted copy to dodge a native copy loses, and by enough that
it roughly halves the cost of the message path.

The encode cache is emphatically **not** the problem: dropping it costs
~1900 ns, nearly twice what the slice costs. It stays.

With `clone: false` the cached buffer is handed to `postMessage` and the
runtime copies it, so the cache entry is never detached. The old warning to
"do NOT transfer those buffers if `clone:false`" is now the only rule, and
it is honoured automatically: the transfer list is `undefined` in this mode.

Pass `{ clone: true }` to get a private transferable copy back — the
right choice when the caller wants to keep the payload alive on this side
and hand a detachable buffer to the worker.

#### Parameters

##### items

`any`[]

##### options?

\{ `clone?`: `boolean`; \} \| `undefined`

`clone` defaults to `false`; see above.

#### Returns

[`PreparedItem`](../interfaces/PreparedItem.md)[]

***

### removeEventListener()

> **removeEventListener**(`type`, `cb`): `void`

Remove a previously added event listener.

#### Parameters

##### type

`"message"` \| `"error"` \| `"messageerror"` \| `"idle"`

##### cb

`Function`

#### Returns

`void`

***

### removeWorker()

> **removeWorker**(): `void`

Remove the last worker from the pool and terminate it.

#### Returns

`void`

***

### resize()

> **resize**(`n`): `void`

Resize the pool's maximum size at runtime.
If `n` is smaller than the current number of workers, extra workers
will be terminated (keeps at least `minSize`). If `n` is larger,
the pool may grow up to the new limit when demand increases.

#### Parameters

##### n

`number`

New maximum pool size.

#### Returns

`void`

***

### resume()

> **resume**(): `void`

Alias for `resumeQueue()` to provide a simpler public API.

#### Returns

`void`

***

### resumeQueue()

> **resumeQueue**(): `void`

Resume dequeueing from the internal task queue and attempt to dispatch
waiting tasks to available workers.

#### Returns

`void`

***

### shutdown()

> **shutdown**(): `void`

Shutdown the pool: clear timers, reject pending responses, terminate workers,
and clear internal queues. This is a full stop that prevents background
timers from keeping the process alive.

Shutdown is **final**: the pool refuses every subsequent `postMessage()`,
`postMessageBatch()`, `addWorker()` and `resize()` with an
`ERR_POOL_TERMINATED` error rather than silently recreating workers.
Create a new `PowerPool` to start again.

#### Returns

`void`

***

### stopThePress()

> **stopThePress**(`message`, `transfer`, `options`): `boolean` \| `Promise`\<`any`\>

Stop all pending queued tasks and immediately post a message to the pool.
This clears the internal task queue first (cancelling pending tasks),
updates the pool idle state, then forwards the provided message using
`postMessage` so the message is dispatched to a live worker immediately
(or enqueued if no worker can accept it).

#### Parameters

##### message

`any`

The message to post after clearing pending tasks.

##### transfer

`Transferable`[] \| `undefined`

Optional transfer list. When omitted
and a plain object is supplied, the pool will attempt to encode the
object to a transferable `Uint8Array` for efficient transfer.

##### options

`Object` \| `undefined`

Optional options forwarded to `postMessage`.

#### Returns

`boolean` \| `Promise`\<`any`\>

The same return value as `postMessage`.

***

### stopThePressBatch()

> **stopThePressBatch**(`items`, `options`): (`boolean` \| `Promise`\<`any`\>)[]

Stop the press and then post a batch of messages.

Clears the internal task queue and terminates inflight workers (optionally recreating them),
rejects pending response Promises, then forwards the provided batch to `postMessageBatch`.

This method mirrors the semantics of `stopThePress` for single messages but
operates on a batch. Use it when you need to atomically cancel pending work
and then seed the pool with a new set of tasks.

#### Parameters

##### items

`object`[]

Array of items to send after clearing the pool.

##### options

`Object` \| `undefined`

Optional options forwarded to `postMessageBatch`.
  Recognized options include:
    - `recreateWorkers` (boolean, default: true) — whether to recreate replacement workers after termination.
    - `awaitResponse` (boolean) — if true, returned slots will be Promises as in `postMessageBatch`.
    - `workerId` (number) — target a specific worker during dispatch attempts.

#### Returns

(`boolean` \| `Promise`\<`any`\>)[]

Array with per-item results: `true|false` or `Promise` when awaiting responses.

***

### terminate()

> **terminate**(): `void`

Terminate the entire pool, clear queue and the reaper interval.

#### Returns

`void`
