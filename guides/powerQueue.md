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
