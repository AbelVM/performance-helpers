[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerQueue](../README.md) / PowerQueue

# Class: PowerQueue

Lightweight resizable ring-buffer queue with O(1) enqueue/dequeue.
Designed as a small, dependency-free helper for high-throughput queues.

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

##### Returns

`number`

***

### isEmpty

#### Get Signature

> **get** **isEmpty**(): `boolean`

##### Returns

`boolean`

***

### length

#### Get Signature

> **get** **length**(): `number`

##### Returns

`number`

## Methods

### clear()

> **clear**(): `void`

Remove all items from the queue.

#### Returns

`void`

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
