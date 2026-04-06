# PowerQueue

A resizable ring-buffer queue with O(1) enqueue/dequeue. Useful as a high-performance replacement for `Array#push`/`Array#shift` when building queues under sustained load.

## Constructor

`new PowerQueue(initialCapacity?)`

| option | type | default | description |
|---|---:|---:|---|
| `initialCapacity` | `number` | `16` | Initial capacity (will be rounded up to a power-of-two). The queue automatically grows when full.

## API

- `push(item)` — Enqueue `item` at the tail. Returns the new queue length as a `number`.

- `shift()` — Dequeue and return the head item, or `undefined` when the queue is empty.

- `peek()` — Inspect the head item without removing it; returns `any` or `undefined`.

- `clear()` — Remove all items from the queue immediately; useful for shutdown or resetting state.

- `length` (getter) — Current number of items in the queue (`number`).

- `capacity` (getter) — Internal buffer capacity (power-of-two sized) used by the ring buffer (`number`).

- `isEmpty` (getter) — `true` when the queue contains no items.

- `pushMany(items)` — Enqueue multiple items in one call. The implementation grows the backing buffer at most once and copies items efficiently; returns the new queue length.

- `unshiftMany(items)` — Prepend multiple items to the head so that `items[0]` becomes the next value returned by `shift()`. Efficient for bulk prepends.
 
- `values()` — Non-destructive iterator of values (alias of the default iterator).

- `keys()` — Non-destructive iterator of zero-based indexes (0 is the head).

- `entries()` — Non-destructive iterator yielding `[index, value]` pairs.

- `drain()` — Consuming generator that yields items in FIFO order and removes them from the queue as iterated.

- `toArray()` — Return a shallow array snapshot of the queue contents in FIFO order (non-destructive).

## Example

```javascript
import { PowerQueue } from '../src/helpers/powerQueue.js';

const q = new PowerQueue(8);
q.push(1);
q.push(2);
console.log(q.shift()); // 1
console.log(q.peek()); // 2
q.clear();
```

### Batch examples

```javascript
const q = new PowerQueue(4);
q.pushMany([1,2,3,4]);
console.log(q.length); // 4

// Prepend so 'a' will be returned first
q.unshiftMany(['a','b']);
console.log(q.shift()); // 'a'
console.log(q.shift()); // 'b'
console.log(q.shift()); // 1
```
