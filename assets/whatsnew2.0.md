## What's new in v2.3.0

Cross-realm correctness, transport robustness, and a large type-safety pass. The
[changelog](../CHANGELOG.md) has the full list; this note covers what changes how
you use the library.

### Realtime transports

- **`PowerWebSocketClient` / `PowerWebTransportClient`**: the `rtt` option now
  accepts a `PowerHistogram` from another realm (cross-realm `instanceof`
  replaced with an internal-slot check).
- **`PowerWebTransportClient`**: `streamPriority` is now actually applied to the
  bidirectional stream.
- **`PowerSocketAdapter`**: `_attachStream()` no longer produces an unhandled
  rejection.
- **`PowerDatagramChannel`**: `maxDatagramSizeBytes` is now enforced per chunk
  during fragmentation; `dispose()` flushes the queue like `close()`.
- **`PowerSseAdapter`**: Node `write()` backpressure honoured; `btoa` guarded
  with a Buffer fallback.
- **`PowerMessagePort`**: metrics detached on external close.
- **`PowerRealtimeHub`**: `publish()` returns the accepted count.

### Worker pool

- Readiness guard added to `postMessageBatch` fast path.
- `_dispatchQueuedTasks` now skips past-deadline/aborted items and iterates
  ready workers.
- `WorkerWrapper.postMessage` no longer synthesises a transfer list (silent data
  loss fix).
- `pool:scale` emitted on all removal paths; stable removal in
  `_handleWorkerExit`; `healthCheck()` distinguishes crashed vs retired workers.

### Caching

- `PowerCache.clear()` clears `_inflightControllers`.
- `size`/`entries()`/`invalidate()` agree under S3-FIFO (Small + Ghost walked).
- Weight check in `_arbitrateWindow`.
- `PowerTTLMap`: `_nextExpiryAt`/`_nextExpiryDirty` wired in.

### Concurrency

- `PowerPermitGate`: `FinalizationRegistry`-based lease cleanup (covers
  `PowerSemaphore`, `PowerBulkhead`, `PowerPermitGate`).
- TOCTOU fixes on waiter timeouts across `PowerBulkhead`, `PowerSemaphore`,
  `PowerCrossLock`, `PowerPermitGate`.
- `PowerCircuit`: atomic HALF_OPEN transition, listeners wrapped in try/catch,
  reset timer cleared on dispose.
- `PowerCircuit.call()` now accepts an `AbortSignal`.

### Type safety

- Replaced `@type {any}` escape hatches with precise types in
  `powerSseAdapter` and `powerSocketAdapter`.

### Measurement

- Property-based (fast-check) invariants extended to `PowerPool` and
  `PowerRealtimeHub`.

---

## What's new in v2.2.0

Structured concurrency, a reusable buffer pool, async-local operation context,
and a long list of smaller, measured improvements. The [changelog](../CHANGELOG.md)
has the full list; this note covers what changes how you use the library.

### New helpers

- **`PowerTaskGroup`** (also called a `Scope`) — structured concurrency. Owns an
  `AbortController` and a set of in-flight tasks; every task receives the scope's
  `AbortSignal`, and on dispose (or on a task rejection with `cancelOnError`)
  all siblings are aborted and awaited. Supports `using` / `await using`.
- **`PowerBufferPool`** — a reusable `Uint8Array` buffer pool with size buckets,
  `acquire(size)` / `release(buf)`, per-bucket and total caps, zeroing on reuse,
  `stats()`, and `using` / `await using` support. A buffer must not be used after
  `release()`.
- **`createOperationContext`** — explicit operation coordination. Carries
  deadlines, cancellation, retry budgets, correlation ids, priority, and trace
  context (`traceId` / `spanId`) as plain data, with no hidden global state.
- **`ReconnectPolicy`** — the shared decorrelated-jitter backoff curve the
  reconnecting transports compose. Behaviour-preserving.

### Worker pool

- **`healthCheck()` / `ping()`** — per-worker `{ index, pending, alive }`, plus
  a `healthCheckIntervalMs` option.
- **`drain({ onProgress })`** — graceful shutdown with progress events reporting
  `{ activeTasks, queueLength }`.
