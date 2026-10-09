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

## API

### new PowerPriorityQueue(initialCapacity)

- `initialCapacity` (number|object, optional): initial backing store size; rounded up. If passed `{ initialCapacity }`, known options asserted.

### Methods

- `push(item)` — Enqueue item; returns new size. Item priority is taken from `item.priority` (number, finite) else `item.weight` else `0`.
- `shift()` — Dequeue highest priority item; returns item or `undefined` if empty. FIFO on ties.
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
