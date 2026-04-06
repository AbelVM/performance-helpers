[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PowerPool

# Class: PowerPool

Manager for a pool of web workers.

## Example

```ts
import MinionWorker from './worker.js?worker&inline'
const pool = new PowerPool(MinionWorker, { size: 4, idleTimeout: 30000 });
pool.onmessage = (e) => { logger.log(e.data); };
pool.postMessage({ payload: {} });
```

## Indexable

> \[`key`: `number`\]: () => `void`

## Constructors

### Constructor

> **new PowerPool**(`workerSource`, `options?`): `PowerPool`

Create a PowerPool.

#### Parameters

##### workerSource

`string` \| `Function`

A Worker constructor, a worker factory, or a relative path string. If the provided function is not constructable, it is invoked directly; if a string path is provided, the pool attempts to resolve it via `new URL(path, import.meta.url)` before falling back to a plain `Worker(path)`.

##### options?

[`PowerPoolOptions`](../interfaces/PowerPoolOptions.md) \| `undefined`

[`PowerPoolOptions`](../interfaces/PowerPoolOptions.md)

***

`undefined`

#### Returns

`PowerPool`

## Properties

### \_activeTasks

> **\_activeTasks**: `number`

number of currently active (dispatched) tasks across all workers

***

### \_autoScale

> **\_autoScale**: \{ `alpha`: `number`; `backoffFactor`: `number`; `backoffMaxMultiplier`: `number`; `backoffResetMs`: `number`; `cooldownMs`: `number`; `enabled`: `boolean`; `hysteresis`: `number`; `intervalMs`: `number`; `stepDown`: `number`; `stepUp`: `number`; `targetMs`: `number`; \} \| `null`

***

### \_autoScaleBackoffMultiplier

> **\_autoScaleBackoffMultiplier**: `number` \| `undefined`

***

### \_autoScaleInterval

> **\_autoScaleInterval**: `number` \| `null`

***

### \_bus

> **\_bus**: [`PowerEventBus`](../../powerEventBus/classes/PowerEventBus.md)

***

### \_createdAt

> **\_createdAt**: `number`

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

### \_isIdle

> **\_isIdle**: `boolean`

whether the pool is considered idle (no active tasks and empty queue)

***

### \_lastAutoScaleAt

> **\_lastAutoScaleAt**: `number` \| `null`

***

### \_logger

> **\_logger**: [`PowerLogger`](../../powerLogger/classes/PowerLogger.md)

***

### \_maxTasksPerWorker

> **\_maxTasksPerWorker**: `number`

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

### \_queueHighCrossed

> **\_queueHighCrossed**: `boolean`

***

### \_queueHighThreshold

> **\_queueHighThreshold**: `number`

***

### \_queuePaused

> **\_queuePaused**: `boolean` \| `undefined`

***

### \_queuePolicy

> **\_queuePolicy**: `"enqueue"` \| `"drop-oldest"` \| `"drop-newest"` \| `"reject"`

***

### \_reaperInterval

> **\_reaperInterval**: `number`

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

> **workers**: [`WorkerObj`](../interfaces/WorkerObj.md)[]

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

### \_deleteWorkerUnderlyingMapping()

> **\_deleteWorkerUnderlyingMapping**(`workerObj`): `void`

#### Parameters

##### workerObj

`any`

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

> **addWorker**(): [`WorkerObj`](../interfaces/WorkerObj.md)

Add one worker to the pool immediately.

#### Returns

[`WorkerObj`](../interfaces/WorkerObj.md)

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

### drain()

> **drain**(): `Promise`\<`object`\>

Return a Promise that resolves when the pool becomes idle (queue empty and all workers have tasks === 0).
Resolves with the result of `getStats()` at the time of idle.

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

[`PostMessageOptions`](../interfaces/PostMessageOptions.md) \| `undefined`

Optional flags controlling behavior such as `awaitResponse`, `timeout`, `workerId`, and `zeroCopy`.

#### Returns

`boolean` \| `Promise`\<`any`\>

When `options.awaitResponse` is truthy this returns a `Promise` that resolves with the worker response; otherwise returns `true` when the message was accepted (dispatched or queued) or `false` when it was rejected.

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

`Object` \| `undefined`

Optional options forwarded to each `postMessage` call.

#### Returns

(`boolean` \| `Promise`\<`any`\>)[]

***

### prepareBuffer()

> **prepareBuffer**(`obj`, `options?`): `Uint8Array`\<`ArrayBufferLike`\>

Prepare a transferable Uint8Array for the given object.
Returns a new Uint8Array when `clone` is true (safe to transfer), or
the cached Uint8Array when `clone` is false (do not transfer the returned buffer).

#### Parameters

##### obj

`Object`

##### options?

\{ `clone?`: `boolean`; \} \| `undefined`

#### Returns

`Uint8Array`\<`ArrayBufferLike`\>

***

### prepareBuffers()

> **prepareBuffers**(`items`, `options?`): `object`[]

Prepare an array of transferable buffers for a batch of items.
Each item may be a plain object, a TypedArray/ArrayBuffer view, or
an object `{ message, transfer? }`. The returned array contains
normalized `{ message, transfer }` entries ready for `postMessageBatch`.
By default each buffer is a cloned Uint8Array safe to transfer; pass
`{ clone: false }` to return references to internal cached buffers
(do NOT transfer those buffers if `clone:false`).

#### Parameters

##### items

`any`[]

##### options?

\{ `clone?`: `boolean`; \} \| `undefined`

#### Returns

`object`[]

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
