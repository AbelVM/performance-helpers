# PowerChunking

A small helper that chunks an iterable and processes items via a `PowerPool`.

Use `PowerChunking` when you have a large iterable to process and want to
parallelize the work across a managed worker pool without writing the pool
boilerplate yourself.

## Consructor

| option | type | default | description |
|---|---:|---:|---|
| `poolOptions` | `Object` | `{}` | Options forwarded to the `PowerPool` constructor (e.g. `size`, `minSize`, `maxSize`, `idleTimeout`). |
| `postOptions` | `Object` | `{}` | Options forwarded to `PowerPool.postMessageBatch` (for example `awaitResponse`, `workerId`, `timeout`). |
| `chunkSize` | `number` | `heuristic` | Explicit chunk size. When omitted the helper computes a conservative chunk size derived from `iterable.length` and pool size (aiming for roughly `poolSize * 4` in-flight chunks). |
| `fnComplexity` | `'light'\|'medium'\|'heavy'` | `auto` | Hint about per-item work complexity that biases the computed `chunkSize`. When omitted the helper will attempt to analyze `fn`'s source to infer complexity (`'light'\|'medium'\|'heavy'`) and use that to bias chunking; falls back to `'medium'` on failure. |

## Example

```javascript
const data = Array.from({ length: 1000 }, (_, i) => i);
function process(item) {
  // CPU or IO work per item
  // e.g. heavy transform, network call, etc.
}

// Fire-and-forget batching (returns a `PowerPool` instance)
const pool = PowerChunking(data, process, { poolOptions: { size: 4 } });

// Use `pool.onmessage` to gather per-chunk results and `pool.drain()` to wait
// for completion. `PowerChunking` enqueues the chunk tasks internally when
// invoked and returns the pool so you can observe and await completion.
// Create a per-module `PowerLogger` and emit each item error; the logger
// will format error objects for you via `formatErrorObj` internally.
// import { PowerLogger } from '../src/helpers/powerLogger.js';
// const logger = new PowerLogger(1);
const results = [];
const errors = [];
pool.onmessage = (e) => {
  if (e && e.data) {
    const chunk = e.data;
    const items = Array.isArray(chunk.results) ? chunk.results : [];
    const good = items.filter((r) => !r || !r.error);
    const bad = items.filter((r) => r && r.error);
    results.push(...good);
    errors.push(...bad);
  }
};

// Wait until the pool is idle (all queued and inflight tasks finished)
await pool.drain();
// Pretty-print errors using the per-module logger (uncomment the import above in real code)
// errors.forEach((e) => logger.error(e, 'Chunk processing errors:'));
console.log('Results:', results.length, 'Errors:', errors.length);
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
to infer whether per-item work is `light`, `medium` or `heavy`. The auto-analysis looks for
indicators such as loops, common expensive operations (JSON, regex, sorting) and recursion.
If analysis succeeds the inferred complexity is used to bias the computed `chunkSize`.
If analysis fails the helper safely falls back to `'medium'`.
- Each `message` event `data` includes:
  - `processed`: number of items processed in the chunk
  - `results`: array of per-item return values (or error objects `{ error: true, code, message, stack }`)
  - `correlationId` when worker-level correlation was provided
