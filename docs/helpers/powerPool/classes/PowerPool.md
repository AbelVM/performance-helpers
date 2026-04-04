[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PowerPool

# Class: PowerPool

Manager for a pool of web workers.

## Example

```ts
import MinionWorker from './worker.js?worker&inline'
const pool = new PowerPool(MinionWorker, { size: 4, idleTimeout: 30000 });
pool.onmessage = (e) => { console.log(e.data); };
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

A Worker constructor/factory (callable) or a relative path string to pass to `new Worker(new URL(path, import.meta.url))`.

##### options?

###### idleTimeout?

`number`

Milliseconds after which idle workers (beyond `minSize`) will be terminated.

###### maxSize?

`number`

Maximum number of workers allowed in the pool.

###### maxTasksPerWorker?

`number`

Soft capacity per worker before considering it busy.

###### minSize?

`number`

Minimum number of workers to keep alive.

###### size?

`number`

Initial number of workers to create.

###### taskQueue?

`boolean`

Whether to queue tasks when all workers are busy.

###### workerOptions?

`Object`

Options forwarded to the Worker constructor when using a string path.

#### Returns

`PowerPool`

## Properties

### \_activeTasks

> **\_activeTasks**: `number`

number of currently active (dispatched) tasks across all workers

***

### \_createdAt

> **\_createdAt**: `number`

***

### \_isIdle

> **\_isIdle**: `boolean`

whether the pool is considered idle (no active tasks and empty queue)

***

### \_listeners

> **\_listeners**: `object`

#### error

> **error**: `Set`\<`any`\>

#### idle

> **idle**: `Set`\<`any`\>

#### message

> **message**: `Set`\<`any`\>

#### messageerror

> **messageerror**: `Set`\<`any`\>

#### resize

> **resize**: `Set`\<`any`\>

***

### \_maxTasksPerWorker

> **\_maxTasksPerWorker**: `number`

***

### \_nextCorrelationId

> **\_nextCorrelationId**: `number`

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

## Methods

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

Return stats for debugging.

#### Returns

`object`

##### performance

> **performance**: `Object`

##### status

> **status**: `object`[]

***

### postMessage()

> **postMessage**(`message`, `transfer`, `options`): `boolean`

Post a message to a worker in the pool.
The pool will try to reuse an idle/least-loaded worker, grow the pool
(up to `maxSize`), or queue the task if configured.

#### Parameters

##### message

`any`

The message to post to a worker.

##### transfer

`Transferable`[] \| `undefined`

Optional transfer list.

##### options

`any`

#### Returns

`boolean`

True if the message was accepted (dispatched or queued).

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

### terminate()

> **terminate**(): `void`

Terminate the entire pool, clear queue and the reaper interval.

#### Returns

`void`
