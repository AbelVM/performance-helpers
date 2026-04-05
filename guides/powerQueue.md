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
| `pushMany(items)` | `Array<any>` | `number` | Enqueue multiple items in one call. Grows buffer once and copies items efficiently. Returns new length.
| `unshiftMany(items)` | `Array<any>` | `number` | Prepend multiple items so the first element becomes the next `shift()` result. Grows buffer once and copies items efficiently. Returns new length.

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
