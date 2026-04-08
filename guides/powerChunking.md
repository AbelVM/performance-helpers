# PowerChunker

A small helper that chunks an iterable and processes items via a `PowerPool`.

Use `PowerChunker` when you have a large iterable to process and want to
parallelize the work across a managed worker pool without writing the pool
boilerplate yourself.

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `poolOptions` | `Object` | `{}` | Options forwarded to the `PowerPool` constructor (e.g. `size`, `minSize`, `maxSize`, `idleTimeout`). |
| `postOptions` | `Object` | `{}` | Options forwarded to `PowerPool.postMessageBatch` (for example `awaitResponse`, `workerId`, `timeout`). |
| `chunkSize` | `number` | `heuristic` | Explicit chunk size. When omitted the helper computes a conservative chunk size derived from `iterable.length` and pool size (aiming for roughly `poolSize * 4` in-flight chunks). |
| `fnComplexity` | `'light'\|'medium'\|'heavy'` | `auto` | Hint about per-item work complexity that biases the computed `chunkSize`. When omitted the helper will attempt to analyze `fn`'s source to infer complexity (`'light'\|'medium'\|'heavy'`) and use that to bias chunking; falls back to `'medium'` on failure. |

## API

- Returns a `PowerPool` instance managing chunked work. The helper forwards `message` events from per-chunk processing to `pool.onmessage`.

- `onmessage` / `addEventListener('message', cb)` — Receive per-chunk result events. Each event `data` contains `{ processed, results, correlationId? }`.

- `postMessageBatch(items, options)` — The helper uses the underlying pool's `postMessageBatch` for array-mode enqueues; when using streaming mode the helper internally calls `postMessage({ chunk })` for each chunk. The return value mirrors `PowerPool.postMessageBatch` (array of booleans or Promises when awaiting responses).

- `drain()` — Await until all queued and inflight chunk tasks have completed. (Inherited from returned `PowerPool` instance.)

- `terminate()` / `shutdown()` — Terminate or shutdown the underlying pool; see `PowerPool` semantics for differences.


## Example

```javascript
import { PowerChunker } from '../src/helpers/powerChunking.js';
import { PowerLogger } from '../src/helpers/powerLogger.js';

const data = Array.from({ length: 1000 }, (_, i) => ({ id: i, payload: `item-${i}` }));
function process(item) {
  // simulate per-item CPU/IO work; in production this would be heavy transform
  return { id: item.id, processed: true };
}

// Create a chunker which internally creates a `PowerPool` sized for concurrency
const pool = new PowerChunker(data, process, { poolOptions: { size: 4 } });

const logger = new PowerLogger(1);
const results = [];
const errors = [];

pool.onmessage = (e) => {
  const chunk = e && e.data;
  if (!chunk) return;
  const items = Array.isArray(chunk.results) ? chunk.results : [];
  for (const r of items) {
    if (r && r.error) {
      errors.push(r);
      logger.error('chunk item error', r);
    } else {
      results.push(r);
    }
  }
};

// Wait until the pool is idle (all queued and inflight tasks finished)
await pool.drain();
// Pretty-print errors using the per-module logger (uncomment the import above in real code)
// errors.forEach((e) => logger.error(e, 'Chunk processing errors:'));
console.log('Results:', results.length, 'Errors:', errors.length);
pool.terminate();
```

## Real-world Example — bulk CSV processing

```javascript
import { PowerChunker } from '../src/helpers/powerChunking.js';

// `readCsvRows` is a user helper that yields/returns many parsed rows.
const rows = await readCsvRows('large-export.csv');

// transform each row into the shape your backend expects
async function transformRow(row) {
  // validate/normalize fields, enrich, etc.
  return { id: row.id, ts: Date.parse(row.time), payload: row.data };
}

// Create a chunker tuned for bulk DB writes. Use chunkSize to control
// batch sizes sent to the worker-like handlers; chunker will post each
// chunk as a single task to an internal pool which processes items and
// emits a per-chunk `message` with `results`.
const pool = new PowerChunker(rows, transformRow, {
  poolOptions: { size: 4 },
  chunkSize: 500,
  postOptions: { awaitResponse: false }
});

const errors = [];
pool.onmessage = (e) => {
  const data = e && e.data;
  if (!data || !Array.isArray(data.results)) return;
  for (const r of data.results) {
    if (r && r.error) errors.push(r);
    else {
      // collect or stream to a DB bulk-inserter here
    }
  }
};

// Wait until all work finishes, then perform any final bulk write or cleanup
await pool.drain();
if (errors.length) console.error('Some rows failed', errors.length);
pool.terminate();
```

## Notes

- This helper creates inline worker-like instances that execute `fn` in a
  microtask (via `setTimeout`) so it works in environments without real Web
  Workers. For real multi-threaded CPU-bound work use a real worker source and
  a `PowerPool` directly.
- The helper returns what `PowerPool.postMessageBatch` returns: an array of
  per-chunk results (`true|false`) or Promises when `awaitResponse` is used.
- When `fnComplexity` is not provided the helper will examine the source of `fn` and attempt
 - When `fnComplexity` is not provided the helper uses a lightweight heuristic to infer complexity:
   it treats `AsyncFunction` or `GeneratorFunction` as `heavy` and uses the function's declared
   arity (number of formal parameters) as a signal; otherwise it defaults to `medium`.
   This approach avoids fragile source-parsing while providing a sensible bias for chunk sizing.
- Each `message` event `data` includes:
  - `processed`: number of items processed in the chunk
  - `results`: array of per-item return values (or error objects `{ error: true, code, message, stack }`)
  - `correlationId` when worker-level correlation was provided