- **`messageQueueSize`** on `PowerWebSocketClient` — buffers sends while closed,
  flushes in order on open, drop-oldest on overflow with a
  `droppedQueuedMessages` counter.
- **`highWaterMark`** on `PowerChunker`'s streaming path — pauses pulling when
  the pool queue reaches the threshold (default `Infinity`, disabled).

### Caching

- **`PowerCache.load(snapshot)`** — prefill from `[key, value]`,
  `[key, value, { ttl, weight }]`, `{ key, value, ttl?, weight? }` or `Map`
  entries. Routes through `set()` so admission policy, TTL and weight apply.
- **`PowerTTLMap`** gains a `maxSize` option with LRU eviction on `set()`;
  `get()` / `touch()` / re-`set()` mark a key most-recently-used. `0`
  (default) keeps the map unbounded.

### Realtime

- **`PowerRealtimeHub.presence(topic?)`** / `getPresence(topic?)` — snapshot
  array of `{ id, topic, transport }` for live subscribers, optionally filtered
  by topic.
- **`PowerDatagramChannel`** gains `fragmentSize` / `fragment` options — splits
  oversize datagrams into chunks, counts `fragmentedDatagrams` / `fragmentsSent`.
- **`PowerWebTransportClient`** gains QUIC stream prioritization
  (`streamPriority` / `sendOrder`) and a datagram path
  (`datagrams` / `datagramFallback` / `onDatagram` / `sendDatagram()`).
- **`PowerServo`** gains `autoTune({ ku, pu, method })` (Ziegler-Nichols
  classic and Tyreus-Luyben), plus `tune()` / `autoTuneZN()` aliases and an
  `autoTune` constructor option.
- **`PowerCron`** gains a `timezone` option accepting a validated IANA time
  zone (throws `RangeError` on an invalid zone).
- **`PowerMessagePort`** gains zero-copy transfer support — `send(sub, frame,
transfer)`, `postMessage(value, transfer)`, `transferPort(port)`.

### Observability

- **`MetricsCollector.toOTLP()`** — an OTLP-shaped JSON export (pull-based, no
  push); `createOperationContext` accepts `traceId` / `spanId` for trace context
  propagation.
- **Lazy `defaultMetrics`** allocation via `Proxy` — no module-load cost when
  unused.
- **`PowerEventLoopMonitor`** gains `longTaskThreshold` plus
  `PerformanceObserver` long-task detection.
- **`PowerCircuit`** gains a configurable `halfOpenProbes` for half-open trial
  calls.
- **`PowerBackpressure`** gains `highWaterMark` — queued waiters at or above the
  threshold cause `acquire()` to reject with `ERR_QUEUE_FULL` instead of
  queueing (default `Infinity`, disabled).

### Concurrency and resilience

- **`PowerDefer`** gains `cancel(reason?)` + a `cancelled` getter.
- **`PowerBrownout`** gains an `adaptive` option (AIMD adjustment on
  `setPressure`, EWMA tracking).
- **`PowerBackpressure`** gains an async-iterable interface via
  `[Symbol.asyncIterator]()` yielding release callbacks.

### Cardinality

- **`HyperLogLog`** gains a sparse representation for small cardinalities
  (HLL++-style): exact distinct counting until the sparse threshold is reached,
  then conversion to the dense register array. New `sparse` (default `true`) and
  `sparseThreshold` (default `registerCount * 4`) constructor options, plus an
  `isDense` getter. The dense phase, the public `registers` / `registerCount`
  contract and validation are unchanged. Bias-correction tables and 6-bit packed
  registers were measured and rejected — see the review notes.

### Measurement

- **`bench/claims.js cardinality`** is the gate for the HyperLogLog work: the
  shipped sketch (m=64) reads 13.93 % relative error at n=100k against a
  theoretical 13.00 %, and the bias-correction tables were measured to
  over-correct in the transition region, so they are not shipped.

---

## What's new in v2.1.0

Seven new helpers, a worker pool that survives a dead worker, and a cache
admission filter that finally adapts. The [changelog](../CHANGELOG.md) has the
full list; this note covers what changes how you use the library.

