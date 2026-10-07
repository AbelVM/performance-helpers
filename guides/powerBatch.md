# PowerBatch

Microtask-coalescing dispatcher that collects synchronous `add()` calls and
dispatches them as a single batch to the provided handler in the next microtask.
Useful for coalescing DB writes, network calls, or other I/O that benefits from batching.

## Constructor

`new PowerBatch(handler, options?)`

## Options

| Option       |                                   Type |       Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------: | ------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSize`    |                               `number` |    `Infinity` | When the queue reaches `maxSize`, the batch flushes immediately.                                                                                                                                                                                                                                                                                                                                                                |
| `scheduling` | `'microtask'`\|'macrotask'`\|`'yield'` | `'microtask'` | Which queue the batch dispatch is scheduled on, **passed straight to `PowerScheduler`**. `'microtask'` coalesces via `queueMicrotask`, `'macrotask'` via a `MessageChannel` post, and `'yield'` uses the native `scheduler.yield()` continuation, which the scheduler prioritises. An unrecognised value **throws** rather than being coerced to a default. Default is `'microtask'` to match low-latency coalescing semantics. |
| `onError`    |                        `function(err)` |             — | Called when the handler rejects with no pending promise to reject — a scheduler-driven flush rather than an `add()`-triggered one. Without it that error had nowhere to go.                                                                                                                                                                                                                                                     |

### Cancelling the wait

`flush({ signal })` stops _waiting_. It does not cancel the flush: the items
already queued still belong to the callers who passed them to `add()`, and
those promises still resolve when the batch goes out. Rejecting the shared
pending promise instead would break every queued caller with a cancellation
they did not ask for.

```js
const controller = new AbortController();
const flushed = batch.flush({ signal: controller.signal });
controller.abort();
await flushed; // rejects: AbortError - but the batch still flushes
```

An already-aborted signal rejects without flushing at all.

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
import { PowerBatch } from 'performance-helpers/powerBatch';
import { getDbClient } from './db'; // user helper returning a pooled client

const writer = new PowerBatch(
  async (items) => {
    const db = await getDbClient();
    try {
      // perform a single bulk upsert for many small events
      await db.bulkUpsert('events', items);
    } finally {
      db.release();
    }
  },
  { maxSize: 500 }
);

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
