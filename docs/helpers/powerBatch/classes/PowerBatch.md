[**performance-helpers**](../../../README.md)

---

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

(`items`) => `void` \| `Promise`\<`void`\>

Called with the whole
collected array each time the batch flushes. A rejection rejects every
promise handed out by `add()`/`flush()` in that batch.

##### options?

`PowerBatchOptions` = `{}`

`maxSize` defaults to unbounded and
`scheduling` to `'microtask'`.

#### Returns

`PowerBatch`

## Properties

### \_handler

> **\_handler**: (`items`) => `void` \| `Promise`\<`void`\>

#### Parameters

##### items

`any`[]

#### Returns

`void` \| `Promise`\<`void`\>

---

### \_maxSize

> **\_maxSize**: `number`

---

### \_pending

> **\_pending**: `BatchPending` \| `null`

---

### \_queue

> **\_queue**: [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

---

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

### \_ensurePending()

> **\_ensurePending**(): `BatchPending`

The pending entry for the batch being assembled, created on first use.

Extracted because `add()` and `flush()` both needed it, and duplicating the
`let resolve, reject` dance meant the uninitialised `undefined` was
assignable to the handles at one site and not the other.

#### Returns

`BatchPending`

---

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [dispose](#dispose-1), so `using x = new X()` releases the instance
deterministically at scope exit.

#### Returns

`void`

---

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

---

### clear()

> **clear**(): `void`

#### Returns

`void`

---

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

Idempotent, and safe to call while the instance is idle. Exists so the
instance works with `using` / `await using` and gives callers an explicit
name to call.

#### Returns

`void`

---

### flush()

> **flush**(`options?`): `Promise`\<`void`\>

Force flush the current queue immediately and return a promise
that resolves or rejects with the handler outcome.
If the queue is empty and nothing is scheduled, the returned promise
resolves immediately.

#### Parameters

##### options?

#### Returns

`Promise`\<`void`\>

---

### reset()

> **reset**(): `void`

Alias for [PowerBatch#clear](#clear).

`clear()` here empties the container, and "reset" is a natural second word
for exactly that - so a caller who reaches for `reset()` on this class gets
the obvious thing instead of a `TypeError`. No limiter gets this alias: for
`PowerThrottle` and `PowerPermitGate`, `reset()` _refills_ and `clear()`
would read as the opposite, and the two are deliberately not synonyms.

#### Returns

`void`
