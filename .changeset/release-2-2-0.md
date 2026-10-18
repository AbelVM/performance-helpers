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
- `MetricsCollector`: `toOTLP()` exporter hook returning an OTLP-shaped JSON export (pull-based, no push); `createOperationContext` accepts `traceId`/`spanId` for trace context propagation (S-05).

- `PowerWebSocketClient`: message queue while disconnected via `messageQueueSize` option (default 0 = disabled); buffers sends while closed, flushes in order on open, drop-oldest on overflow with `droppedQueuedMessages` counter; cleared on user close/dispose (S-22).
- `PowerChunker`: `highWaterMark` option on the streaming path pauses pulling when the pool queue reaches the threshold (default `Infinity` = disabled) (S-15).
- `HyperLogLog`: sparse representation for small cardinalities (HLL++-style) — exact distinct counting until the sparse threshold is reached, then conversion to the dense register array. New `sparse` (default `true`) and `sparseThreshold` (default `registerCount * 4`) constructor options; `isDense` getter. Dense phase, public `registers`/`registerCount` contract and validation unchanged (BEAM-013 / S-01).

- `PowerCron`: `timezone` option accepting a validated IANA time zone (throws `RangeError` on an invalid zone); exposed via the `timezone` getter (E-07).

- `PowerDatagramChannel`: fragmentation for large datagrams via `fragmentSize`/`fragment` options; splits oversize datagrams into chunks, counts `fragmentedDatagrams`/`fragmentsSent` (S-25).
- `PowerServo`: auto-tuning via `autoTune({ ku, pu, method })` (Ziegler-Nichols classic and Tyreus-Luyben), plus `tune()`/`autoTuneZN()` aliases and `autoTune` constructor option (S-28).
- `PowerWebTransportClient`: QUIC stream prioritization via `streamPriority`/`sendOrder` options; datagram path via `datagrams`/`datagramFallback`/`onDatagram` and `sendDatagram()` (S-09, S-23).
- `PowerPool`: worker health-check via `healthCheck()`/`ping()` returning per-worker `{ index, pending, alive }`, plus `healthCheckIntervalMs` option (M-06).

- `PowerDefer`: `cancel(reason?)` + `cancelled` getter for cancelling a pending defer (S-16).
- `PowerEventLoopMonitor`: `longTaskThreshold` option + `PerformanceObserver` long-task detection (S-34).
- `MetricsCollector`: lazy `defaultMetrics` allocation via `Proxy` (M-03).
- `PowerCircuit`: configurable `halfOpenProbes` for half-open trial calls (R-10).
- `PowerBackpressure`: `highWaterMark` option — queued waiters at/above the threshold cause `acquire()` to reject with `ERR_QUEUE_FULL` instead of queueing; default `Infinity` (disabled) (S-30).
- `PowerHeartbeat`: `keepProcessAlive`/unref support so the timer does not keep the process alive by default (BEAM-001).
