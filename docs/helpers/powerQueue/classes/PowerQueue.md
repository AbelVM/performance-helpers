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

`number` = `POWER_QUEUE_INITIAL_CAPACITY`

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

***

### \_totalWeight

> **\_totalWeight**: `number`

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

***

### totalWeight

#### Get Signature

> **get** **totalWeight**(): `number`

Sum of `weight` across all queued items, where each item's weight is its
numeric `weight` property or `1` when absent. With weight-less items this
is identical to `length`, which is what keeps the default path at zero extra
cost in reasoning.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### \[iterator\]()

> **\[iterator\]**(): `Iterator`\<`any`, `any`, `any`\>

Iterator (non-destructive) yielding items in FIFO order.
Allows `for...of` and spread (`[...queue]`) without consuming the queue.

#### Returns

`Iterator`\<`any`, `any`, `any`\>

***

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release the queue's buffer and drop every reference it holds.

**Why this exists.** `PowerQueue` owns a ring buffer that only ever grows —
`_grow()` doubles it and nothing halves it — so a queue that took 5 000 items
once keeps an 8 192-slot buffer for the rest of its life. `clear()` empties
the slots but deliberately does not release them, which is right for a
container whose purpose is bounding memory and wrong for one being torn down.
Without this, `PowerQueue` could not take part in `using` / `await using` or
a DI teardown, which every other long-lived helper here supports — and its
sibling `PowerPriorityQueue` has had `dispose()` all along.

The buffer is dropped rather than shrunk to the initial capacity: the point
of teardown is that the caller is finished with the queue, and a caller who
wants a smaller live queue has `shrink()`.

#### Returns

`void`

***

### drain()

> **drain**(): `IterableIterator`\<`any`, `any`, `any`\>

Consuming drain iterator: yields items in FIFO order and removes them
from the queue as they are iterated.
Useful for streaming/processing and emptying the queue without manual loops.

#### Returns

`IterableIterator`\<`any`, `any`, `any`\>

***

### entries()

> **entries**(): `Iterator`\<\[`number`, `any`\], `any`, `any`\>

Non-destructive entries iterator that yields [index, value] pairs where
index is the zero-based position in the queue (0 is the head).

#### Returns

`Iterator`\<\[`number`, `any`\], `any`, `any`\>

***

### fill()

> **fill**(`item`, `count?`): `number`

Enqueue `count` copies of `item` without building an intermediate array.

Exists for the one caller that wanted it: filling a window with `n` equal
timestamps used to be `new Array(n)`, a loop to populate the holes, and then
`pushMany` to walk the result — a temporary allocation and a second pass on
a path that runs per `tryConsume(n)` with `n > 1`.

#### Parameters

##### item

`any`

The value to enqueue `count` times.

##### count?

`number` = `1`

How many copies.

#### Returns

`number`

New queue length after the pushes.

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

### removeAt()

> **removeAt**(`index`): `any`

Remove the item at logical index `index` (0 = head) and shift subsequent
items forward to fill the gap. Returns the removed item, or `undefined` if
the index is out of range.

This is O(n) in the number of items after the removed index, which is the
same cost as `shift()` when the head is removed and acceptable for the
bounded queues this helper is designed for.

#### Parameters

##### index

`number`

Logical index from the head (0-based).

#### Returns

`any`

***

### reset()

> **reset**(): `void`

Alias for [PowerQueue#clear](#clear).

`clear()` here empties the container, and "reset" is a natural second word
for exactly that - so a caller who reaches for `reset()` on this class gets
the obvious thing instead of a `TypeError`. No limiter gets this alias: for
`PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
would read as the opposite, and the two are deliberately not synonyms.

#### Returns

`void`

***

### shift()

> **shift**(): `any`

Dequeue and return the head item.

#### Returns

`any`

The dequeued item or `undefined` when empty.

***

### shiftHighestPriority()

> **shiftHighestPriority**(`priorityFn`): `any`

Remove and return the item with the highest priority according to
`priorityFn`. When multiple items share the same priority, the one closest
to the head (lowest logical index) is returned, preserving FIFO order among
equal-priority items.

Returns `undefined` when the queue is empty.

#### Parameters

##### priorityFn

(`item`) => `number`

Function that returns a numeric
  priority for an item. Higher numbers win.

#### Returns

`any`

***

### shrink()

> **shrink**(`minimum?`): `number`

Release memory held by a burst, by reallocating the buffer smaller.

The buffer only ever grows: `_grow()` doubles it and nothing halves it, so a
queue that took 5 000 items once keeps an 8 192-slot buffer for the rest of
its life. `clear()` empties the slots but does not release them, and that is
the right behaviour for a container whose purpose is bounding memory.
Measured: 5 000 pushes, then drained or cleared, leaves `capacity` at 8 192
with `length` 0.

**Explicit rather than automatic, and the reason is the hot path.** The
obvious alternative is to shrink inside `shift()` whenever
`size < capacity / 2`, which costs a comparison and a branch on every
dequeue forever to reclaim memory only after a burst. A caller that has just
finished a burst knows when to pay; the dequeue path does not.

`minimum` is the capacity to keep — a floor for a queue that is expected to
refill to a known size, so a burst followed by steady traffic does not
reallocate on every cycle. It is rounded **up** to a power of two like the
constructor, and never below 2, which is the same floor the constructor
applies. Passing anything smaller than the current length is a no-op: the
buffer cannot hold what is in it.

#### Parameters

##### minimum?

`number` = `POWER_QUEUE_INITIAL_CAPACITY`

Capacity to keep.

#### Returns

`number`

The capacity after the call.

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