### New helpers

- **`PowerPriorityQueue`** — a binary heap dequeuing highest priority first, FIFO
  on ties, with `popLowest()` for bounded eviction from the other end. It is also
  what `PowerPool` now dispatches from under saturation, which is why that path
  dropped from O(n) to O(log n) per dispatch.
- **`PowerDeduplication`** — time-windowed duplicate suppression with a TTL, a
  `maxKeys` cap, and an injectable clock.
- **`PowerHeartbeat`** — jittered liveness detection. Jitter is applied to the
  scheduled check rather than the deadline, so a peer beating on time is never
  failed for arriving early.
- **`PowerSequencer`** — gap detection and in-order reassembly for out-of-order
  datagrams. `missing()` is the list a NACK would carry.
- **`PowerFlowControl`** — an adaptive token bucket whose refill rate is the
  output of a `PowerServo`. The servo's bounds are the rate bounds, so the
  controller cannot ask for a rate the bucket would refuse.
- **`PowerFlowController`** — admission, a bounded queue and tail-latency
  feedback in one closed loop. `bench/claims.js flowloop` measures it against a
  fixed rate: the closed loop is worth building, and its gain band is narrow.
- **`PowerApdex`** — APDEX scoring over three integer counters. It deliberately
  does not derive its score from a `PowerHistogram`: the derived version reads
  0.625 where the truth is 0.950 when the mass sits at the threshold, and the
  error is not monotonic in `relativeAccuracy`, so no accuracy setting repairs
  it. See [ADR 0014](../adr/0014-apdex-counters-not-a-sketch.md).

### Worker pool

- **A dead worker is now detected, settled and replaced.** Before this a worker
  that died was simply absent, and the pool looked closed while the last few
  tasks were gone. A `pool:worker:exit` event reports it.
- **`close({ force, timeout })`** — graceful shutdown as a single entry point.
  `shutdown()` alone abandons in-flight work and `drain()` alone leaves the
  workers running; getting the order wrong is silent.
- **`ready`** — a readiness gate holding a worker out of dispatch until it
  signals it has initialised, so a task never reaches a worker still starting up.
- **`maxQueueLength: 'auto'`** resolves the cap to `maxSize ** 2`. `Infinity`
  remains the default: a cap that silently appears is a cap nobody chose.
- **`recordTiming`** opts in to percentile telemetry (`p50`/`p90`/`p99`/`p999`
  plus `utilization`). Off by default, and the default path pays nothing.
- **`loadBalancer`** — a caller-supplied worker-selection policy over a frozen
  per-worker view. The default least-loaded-plus-EWMA rule is not replaced.
- **A per-task `signal`** on `postMessage`. Aborting while in flight releases the
  waiter now and lets the work finish, rather than terminating a worker that may
  be carrying several other tasks.

### Caching

- **`admission: 'tinylfu'` can now adapt to a working set that changes.** Two
  defects had made it unable to: a refused key was never recorded in the sketch,
  and the sketch's half-life clock stopped once its counters saturated. The
  `zipf` row now reads 93.0 % working-set hit rate against SLRU's 89.4 %, rather
  than losing to it. TinyLFU is still off by default.
- **`missCost`** — weight eviction by what a miss costs, bounded by a
  `missCostScan` width.
- **S3-FIFO** no longer serves stale evicted values, exceeds `maxEntries`, or
  leaks weight on every Small-queue exit.

### Rate limiting and resilience

- **`reserveAsync(n, options)`** — the awaiting counterpart to `reserve()`, for
  an async `sharedState` adapter. `reserve()` now **throws** a `TypeError` when
  the adapter is async rather than returning `null`, because "you were denied"
  and "I could not find out" need different handling.
- **`PowerRateLimit.dispose()`** now disposes the per-slot limiters it built.
- **`PowerGCRA.setRate(rate)`** changes the sustained rate at runtime.
- **`PowerSlidingWindow`** no longer reallocates its ring on every window
  boundary.
- **`PowerRateLimit.stats().legErrors`** counts legs whose `available()` threw,
  which used to be indistinguishable from "rate limited". Non-zero means the
  limiter is broken, not busy.

