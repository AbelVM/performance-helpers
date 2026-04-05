[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBatch](../README.md) / PowerBatch

# Class: PowerBatch

PowerBatch — microtask-coalescing dispatcher.
Collects items added within the same microtask and dispatches them
to the provided `handler(items[])`. Useful to batch synchronous
work (DB writes, network calls) with minimal latency.

## Example

```ts
const batch = new PowerBatch((items) => bulkWrite(items), { maxSize: 100 });
batch.add(itemA);
batch.add(itemB);
// items are coalesced and handler called once in the next microtask
```

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

> **\_pending**: \{ `promise`: `Promise`\<`any`\>; `reject`: `undefined`; `resolve`: `undefined`; \} \| `null`

***

### \_queue

> **\_queue**: `any`[]

***

### \_scheduled

> **\_scheduled**: `boolean`

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
additions this will be resolved after the microtask run; if adding the
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

#### Returns

`void`

***

### flush()

> **flush**(): `Promise`\<`void`\>

Force flush the current queue immediately and return a promise
that resolves or rejects with the handler outcome.

#### Returns

`Promise`\<`void`\>
