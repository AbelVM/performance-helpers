[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPriorityQueue](../README.md) / PowerPriorityQueue

# Class: PowerPriorityQueue

PowerPriorityQueue

Binary heap-based priority queue. Higher priority values are dequeued first.
When priorities are equal, FIFO order is preserved for stability.

 PowerPriorityQueue

## Constructors

### Constructor

> **new PowerPriorityQueue**(`initialCapacity?`): `PowerPriorityQueue`

#### Parameters

##### initialCapacity?

`number` \| \{ `initialCapacity?`: `number`; \}

#### Returns

`PowerPriorityQueue`

## Properties

### \_capacity

> **\_capacity**: `number`

***

### \_heap

> **\_heap**: `any`[]

***

### \_seq

> **\_seq**: `number`

***

### \_size

> **\_size**: `number`

## Accessors

### length

#### Get Signature

> **get** **length**(): `number`

##### Returns

`number`

***

### size

#### Get Signature

> **get** **size**(): `number`

##### Returns

`number`

## Methods

### \_grow()

> **\_grow**(): `void`

#### Returns

`void`

***

### \_isBetter()

> **\_isBetter**(`candidate`, `current`): `boolean`

#### Parameters

##### candidate

`any`

##### current

`any`

#### Returns

`boolean`

***

### \_siftDown()

> **\_siftDown**(`i`): `void`

Restore the heap property downwards from `i`.

#### Parameters

##### i

`number`

#### Returns

`void`

***

### \_siftUp()

> **\_siftUp**(`i`): `void`

Restore the heap property upwards from `i`.

Extracted from `push()` because `popLowest()` moves an element from the
bottom of the heap into an arbitrary slot, and that element can belong
above its new parent. Two copies of this loop is two places for the
comparison to drift.

#### Parameters

##### i

`number`

#### Returns

`void`

***

### \_swap()

> **\_swap**(`i`, `j`): `void`

#### Parameters

##### i

`number`

##### j

`number`

#### Returns

`void`

***

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

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### isEmpty()

> **isEmpty**(): `boolean`

#### Returns

`boolean`

***

### peek()

> **peek**(): `any`

#### Returns

`any`

***

### popLowest()

> **popLowest**(): `any`

Remove and return the item that would be delivered **last**.

The mirror of `shift()`, and the reason it is here rather than in the
caller: a bounded priority queue has to evict something when it is full,
and evicting the *best* item — which is what a naive `shift()` in the
drop path does — throws away exactly the message the ordering existed to
protect. `PowerRealtimeHub`'s `drop-oldest` policy needs this under
`messagePriority`, and a caller maintaining their own bounded queue needs
it for the same reason.

"Worst" is the exact inverse of `_isBetter`: lowest priority, and among
equal priorities the one inserted **most recently**, because that is the
one `shift()` would reach last. So `popLowest()` is a true mirror of
`shift()` — drain from both ends and you consume the queue in order from
each side.

O(n) rather than O(log n), because finding the minimum of a max-heap is a
scan. That is the right trade for an eviction path, which runs only when
the queue is already full.

#### Returns

`any`

The worst item, or `undefined` when empty.

***

### push()

> **push**(`item`): `number`

#### Parameters

##### item

`any`

#### Returns

`number`

***

### pushMany()

> **pushMany**(`items`): `number`

Enqueue several items in one call.

A loop over [PowerPriorityQueue#push](#push), and deliberately so: each push is
already O(log n), so the bulk call is O(k log n) with no shared setup to
amortise. `PowerQueue.pushMany` earns its separate implementation because a
ring buffer can grow once and copy in blocks; a heap cannot, and pretending
otherwise would be a slower loop with more code.

#### Parameters

##### items

`any`[]

#### Returns

`number`

New queue length after all pushes.

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### shift()

> **shift**(): `any`

#### Returns

`any`

***

### toArray()

> **toArray**(): `any`[]

Return a shallow array snapshot of the queue contents **in dispatch order** —
highest priority first, FIFO among equal priorities.

Dispatch order rather than insertion order, because that is the useful
question for a priority queue: "what would I get if I drained this". A caller
who wants insertion order wants a `PowerQueue`.

Sorts the *entries*, not the items, and that is the whole subtlety: the FIFO
tiebreak is the insertion sequence number, which lives on the entry. Sorting
the items directly would compare equal priorities as equal and fall back on
the heap array's layout, which is a valid heap but not an insertion order — so
the result would look sorted and not be FIFO.

#### Returns

`any`[]
