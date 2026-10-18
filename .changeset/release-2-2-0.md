---
'performance-helpers': minor
---

- `PowerOperationContext`: async-local propagation via `runOperationContext` / `getOperationContext` / `withOperationContext` (S-37), using `node:async_hooks` `AsyncLocalStorage` with a browser fallback.
- `PowerPool.drain()`: optional `onProgress` callback + `drain:progress` events reporting `{ activeTasks, queueLength }` (R-09).

- `PowerBrownout`: adaptive threshold via `adaptive` option (AIMD adjustment on `setPressure`, EWMA tracking, `baseThreshold`/`pressureEwma` in stats) (S-31).
- `PowerMessagePort`: zero-copy transfer support — `send(sub, frame, transfer)`, `postMessage(value, transfer)`, `transferPort(port)` (S-27).
- `PowerBackpressure`: async-iterable interface via `[Symbol.asyncIterator]()` yielding release callbacks (S-04).
- `PowerTaskGroup`: structured concurrency scope — `run`/`spawn`/`all`/`cancel`/`dispose`, shared `AbortSignal`, `cancelOnError` option, `using`/`await using` support (S-06).
- `PowerTTLMap`: bounded memory via `maxSize` option with least-recently-used eviction on `set()`; `get()`/`touch()`/re-`set()` mark a key most-recently-used. `0` (default) keeps the map unbounded (M-04).
- `PowerRealtimeHub`: `presence(topic?)` / `getPresence(topic?)` alias returning a snapshot array of `{ id, topic, transport }` for live subscribers, optionally filtered by topic (S-19).

- Status reconciliation (pass 3): P-10 and S-24 confirmed already implemented.

- `PowerCache`: `load(snapshot)` prefill API accepting `[key, value]`, `[key, value, { ttl, weight }]`, `{ key, value, ttl?, weight? }` and `Map` entries; routes through `set()` so admission policy, TTL and weight apply; returns accepted count (M-05 / S-11).

- `PowerBufferPool`: reusable `Uint8Array` buffer pool with size buckets, `acquire(size)`/`release(buf)`, per-bucket and total caps, zeroing on reuse, `stats()` and `using`/`await using` support (S-17).
- `PowerBackpressure`: `highWaterMark` option — number of queued waiters at or above which `acquire()` rejects with `ERR_QUEUE_FULL` instead of queueing, for fail-fast overload protection. Default `Infinity` (disabled). Reported in `stats()` (S-30).
