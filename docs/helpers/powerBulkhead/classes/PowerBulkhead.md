[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerBulkhead](../README.md) / PowerBulkhead

# Class: PowerBulkhead

## Constructors

### Constructor

> **new PowerBulkhead**(`options?`): `PowerBulkhead`

#### Parameters

##### options?

`PowerBulkheadOptions` = `{}`

#### Returns

`PowerBulkhead`

## Properties

### \_activeCount

> **\_activeCount**: `number`

---

### \_buckets

> **\_buckets**: `object`[]

#### gate

> **gate**: [`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md)

---

### \_drainWaiters

> **\_drainWaiters**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

---

### \_maxConcurrency

> **\_maxConcurrency**: `number`

---

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

---

### \_nextPartition

> **\_nextPartition**: `number`

---

### \_onError

> **\_onError**: ((`err`) => `void`) \| `null`

---

### \_outstanding

> **\_outstanding**: `number`

---

### \_partitioner

> **\_partitioner**: ((`key`) => `number`) \| `null`

---

### \_partitions

> **\_partitions**: `number`

---

### \_queueCapacity

> **\_queueCapacity**: `number`

## Accessors

### active

#### Get Signature

> **get** **active**(): `number`

Total number of running tasks across all partitions.

##### Returns

`number`

---

### isFull

#### Get Signature

> **get** **isFull**(): `boolean`

True when **every** partition is at its queue budget, so no task that would
have to queue can be admitted anywhere.

Under a per-partition budget "is the bulkhead full" cannot be a single
comparison against a global pending count, because a full partition says
nothing about the others. `every` is the reading that matches the name: the
bulkhead can accept no more work. `some` would report `isFull` as soon as
one partition was busy, which is the _normal_ state of an isolated
bulkhead and would make the flag useless for backing off.

##### Returns

`boolean`

---

### maxConcurrency

#### Get Signature

> **get** **maxConcurrency**(): `number`

Maximum concurrent tasks allowed per partition.

##### Returns

`number`

---

### partitions

#### Get Signature

> **get** **partitions**(): `number`

Number of partitions used for workload isolation.

##### Returns

`number`

---

### pending

#### Get Signature

> **get** **pending**(): `number`

Total number of currently queued tasks, across all partitions.

The sum of the partitions' own queues. This used to be a separate
`_pendingCount` incremented and decremented by hand alongside the gates'
own `pending`; two counters for one quantity, which is how a refusal
decision came to be made against the wrong one.

##### Returns

`number`

---

### queueCapacity

#### Get Signature

> **get** **queueCapacity**(): `number`

Maximum number of tasks that may wait, **per partition**.

The total that can wait is `queueCapacity * partitions`. `0` is honoured
and means "refuse immediately rather than queue", matching
`PowerPermitGate`.

##### Returns

`number`

## Methods

### \_choosePartition()

> **\_choosePartition**(`key`): `number`

The partition a key belongs to: the explicit `partitioner` when given,
otherwise a hash of the key, and otherwise round-robin so keys spread
evenly when there is nothing to hash.

#### Parameters

##### key

`any`

#### Returns

`number`

An index in `[0, partitions)`.

---

### \_hashKey()

> **\_hashKey**(`value`): `number`

djb2 hash, kept unsigned so the modulo below cannot produce a negative
index.

#### Parameters

##### value

`string`

#### Returns

`number`

---

### \_resolveDrainWaitersIfIdle()

> **\_resolveDrainWaitersIfIdle**(): `void`

#### Returns

`void`

---

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

---

### dispose()

> **dispose**(`options?`): `void`

Alias for [PowerBulkhead#reset](#reset), plus releasing the metrics
registration.

A disposed bulkhead that stays registered is sampled forever: its
`stats()` keeps answering, so nothing fails visibly, and the collector
accumulates a series for an object nobody can reach. `guides/metrics.md`
lists this as one of the helpers that must detach in teardown, and it did
not.

#### Parameters

##### options?

`PowerBulkheadResetOptions`

Reset options.

#### Returns

`void`

---

### drain()

> **drain**(): `Promise`\<`void`\>

Wait for all active and queued tasks to complete.

#### Returns

`Promise`\<`void`\>

---

### reset()

> **reset**(`options?`): `void`

Reject every queued waiter across all partitions and return the bulkhead
to a fully idle state.

`PowerBulkhead` was the only gate/queue/limit class in the library with no
disposal path, so a bulkhead that saturated (`queueCapacity` reached, all
permits held by tasks that never settle) could not be recovered: its
queued waiters were retained forever and `drain()` never resolved.

Tasks that are already _running_ are not cancelled - JavaScript cannot
interrupt them - but they no longer block a subsequent `drain()` from
resolving once they settle.

#### Parameters

##### options?

`PowerBulkheadResetOptions` = `{}`

Reset options.

#### Returns

`void`

---

### run()

> **run**(`task`, `options?`): `Promise`\<`any`\>

Enqueue a task for execution under partition isolation.

#### Parameters

##### task

`Function`

Async callback to execute.

##### options?

###### partitionKey?

`any`

Optional key used to route the task to a partition.

###### signal?

`AbortSignal`

Abort while queued: the returned promise
rejects with an `AbortError` and the task never runs. Cancelling the _wait_
is not cancelling the _work_ - a task that already holds a permit runs to
completion.

#### Returns

`Promise`\<`any`\>

Promise resolving or rejecting with task result.

---

### stats()

> **stats**(): `object`

Snapshot of the bulkhead's counters.

#### Returns

`object`

##### active

> **active**: `number`

##### maxConcurrency

> **maxConcurrency**: `number`

##### partitions

> **partitions**: `number`

##### pending

> **pending**: `number`

##### queueCapacity

> **queueCapacity**: `number`

##### saturated

> **saturated**: `boolean`

---

### tryRun()

> **tryRun**(`task`, `options?`): `Promise`\<`any`\> \| `null`

Try to execute immediately without queuing.

#### Parameters

##### task

`Function`

##### options?

###### partitionKey?

`any`

#### Returns

`Promise`\<`any`\> \| `null`
