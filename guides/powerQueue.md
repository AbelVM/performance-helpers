# PowerQueue

A resizable ring-buffer queue with O(1) enqueue/dequeue. Useful as a high-performance replacement for `Array#push`/`Array#shift` when building queues under sustained load.

## Constructor

`new PowerQueue(initialCapacity?)`

| option            |     type | default | description                                                                                       |
| ----------------- | -------: | ------: | ------------------------------------------------------------------------------------------------- |
| `initialCapacity` | `number` |    `16` | Initial capacity (will be rounded up to a power-of-two). The queue automatically grows when full. |

## API

- `push(item)` — Enqueue `item` at the tail. Returns the new queue length as a `number`.

- `shift()` — Dequeue and return the head item, or `undefined` when the queue is empty.

- `peek()` — Inspect the head item without removing it; returns `any` or `undefined`.

- `clear()` — Remove all items from the queue immediately; useful for shutdown or resetting state.

- `length` (getter) — Current number of items in the queue (`number`).

- `capacity` (getter) — Internal buffer capacity (power-of-two sized) used by the ring buffer (`number`).

- `isEmpty` (getter) — `true` when the queue contains no items.

- `pushMany(items)` — Enqueue multiple items in one call. The implementation grows the backing buffer at most once and copies items efficiently; returns the new queue length.

- `fill(item, count)` — Enqueue `count` copies of `item`. Equivalent to
  `pushMany(Array(count).fill(item))` without the temporary array, for the case
  where every value is the same.

- `shrink(minimum = 16)` — Give back the memory a burst grew, and return the
  capacity afterwards.

### Reclaiming a burst

The buffer only ever grows, so a queue that held 5 000 items once keeps an
8 192-slot buffer for the rest of its life. `clear()` empties the slots but does
not release them, which is right for a container whose purpose is bounding
memory — so shrinking is **explicit**:

```javascript
queue.push(...burstOfFiveThousand);
await drain(queue);

// Still 8192 here. This is the line that gives it back.
queue.shrink(); // => 16
```

`minimum` is a floor for a queue expected to refill to a known size, so steady
traffic does not reallocate every cycle; it is rounded up to a power of two, and
is never below the current length, so nothing is ever dropped.

`PowerSlidingWindow` uses this on your behalf: its timestamps live in a
`PowerQueue`, and it shrinks when a window ages out. `shrink()` is not automatic
inside `shift()` on purpose — that would put a comparison and a branch on every
dequeue forever to reclaim memory only after a burst, and a caller that has just
finished a burst is the one that knows when to pay.

- `unshiftMany(items)` — Prepend multiple items to the head so that `items[0]` becomes the next value returned by `shift()`. Efficient for bulk prepends.

- `values()` — Non-destructive iterator of values (alias of the default iterator, i.e. `[Symbol.iterator]`).

- `keys()` — Non-destructive iterator of zero-based indexes (0 is the head).

- `entries()` — Non-destructive iterator yielding `[index, value]` pairs.

- `drain()` — Consuming generator that yields items in FIFO order and removes them from the queue as iterated.

- `toArray()` — Return a shallow array snapshot of the queue contents in FIFO order (non-destructive).

## Example

```javascript
import { PowerQueue } from '../src/helpers/powerQueue.js';

const q = new PowerQueue(16);

async function processStream(readable) {
  for await (const chunk of readable) {
    q.push(chunk);
    if (q.length >= 32) {
      await flushQueue();
    }
  }
  await flushQueue();
}

async function flushQueue() {
  for (const item of q.drain()) {
    await writeRecord(item);
  }
}
```

### Batch examples

```javascript
const q = new PowerQueue(4);
q.pushMany([1, 2, 3, 4]);
console.log(q.length); // 4

// Prepend so items are processed first-in-first-out when a higher-priority batch arrives.
q.unshiftMany(['priority-a', 'priority-b']);
for (const item of q.drain()) {
  console.log(item);
}
```

## Real-world Example — buffering for worker dispatch

```javascript
import { PowerQueue } from '../src/helpers/powerQueue.js';
import { PowerPool } from '../src/helpers/powerPool.js';

// Use PowerQueue as a lightweight buffer before dispatching to a worker pool
const q = new PowerQueue(64);
const pool = new PowerPool('./worker.js', { size: 2, maxSize: 4 });

// Efficiently enqueue many items
q.pushMany(itemsArray);

// Drain and dispatch with simple error handling
async function flushQueue() {
  for (const item of q.drain()) {
    try {
      // fire-and-forget; pool will queue or dispatch according to its policy
      pool.postMessage(item);
    } catch (err) {
      console.error('dispatch failed, requeuing or persisting', err);
      // requeue or persist for later retry
      q.push(item);
    }
  }
}

// Use periodically or on demand
setInterval(() => {
  if (!q.isEmpty) flushQueue();
}, 250);
```
