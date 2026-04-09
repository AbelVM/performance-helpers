[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerQueue](../README.md) / PowerQueue

# Class: PowerQueue

PowerQueue

Lightweight resizable ring-buffer queue with O(1) enqueue/dequeue.
Designed as a small, dependency-free helper for high-throughput queues.

 PowerQueue

## Example

```ts
const q = new PowerQueue(8);
q.push(1);
q.push(2);
q.shift(); // 1
```

## Constructors

### Constructor

> **new PowerQueue**(`initialCapacity?`): `PowerQueue`

Create a PowerQueue.

#### Parameters

##### initialCapacity?

`number` = `16`

Initial capacity (rounded up to power-of-two).

#### Returns

`PowerQueue`

## Properties

### \_buffer

> **\_buffer**: `any`[]

***

### \_capacity

> **\_capacity**: `number`

***

### \_head

> **\_head**: `number`

***

### \_mask

> **\_mask**: `number`

***

### \_size

> **\_size**: `number`

***

### \_tail

> **\_tail**: `number`

## Accessors

### capacity

#### Get Signature

> **get** **capacity**(): `number`

Internal buffer capacity (always a power-of-two).

##### Returns

`number`

***

### isEmpty

#### Get Signature

> **get** **isEmpty**(): `boolean`

Whether the queue is empty.

##### Returns

`boolean`

***

### length

#### Get Signature

> **get** **length**(): `number`

Number of items currently queued.

##### Returns

`number`

## Methods

### \[iterator\]()

> **\[iterator\]**(): `Iterator`\<`any`, `any`, `any`\>

Iterator (non-destructive) yielding items in FIFO order.
Allows `for...of` and spread (`[...queue]`) without consuming the queue.

#### Returns

`Iterator`\<`any`, `any`, `any`\>

***

### clear()

> **clear**(): `void`

Remove all items from the queue.

#### Returns

`void`

***

### drain()

> **drain**(): `Iterator`\<`any`, `any`, `any`\>

Consuming drain iterator: yields items in FIFO order and removes them
from the queue as they are iterated.
Useful for streaming/processing and emptying the queue without manual loops.

#### Returns

`Iterator`\<`any`, `any`, `any`\>

***

### entries()

> **entries**(): `Iterator`\<\[`number`, `any`\], `any`, `any`\>

Non-destructive entries iterator that yields [index, value] pairs where
index is the zero-based position in the queue (0 is the head).

#### Returns

`Iterator`\<\[`number`, `any`\], `any`, `any`\>

***

### keys()

> **keys**(): `Iterator`\<`number`, `any`, `any`\>

Return an iterator of keys (zero-based indexes from the head).

#### Returns

`Iterator`\<`number`, `any`, `any`\>

***

### peek()

> **peek**(): `any`

Peek at the head item without removing it.

#### Returns

`any`

The head item or `undefined` when empty.

***

### push()

> **push**(`item`): `number`

Enqueue an item at the tail.

#### Parameters

##### item

`any`

Item to enqueue.

#### Returns

`number`

New queue length after push.

***

### pushMany()

> **pushMany**(`items`): `number`

Enqueue multiple items in one call. Optimized to resize buffer once and
copy items in contiguous blocks when possible.

#### Parameters

##### items

`any`[]

#### Returns

`number`

New queue length after all pushes.

***

### shift()

> **shift**(): `any`

Dequeue and return the head item.

#### Returns

`any`

The dequeued item or `undefined` when empty.

***

### toArray()

> **toArray**(): `any`[]

Return a shallow array snapshot of the queue contents in FIFO order.
This is a convenience helper that does not consume the queue.

#### Returns

`any`[]

***

### unshiftMany()

> **unshiftMany**(`items`): `number`

Prepend multiple items to the head of the queue.
The first element of `items` will become the next value returned by `shift()`.

#### Parameters

##### items

`any`[]

#### Returns

`number`

New queue length after all unshifts.

***

### values()

> **values**(): `Iterator`\<`any`, `any`, `any`\>

Return an iterator of values (alias of the default iterator).

#### Returns

`Iterator`\<`any`, `any`, `any`\>