### Realtime

- **`messagePriority`** on `PowerRealtimeHub` orders each subscriber's queue by
  the `priority` passed to `publish()`. Off by default; FIFO is unchanged.
- **`PowerRTCChannel`** gains `lowWaterMarkBytes` and `queueBudget`, plus
  `queuedBytes` / `queuedFrames` — back-pressure that arrives as a push signal
  instead of a poll timer.
- **`createSseAdapter`** no longer drops every event emitted during a reconnect
  gap: it emits an `id:` field with every frame, so a browser `EventSource` sends
  `Last-Event-ID` on reconnect, and `lastEventId(sub)` / `lastSentId(sub)` expose
  both ends of it. Replaying is the caller's — the adapter holds no buffer.

### Observability

- **`PowerHistogram.countAtOrBelow(value)`** — the inverse of `percentile()`.
  Shipped as a general rank query and documented as unsound for an SLO
  attainment figure, with the number.
- **`HyperLogLog`** takes a register count, defaulting to 64 so nothing changes
  for an existing caller. Two bias defects had made this impossible before.
- **`PowerHistogram.merge()`** now accepts a cross-realm sketch or a plain
  `toJSON()` result. `structuredClone` does not preserve the class, so a sketch
  arriving from a worker was rejected with "expects a PowerHistogram" — the
  headline distributed use case was unreachable without hand-rolling
  reconstruction.

### Lifecycles and correctness

- **`Symbol.asyncDispose`** on the classes that were missing it, so every
  long-lived helper takes part in `await using` teardown.
- **`PowerQueue.dispose()`** releases the ring buffer. A queue that took 5 000
  items once kept an 8 192-slot buffer for life; `clear()` empties the slots but
  deliberately keeps the array, which is right for a container bounding memory
  and wrong for one being torn down.
- **Six cross-realm `instanceof` defects fixed**, found by grepping the defect
  class rather than the site. Both obvious answers are wrong cross-realm, and a
  `Symbol.toStringTag` check is spoofable — what ships is the spec's own
  internal-slot accessor.

### Measurement

Eight new `bench/claims.js` modes, and **five of them reject the feature they
were written to evaluate** — nothing in `src/` changed as a result:

```sh
node bench/claims.js blockqueue    # a block-chained queue against the shipped ring
node bench/claims.js namedexport   # postMessage's `name` option
node bench/claims.js messageport   # a dedicated MessageChannel per worker
node bench/claims.js geocoalesce   # a coalescer against PowerBatch + a Map
node bench/claims.js geoprefetch   # a camera-prefetch helper — the window is the wrong knob
```

`flowloop` is the one that says build it: the fixed control sits at 2.4× the
target latency after a capacity step, and the defaults settle on the closed-form
equilibrium. The five above are recorded as rejected in ADRs 0017, 0018, 0019 and
0015, with the measurements that killed them.

---

## What's new in v2.0.0

Version 2.0 consolidates the worker protocol, realtime transports, resilience
helpers, observability, lifecycle management, and published TypeScript types.
The [changelog](../CHANGELOG.md) lists the release at a glance; this note gives
the migration-relevant detail.

### Breaking changes

- **Invalid configuration fails fast.** Non-finite, fractional, and
  out-of-range numeric options now throw instead of being silently coerced.
  Valid zero values remain supported.
- **Worker messages are framed by default.** `PowerPool` workers must reply in
  the framing they receive. Use `messageCodec: 'legacy'` during migration; see
  [`guides/powerPool.md`](../guides/powerPool.md).
- **Histograms are more accurate.** `PowerHistogram` now uses DDSketch with
  configurable `relativeAccuracy` and an unbounded range. `maxValue` and
  bucket-count options are removed; histograms can now be merged.
- **Durations use a monotonic clock.** Rate limiters and circuits use
  `monoMs()`. Inject `now` in tests instead of faking `Date.now()`; wall-clock
  timestamps still use `nowMs()`.
- Removed `PowerCache.hasEqualWithSeen()` and the `seen` option.
- `PowerTTLMap.size` is now a pure O(1) read. Use `purge()` for cleanup and
  `expiredCount` for diagnostics.
