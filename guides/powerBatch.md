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
| `scheduling` | `'microtask'\|'macrotask'` | `'microtask'` | Choose whether the batch dispatch is scheduled on the microtask queue (`queueMicrotask`) or macrotask queue (`setTimeout(…,0)`). Default is `'microtask'` to match low-latency coalescing semantics.

## API

- `add(item)` — Add an item to the current batch. `add()` always returns a `Promise<void>` that resolves when the batch containing the item has been processed.
  - When the item is added without immediately flushing the batch, the Promise resolves after the scheduled microtask/macrotask run completes and the handler finishes.
  - When the item causes the batch to reach `maxSize`, the batch flushes immediately and `add()` resolves or rejects only after the handler has completed processing that batch.
  - In practice this means `add()` can be treated as fire-and-forget for normal batching, while still providing a completion promise when needed.

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

## Caveat: awaiting between `add()` calls

When using the default microtask scheduling (`scheduling: 'microtask'`), `PowerBatch` coalesces synchronous `add()` calls within the same microtask. If you `await` an `add()` (or otherwise yield to the event loop) between calls, the batch will be flushed before the subsequent `add()` — resulting in multiple handler invocations.

Example:

```javascript
const calls = [];
const b = new PowerBatch((items) => calls.push(items.slice()));

// These two calls are synchronous and will be coalesced into one batch:
b.add(1);
b.add(2);

// Awaiting here yields to the microtask queue, so the batch runs before the next add.
await b.add(3);

// This call runs in the next microtask and starts a new batch.
b.add(4);

await b.flush();
// calls -> [[1,2,3], [4]] when using 'microtask' scheduling
```

If you need the older macrotask semantics (or want awaiting not to flush early), construct with `{ scheduling: 'macrotask' }`.
