# PowerBatch

Microtask-coalescing dispatcher that collects synchronous `add()` calls and
dispatches them as a single batch to the provided handler in the next microtask.
Useful for coalescing DB writes, network calls, or other I/O that benefits from batching.

## Constructor

`new PowerBatch(handler, options?)`

## Options

| Option | Type | Default | Description |
|---|---:|---:|---|
| `maxSize` | `number` | `Infinity` | When the queue reaches `maxSize`, the batch flushes immediately. |

## API

- `add(item)` — Add an item to the current batch. In normal usage `add()` returns a resolved `Promise<void>` (fire-and-forget) to avoid forcing callers to await handler completion; however if adding the item causes the batch to immediately flush (for example, when `maxSize` is reached) `add()` will return the same `Promise` returned by `flush()` and resolve/reject with the handler outcome. Use `flush()` explicitly when you always need a guaranteed handler-completion promise.

- `flush()` — Returns a `Promise<void>` that forces an immediate flush of the current queued items and resolves once the handler has completed processing the flushed batch.

- `clear()` — Synchronously drop any queued items without invoking the handler. Useful for shutdown or when discarding buffered work.

- `size` (getter) — Returns the `number` of items currently queued and awaiting dispatch.

## Example

```javascript
// Realistic example — batching DB upserts with connection pooling
import { PowerBatch } from '../src/helpers/powerBatch.js';
import { getDbClient } from './db'; // user helper returning a pooled client

const writer = new PowerBatch(async (items) => {
  const db = await getDbClient();
  try {
    // perform a single bulk upsert for many small events
    await db.bulkUpsert('events', items);
  } finally {
    db.release();
  }
}, { maxSize: 500 });

// coalesce many synchronous events into fewer DB calls
for (const ev of incomingEvents()) {
  // add returns a Promise that resolves when this batch is processed
  writer.add(ev).catch((err) => console.error('batch write failed', err));
}

// on shutdown flush remaining work
await writer.flush();
```
