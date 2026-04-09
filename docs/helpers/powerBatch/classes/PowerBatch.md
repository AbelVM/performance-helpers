[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBatch](../README.md) / PowerBatch

# Class: PowerBatch

PowerBatch

Scheduler-driven batching helper that collects items and dispatches them
to a provided handler on a microtask/macrotask boundary.

 PowerBatch

## Constructors

### Constructor

> **new PowerBatch**(`handler`, `options?`): `PowerBatch`

#### Parameters

##### handler

`Function`

Function called with an array of collected items.

##### options?

###### maxSize?

`number`

When reached, flush immediately.

###### scheduling?

`"microtask"` \| `"macrotask"`

How the batch is scheduled.

#### Returns

`PowerBatch`

## Properties

### \_handler

> **\_handler**: `Function`

***

### \_maxSize

> **\_maxSize**: `number`

***

### \_pending

> **\_pending**: \{ `promise`: `Promise`\<`any`\>; `reject`: `undefined`; `resolve`: `undefined`; \} \| \{ `promise`: `Promise`\<`any`\>; `reject`: `undefined`; `resolve`: `undefined`; \} \| `null`

***

### \_queue

> **\_queue**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

***

### \_scheduler

> **\_scheduler**: [`PowerScheduler`](../../powerScheduler/classes/PowerScheduler.md)

## Accessors

### size

#### Get Signature

> **get** **size**(): `number`

Number of items currently queued (not yet flushed).

##### Returns

`number`

## Methods

### add()

> **add**(`item`): `Promise`\<`void`\>

Add an item to the current batch. Returns a Promise that resolves
when the batch containing this item has been processed. For non-flushed
additions this will be resolved after the scheduled run; if adding the
item hits `maxSize` the returned promise resolves when the handler completes.

#### Parameters

##### item

`any`

#### Returns

`Promise`\<`void`\>

***

### clear()

> **clear**(): `void`

Clear queued items without invoking handler.
Any pending promise for the current batch is rejected.

#### Returns

`void`

***

### flush()

> **flush**(): `Promise`\<`void`\>

Force flush the current queue immediately and return a promise
that resolves or rejects with the handler outcome.
If the queue is empty and nothing is scheduled, the returned promise
resolves immediately.

#### Returns

`Promise`\<`void`\>
