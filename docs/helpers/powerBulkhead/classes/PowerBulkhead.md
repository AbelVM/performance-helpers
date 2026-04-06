[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBulkhead](../README.md) / PowerBulkhead

# Class: PowerBulkhead

## Constructors

### Constructor

> **new PowerBulkhead**(`options?`): `PowerBulkhead`

#### Parameters

##### options?

###### maxConcurrency?

`number`

Maximum concurrent tasks per partition.

###### partitioner?

`Function`

Function `(key)=>partitionIndex`.

###### partitions?

`number`

Number of isolated execution partitions.

###### queueCapacity?

`number`

Maximum queued tasks across all partitions.

#### Returns

`PowerBulkhead`

## Properties

### \_buckets

> **\_buckets**: `object`[]

#### gate

> **gate**: [`PowerPermitGate`](../../powerPermitGate/classes/PowerPermitGate.md)

***

### \_drainWaiters

> **\_drainWaiters**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

***

### \_maxConcurrency

> **\_maxConcurrency**: `number`

***

### \_nextPartition

> **\_nextPartition**: `number`

***

### \_partitioner

> **\_partitioner**: `Function` \| `null`

***

### \_partitions

> **\_partitions**: `number`

***

### \_queueCapacity

> **\_queueCapacity**: `number`

## Accessors

### active

#### Get Signature

> **get** **active**(): `number`

Total number of running tasks across all partitions.

##### Returns

`number`

***

### isFull

#### Get Signature

> **get** **isFull**(): `boolean`

True when the bulkhead queue is saturated.

##### Returns

`boolean`

***

### maxConcurrency

#### Get Signature

> **get** **maxConcurrency**(): `number`

Maximum concurrent tasks allowed per partition.

##### Returns

`number`

***

### partitions

#### Get Signature

> **get** **partitions**(): `number`

Number of partitions used for workload isolation.

##### Returns

`number`

***

### pending

#### Get Signature

> **get** **pending**(): `number`

Total number of currently queued tasks.

##### Returns

`number`

***

### queueCapacity

#### Get Signature

> **get** **queueCapacity**(): `number`

Maximum number of tasks that may wait in the queue.

##### Returns

`number`

## Methods

### \_choosePartition()

> **\_choosePartition**(`key`): `number`

#### Parameters

##### key

`any`

#### Returns

`number`

***

### \_hashKey()

> **\_hashKey**(`value`): `number`

#### Parameters

##### value

`any`

#### Returns

`number`

***

### drain()

> **drain**(): `Promise`\<`void`\>

Wait for all active and queued tasks to complete.

#### Returns

`Promise`\<`void`\>

***

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

#### Returns

`Promise`\<`any`\>

Promise resolving or rejecting with task result.

***

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
