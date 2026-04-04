# PowerQueue

A resizable ring-buffer queue with O(1) enqueue/dequeue. Useful as a high-performance replacement for `Array#push`/`Array#shift` when building queues under sustained load.

## Constructor

`new PowerQueue(initialCapacity?)`

| option | type | default | description |
|---|---:|---:|---|
| `initialCapacity` | `number` | `16` | Initial capacity (will be rounded up to a power-of-two). The queue automatically grows when full.

## Methods

| method | params | returns | description |
|---|---|---|---|
| `push(item)` | `item: any` | `number` | Enqueue `item`. Returns new length.
| `shift()` | — | `any` | Dequeue and return head item, or `undefined` when empty.
| `peek()` | — | `any` | Inspect the head item without dequeuing.
| `clear()` | — | `void` | Remove all items.
| `length` | — | `number` | Current number of items (getter).
| `capacity` | — | `number` | Internal buffer capacity (getter).
| `isEmpty` | — | `boolean` | True when empty (getter).

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