- `admission: 'tinylfu'` is ignored with `policy: 'slru'`. The W-TinyLFU
  admission window is not included; see [ADR 0003](../adr/0003-tinylfu-admission-window.md).

### New helpers and capabilities

- **Reliable messaging:** `PowerMessageCodec` adds versioned frames, native
  structured-clone negotiation, and incremental decoding.
- **Realtime building blocks:** `PowerRealtimeHub` handles topic fan-out with
  bounded queues and slow-consumer policies. `PowerSocketAdapter` gives Node
  `ws`, browser `WebSocket`, and `WebSocketStream` one consistent interface.
- **Resilient transports:** WebSocket, WebTransport, and SSE helpers now share
  reconnect, heartbeat, lifecycle, and stream-error handling.
- **Smarter resilience:** `PowerGCRA` provides exact retry timing; `PowerRetry`
  adds decorrelated backoff, retry budgets, and optional first-attempt hedging;
  pool autoscaling adds `aimd`, `vegas`, and `gradient2` policies.
- **Operational visibility:** `PowerCron` and `PowerEventLoopMonitor` make
  scheduling and event-loop health measurable, while metrics observations and
  Prometheus formatting stay dependency-free.
- **Composable state:** `PowerObserver` adds derived values, stable snapshots,
  error routing, and framework-neutral React, Vue, and Angular recipes.
- **Safer lifecycles:** Resource-owning helpers support `dispose()` and
  `[Symbol.dispose]()`, and waiting APIs accept `AbortSignal` cancellation.

### Performance and reliability

- **More resilient caching:** `PowerCache` adds SLRU admission and diagnostics
  for failed or cancelled refreshes. TinyLFU remains experimental after its
  earlier performance claim failed reproducible measurement.
- **Safer worker pools:** `PowerPool` enforces adaptive limits, bounds queued
  work, limits drain waiters, preserves batch atomicity, and separates worker
  and aggregate idle data. Late worker replies no longer corrupt accounting.
- **Lean batch dispatch:** `postMessageBatch()` avoids repeated orchestration.
  Cached payloads are retained by default rather than sliced for transfer; this
  is an isolated preparation change, not an end-to-end speedup claim.
- **Steadier scheduling:** `PowerCircuit` grows and jitters repeated open
  windows. `PowerScheduler` supports native yielding and unclamped
  `MessageChannel` macrotasks where available.
- **Cleaner shutdown:** Internal timers use `unref()` by default. Use
  `keepProcessAlive` where provided when a process must stay alive.

### Fixes

- **Pools:** Fixed shutdown, draining, cancellation, correlation IDs, worker
  replies, queue limits, and worker loading.
- **Limiters:** Fixed batch ceilings, retry delays, non-finite counts, atomic
  rate limiting, permit accounting, and cancellation.
- **Caches:** Fixed refresh retention, deep-equality limits, memoized function
  prototypes, throwing weight functions, and symbol or BigInt keys.
- **Runtime safety:** Fixed scheduler errors and timer drift, observer mapping,
  subscriber disposal, and stale transport generations and stream failures.

### Packaging and maintenance

- **Consistent module builds:** Published CJS output in `dist/`; root
  `require()` and `import` now resolve to matching builds.
- **Stronger TypeScript support:** Corrected disposal methods, pool options,
  memoizer signatures, and Node-independent buffer types.
- **Better guidance:** Added troubleshooting and clock documentation, migration
  notes, ADRs, and benchmark records for withdrawn claims.
- **More reliable releases:** Added commit-time formatting and type generation,
  bundle export validation, type-drift checks, and the full `npm run verify`
  gate.

### Measurement notes

Performance claims are backed by reproducible measurements. The benchmark
harness uses seeded workloads, reports its noise floor, and records claims that
did not survive testing. Run the relevant mode before relying on a number:

```sh
node bench/claims.js zipf
node bench/claims.js coldstart
node bench/claims.js carrier
node bench/claims.js payload
node bench/claims.js permit
node bench/claims.js stream
```

The proposed W-TinyLFU admission window and in-process message compression are
not included: measurement did not justify their trade-offs.
