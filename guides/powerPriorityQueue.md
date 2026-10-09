# PowerPriorityQueue

A binary heap–based priority queue. Higher priority values are dequeued first. When priorities are equal, FIFO order is preserved for stability.

## When to use

- You need to process messages or jobs in priority order (QoS).
- You need deterministic FIFO among equal-priority items.
- You want O(log n) push/shift with small overhead.

## Installation

```js
import { PowerPriorityQueue } from 'performance-helpers/powerPriorityQueue';
```

## `popLowest()` — the other end

`shift()` takes the best item. `popLowest()` takes the worst, and it is a true
mirror: drain from both ends and you consume the queue in order from each side.

It exists because a **bounded** priority queue has to evict something when it is
full, and evicting with `shift()` in the drop path throws away exactly the
message the ordering existed to protect. `PowerRealtimeHub`'s `drop-oldest`
policy needs this under `messagePriority`, and a caller maintaining their own
bounded queue needs it for the same reason.

```js
const q = new PowerPriorityQueue();
q.push({ v: 'urgent', priority: 10 });
q.push({ v: 'noise', priority: 1 });

q.popLowest(); // { v: 'noise', priority: 1 } — the junk loses its slot
q.shift(); // { v: 'urgent', priority: 10 }
```

It is O(n) rather than O(log n), because finding the minimum of a max-heap is a
scan. That is the right trade for an eviction path, which runs only when the
queue is already full.

## API

### new PowerPriorityQueue(initialCapacity)

- `initialCapacity` (number|object, optional): initial backing store size; rounded up. If passed `{ initialCapacity }`, known options asserted.

### Methods

- `push(item)` — Enqueue item; returns new size. Item priority is taken from `item.priority` (number, finite) else `item.weight` else `0`.
- `shift()` — Dequeue highest priority item; returns item or `undefined` if empty. FIFO on ties.
- `popLowest()` — Dequeue the item that would be delivered **last**, and return it. The exact mirror of `shift()`: lowest priority, and among equal priorities the most recently inserted. See below.
- `peek()` — View highest priority item without removal.
- `clear()` — Remove all items.
- `reset()` — Alias of `clear()`.
- `dispose()` / `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` — Release resources (clears internal state).

### Properties

- `length` / `size` — Number of items.
- `isEmpty()` — True if queue is empty.

## Examples

```js
import { PowerPriorityQueue } from 'performance-helpers/powerPriorityQueue';

const pq = new PowerPriorityQueue();
pq.push({ value: 'low', priority: 1 });
pq.push({ value: 'high', priority: 10 });
pq.push({ value: 'med', priority: 5 });
pq.shift(); // { value: 'high', priority: 10 }
pq.shift(); // { value: 'med', priority: 5 }
```

```js
// FIFO on equal priority
const pq = new PowerPriorityQueue();
pq.push('first'); // priority 0, seq 0
pq.push('second'); // priority 0, seq 1
pq.shift(); // 'first'
pq.shift(); // 'second'
```
