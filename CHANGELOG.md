# Changelog

All notable changes to this project are documented here.

The detailed v2.0 release narrative is available in
[`assets/whatsnew2.0.md`](assets/whatsnew2.0.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-10-18

### Added

- `PowerPermitGate`: `FinalizationRegistry`-based lease cleanup — a dropped release callback is auto-released on GC, preventing leaked leases from wedging the gate (S2-11). Covers `PowerSemaphore`, `PowerBulkhead`, `PowerPermitGate`.
- Property-based (fast-check) invariants extended to `PowerPool` and `PowerRealtimeHub` (S2-10): worker-count bounds and non-negative queued counts.

### Changed

- `PowerWebSocketClient` / `PowerWebTransportClient`: `rtt` option now accepts a `PowerHistogram` from another realm (cross-realm `instanceof` replaced with an internal-slot check) (B2-001, B2-002).
- `PowerWebTransportClient`: `streamPriority` option is now actually applied to the bidirectional stream (B2-003).
- `PowerSocketAdapter`: `_attachStream()` no longer produces an unhandled rejection (B2-004).
- `PowerBroadcastBus`: frame-delivery split documented; late acks after a timeout now clear the slow-consumer mark (B2-005, B2-042).
- `PowerDatagramChannel`: `maxDatagramSizeBytes` enforced per chunk during fragmentation; fragmented sends honour the open/queue contract; `dispose()` flushes the queue like `close()` (B2-006, B2-030, B2-031).
- `PowerPool`: readiness guard on `postMessageBatch` fast path; `_dispatchQueuedTasks` skips past-deadline/aborted items and iterates ready workers; `WorkerWrapper.postMessage` no longer synthesises a transfer list (B2-007, B2-008, B2-009). `pool:scale` emitted on all removal paths; stable removal in `_handleWorkerExit`; `healthCheck()` distinguishes crashed vs retired workers; `_rejectAllPending` extracted (B2-025, B2-026, B2-027, B2-028). Idempotency sweep cursor progress (B2-023). Pre-stringified `s` passed to `o2u8` on the large-key branch (B2-024).
- `PowerCache`: `clear()` clears `_inflightControllers`; `_disposed` guard in `set()`; `size`/`entries()`/`invalidate()` agree under S3-FIFO; weight check in `_arbitrateWindow` (B2-010, B2-011, B2-012, B2-015, B2-022).
- `PowerTTLMap`: `_nextExpiryAt`/`_nextExpiryDirty` wired in (B2-016, B2-086).
- `PowerMemoizer`: redundant `assertKnownOptions` call removed (B2-017).
- `ReconnectPolicy`: JSDoc curve description corrected (B2-018).
- `SmallLfuSketch`: auto-tuned `sampleSize` capped at `4 * width * depth` (B2-019).
- `HyperLogLog`: `Math.clz32` guarded with a fallback (B2-020).
- `raceWithAbort`: non-signal objects treated like `!signal` (B2-021, B2-094).
- `PowerSseAdapter`: Node `write()` backpressure honoured; `btoa` guarded with Buffer fallback; dead `abort` field removed (B2-032, B2-033, B2-041).
- `PowerMessagePort`: metrics detached on external close; duplicate `send()` JSDoc merged; `send()`/`postMessage()` consolidated (B2-034, B2-040, B2-043).
- `PowerRTCChannel`: `expectUnreliable` guard fixed (B2-035).
- `PowerRealtimeHub`: `publish()` returns accepted count; `close()` documented as non-graceful (B2-037, B2-045).
- `PowerWebSocketClient`: `sendFrame()` type-checks before state check (B2-038).
- `PowerWebTransportClient`: heartbeat write awaited; `_transmit` `options` param dropped (B2-036, B2-039).
- `PowerPermitGate` / `PowerBulkhead` / `PowerSemaphore` / `PowerCrossLock`: TOCTOU and retention findings resolved (B2-046, B2-047, B2-048, B2-049, B2-050, B2-051, B2-052, B2-053).
- `PowerCircuit`: listeners wrapped in try/catch; reset timer cleared on dispose; atomic HALF_OPEN transition (B2-054, B2-055, B2-056).
- `PowerBackpressure`: `lowWaterMark > highWaterMark` validated (B2-072).
- `PowerBrownout`: `threshold` validated via setter (B2-081).
- `PowerCron`: `setTimeout` delay capped at 2^31-1 (B2-082).
- `PowerEventBus`: wildcard regex cached; `notified` only on live listener (B2-079, B2-083).
- `PowerObserver`: realm-independent `combineLatest` check (B2-080).
- `PowerCircuit`: `call(fn, options)` now accepts an `AbortSignal` (S2-08).
- `PowerHeartbeat`: `timeout: 0` disables the deadline check (B2-044).
- `nowMs`/`monoMs`: clock state grouped into a single resolver object (B2-089); BigInt fallback cost documented (B2-090); default export pinned by test (B2-091).
- E2-02: replaced `@type {any}` escape hatches with precise types in `powerSseAdapter` and `powerSocketAdapter`.
- Guides: `using`/`await using` disposal examples; documented distinction between `PowerFlowControl` and `PowerFlowController` (B2-057, S2-07).

### Fixed

- Status reconciliation: S2-01 (HLL++ bias tables) confirmed rejected by measurement; S2-02, S2-09, S2-12 confirmed already implemented.

---

## [2.2.0] - Unreleased

### Added

- `PowerOperationContext`: async-local propagation via `runOperationContext` / `getOperationContext` / `withOperationContext` (S-37), using `node:async_hooks` `AsyncLocalStorage` with a browser fallback.
- `PowerPool.drain()`: optional `onProgress` callback + `drain:progress` events reporting `{ activeTasks, queueLength }` (R-09).
- `PowerBrownout`: adaptive threshold via `adaptive` option (AIMD adjustment on `setPressure`, EWMA tracking, `baseThreshold`/`pressureEwma` in stats) (S-31).
- `PowerMessagePort`: zero-copy transfer support — `send(sub, frame, transfer)`, `postMessage(value, transfer)`, `transferPort(port)` (S-27).
- `PowerBackpressure`: async-iterable interface via `[Symbol.asyncIterator]()` yielding release callbacks (S-04); `highWaterMark` option — queued waiters at/above the threshold cause `acquire()` to reject with `ERR_QUEUE_FULL` instead of queueing (default `Infinity`, disabled) (S-30).
- `PowerTaskGroup`: structured concurrency scope — `run`/`spawn`/`all`/`cancel`/`dispose`, shared `AbortSignal`, `cancelOnError` option, `using`/`await using` support (S-06).
- `PowerTTLMap`: bounded memory via `maxSize` option with least-recently-used eviction on `set()`; `get()`/`touch()`/re-`set()` mark a key most-recently-used. `0` (default) keeps the map unbounded (M-04).
- `PowerRealtimeHub`: `presence(topic?)` / `getPresence(topic?)` alias returning a snapshot array of `{ id, topic, transport }` for live subscribers, optionally filtered by topic (S-19).
- `PowerCache`: `load(snapshot)` prefill API accepting `[key, value]`, `[key, value, { ttl, weight }]`, `{ key, value, ttl?, weight? }` and `Map` entries; routes through `set()` so admission policy, TTL and weight apply; returns accepted count (M-05 / S-11).
- `PowerBufferPool`: reusable `Uint8Array` buffer pool with size buckets, `acquire(size)`/`release(buf)`, per-bucket and total caps, zeroing on reuse, `stats()` and `using`/`await using` support (S-17).
- `MetricsCollector`: `toOTLP()` exporter hook returning an OTLP-shaped JSON export (pull-based, no push); `createOperationContext` accepts `traceId`/`spanId` for trace context propagation (S-05); lazy `defaultMetrics` allocation via `Proxy` (M-03).
- `PowerWebSocketClient`: message queue while disconnected via `messageQueueSize` option (default 0 = disabled); buffers sends while closed, flushes in order on open, drop-oldest on overflow with `droppedQueuedMessages` counter; cleared on user close/dispose (S-22).
- `PowerChunker`: `highWaterMark` option on the streaming path pauses pulling when the pool queue reaches the threshold (default `Infinity` = disabled) (S-15).
- `HyperLogLog`: sparse representation for small cardinalities (HLL++-style) — exact distinct counting until the sparse threshold is reached, then conversion to the dense register array. New `sparse` (default `true`) and `sparseThreshold` (default `registerCount * 4`) constructor options; `isDense` getter. Dense phase, public `registers`/`registerCount` contract and validation unchanged (BEAM-013 / S-01). Bias-correction tables and 6-bit packed registers were measured and rejected (see review notes).
- `PowerCron`: `timezone` option accepting a validated IANA time zone (throws `RangeError` on an invalid zone); exposed via the `timezone` getter (E-07).
- `PowerDatagramChannel`: fragmentation for large datagrams via `fragmentSize`/`fragment` options; splits oversize datagrams into chunks, counts `fragmentedDatagrams`/`fragmentsSent` (S-25).
- `PowerServo`: auto-tuning via `autoTune({ ku, pu, method })` (Ziegler-Nichols classic and Tyreus-Luyben), plus `tune()`/`autoTuneZN()` aliases and `autoTune` constructor option (S-28).
- `PowerWebTransportClient`: QUIC stream prioritization via `streamPriority`/`sendOrder` options; datagram path via `datagrams`/`datagramFallback`/`onDatagram` and `sendDatagram()` (S-09, S-23).
- `PowerPool`: worker health-check via `healthCheck()`/`ping()` returning per-worker `{ index, pending, alive }`, plus `healthCheckIntervalMs` option (M-06).
- `PowerDefer`: `cancel(reason?)` + `cancelled` getter for cancelling a pending defer (S-16).
- `PowerEventLoopMonitor`: `longTaskThreshold` option + `PerformanceObserver` long-task detection (S-34).
- `PowerCircuit`: configurable `halfOpenProbes` for half-open trial calls (R-10).
- `PowerHeartbeat`: `keepProcessAlive`/unref support so the timer does not keep the process alive by default (BEAM-001).

### Changed

- Status reconciliation (pass 3): P-10 and S-24 confirmed already implemented.

## [2.1.0] - 2026-10-13

### Added

- `PowerPriorityQueue` — a binary heap dequeuing highest priority first, FIFO on
  ties, with `popLowest()` for bounded eviction from the other end.
- `PowerDeduplication` — time-windowed duplicate suppression with a TTL, a
  `maxKeys` cap, and an injectable clock.
- `PowerHeartbeat` — jittered liveness detection. Jitter is applied to the
  scheduled check rather than the deadline, so a peer beating on time is never
  failed for arriving early.
- `PowerSequencer` — gap detection and in-order reassembly for out-of-order
  datagrams. `missing()` is the list a NACK would carry.
- `PowerFlowControl` — an adaptive token bucket whose refill rate is the output of
  a `PowerServo`. The servo's bounds are the rate bounds, so the controller cannot
  ask for a rate the bucket would refuse.
- `PowerFlowController` — admission, queueing and latency feedback in one closed
  loop.
- `PowerApdex` — APDEX scoring over three exact integer counters. It deliberately
  does **not** derive its score from a `PowerHistogram`: the derived version is
  324 points wrong (reporting 0.625 for a service attaining 0.950) when the mass
  concentrates inside one bucket straddling the threshold, and the error is not
  monotonic in `relativeAccuracy`, so no accuracy setting repairs it. See
  [ADR 0014](adr/0014-apdex-counters-not-a-sketch.md).
- `PowerRealtimeHub`'s `messagePriority` option, ordering each subscriber's queue
  by the `priority` passed to `publish()`. Off by default; FIFO delivery is
  unchanged.
- `WorkerAgnostic`'s `shared` option, constructing a `SharedWorker` and adapting
  its port to the worker-like surface.
- `ReconnectPolicy` in `src/utils/` — the shared decorrelated-jitter backoff curve
  the reconnecting transports compose. Behaviour-preserving; both transports
  already used this exact curve.
- `Symbol.asyncDispose` on the classes that were missing it, so every long-lived
  helper takes part in `await using` teardown.
- `PowerQueue.dispose()`, `[Symbol.dispose]()` and `[Symbol.asyncDispose]()`. The
  ring buffer only ever grows, so a queue that took 5 000 items once kept an
  8 192-slot buffer for life; `clear()` empties the slots but deliberately keeps
  the array, which is right for a container bounding memory and wrong for one
  being torn down.
- `PowerQueue.unshift(item)` — enqueue at the **head**, so the item is the next one
  `shift()` returns. O(1), and an exact inverse of `shift()`.
- `PowerHistogram.fromJSON()`, and a `merge()` that accepts a `PowerHistogram`, a
  cross-realm `PowerHistogram`, **or** a `toJSON()` result. `structuredClone` does
  not preserve the class, so a sketch arriving from a worker is a plain object and
  `merge()` rejected it with "expects a PowerHistogram" — the headline distributed
  use case was unreachable without hand-rolling reconstruction. The check is
  structural rather than `instanceof`, per the cross-realm rule.
- `PowerHistogram.countAtOrBelow(value)` — the inverse of `percentile()`. Shipped
  as a general rank query and documented as unsound for an SLO attainment figure,
  with the number, in both its JSDoc and the guide.
- `HyperLogLog` now takes a register count, defaulting to 64 so nothing changes for
  an existing caller. Relative error is `1.04/sqrt(m)`: 256 registers give ~6.5 %
  and 1024 give ~3.2 %, at one byte per register.
- `PowerCache`'s `missCost` option, and the `missCostScan` width that bounds it.
- `PowerGCRA.setRate(rate)` — change the sustained rate at runtime.
- `PowerPool.close({ force, timeout })` — graceful shutdown as a single entry point,
  composing `drain()` + `shutdown()`. What it prevents is the _order_:
  `shutdown()` alone abandons in-flight work and `drain()` alone leaves the workers
  running, and getting it wrong is silent. `force` and `timeout` are mutually
  exclusive and throw rather than silently preferring one.
- `PowerPool`'s `maxQueueLength` accepts `'auto'`, resolving the cap to
  `maxSize ** 2` and reporting it through `getStats().maxQueueLength`, which
  previously did not expose the cap at all. **`Infinity` remains the default**: a
  cap that silently appears is a cap nobody chose.
- `PowerPool`'s `recordTiming` option — opt-in percentile telemetry.
  `getStats().performance` gains `percentiles` and `queueWaitPercentiles`
  (`{ p50, p90, p99, p999 }`) plus `utilization`. Off by default, and the default
  path pays nothing; the percentile fields are `null` when off rather than zeros,
  because `p50: 0` would read as "the median task took no time" rather than "nobody
  is measuring".
- `PowerPool`'s `loadBalancer` option — a caller-supplied worker-selection policy,
  called with a frozen array of per-worker views. **The default policy is not
  replaced**, and the view is a plain frozen object rather than the live
  `WorkerObj`, so a balancer cannot reach `terminate()` or the `WorkerAgnostic`.
- `PowerPool`'s `ready` option — a readiness gate holding a worker out of dispatch
  until it signals it has initialised. The field name is yours, the signal is
  pool-internal traffic, and `readyTimeout` fails open.
- `postMessage` accepts a per-task `signal` — a standard `AbortSignal`. Already
  aborted at post time is refused before any queue work; aborted while queued
  rejects the pending response at abort time; **aborted while in flight the work
  runs to completion and the waiter is released now**, because under
  `maxTasksPerWorker > 1` terminating a worker to abandon one task kills every
  other task on it. `skipQueue` is rejected as part of this change.
- `PowerRateLimit.reserveAsync(n, options)` — the awaiting counterpart to
  `reserve()`, for an async `sharedState` adapter. `reserve()` now **throws** a
  `TypeError` when the adapter is async rather than returning `null`: returning
  `null` would tell a caller "you were denied" when the truth is "I could not find
  out", and those need different handling.
- `createBroadcastBus`'s `getPendingCounts()`, a snapshot of the per-receiver
  pending-ack counts in the same shape as the existing `getSlowConsumerIds()`.
- `createSseAdapter`'s `lastEventId(sub)` and `lastSentId(sub)`, the two ends of a
  reconnect gap.
- `PowerRTCChannel`'s `lowWaterMarkBytes` and `queueBudget` options, and the
  `queuedBytes` / `queuedFrames` getters.

### Changed

- `PowerPool`'s saturated dispatch path is O(log n) per dispatch instead of O(n),
  removing an O(n²) term under sustained saturation. The queue is now a
  `PowerPriorityQueue` — a binary heap — because with `priorityAgingMs` at its
  default of `0` the effective priority is static. **`priorityAgingMs` above `0`
  keeps the O(n) scan, deliberately**: aging makes the effective priority drift
  with the clock, and a heap keys on the priority at push time, so it would order
  by a key that is already stale. Both paths dispatch in the same order for the
  same input, and that equivalence is pinned by a test.
- `PowerRealtimeHub`'s `drop-oldest` policy evicts the message **furthest from
  delivery** when `messagePriority` is on — lowest priority, and among equal
  priorities the most recently queued. In FIFO mode it still discards the head.
- `PowerPriorityQueue` gained `pushMany(items)` and `toArray()`, a snapshot in
  **dispatch order**. `toArray()` sorts the heap _entries_ rather than the items,
  because the FIFO tiebreak is the insertion sequence number, which lives on the
  entry.
- `formatPrometheus` validation errors name the offending label key and which half
  of the pair is wrong, and name the specific histogram field that is malformed
  rather than listing all three requirements.
- The published types for `createBroadcastBus`, `createSseAdapter` and
  `createWebTransportAdapter` now include the disposal symbols. Their hand-written
  `@returns` types had drifted and omitted them, and an `any` cast on
  `createSseAdapter`'s return was suppressing the whole type.
- `PowerHistogram.percentile()` documents that a value above 100 saturates to the
  maximum rather than throwing. `NaN` and negatives still throw.
- `deepEqual`'s `Set` branch no longer allocates an array it never reads.
- `PowerHistogram`'s cached bucket order now carries cumulative counts alongside
  the sorted index list, so `countAtOrBelow()` does not walk the occupied range.

### Fixed

- **`PowerRateLimit.reserve()` reported every reservation as granted** when the
  `sharedState` adapter was async.
- **`PowerPool` now detects a worker that dies, settles it, and replaces it.**
  Before this, a dead worker was simply absent, and three things followed — all
  observable from outside as "the pool stopped working". A `pool:worker:exit` event
  is emitted on the internal bus.
- **S3-FIFO served stale evicted values**, its live set could exceed `maxEntries`,
  and it leaked weight on every Small-queue exit.
- **`PowerCache { admission: 'tinylfu' }` could never adapt to a working set that
  changed.** Two defects: a refused key was never recorded in the sketch, and the
  sketch's half-life clock stopped once its counters saturated. The `zipf` row now
  reads 93.0 % working-set hit rate and 37.0/40 survivors, beating
  `policy: 'slru'` (89.4 %, 33.0/40) rather than losing to it.
- **`PowerHistogram` lost small values recorded after a large one.**
- **`HyperLogLog` used the wrong bias constant** for the register count it shipped,
  and its rank calibration was hardcoded for one register count.
- **Four cross-realm `instanceof` defects**, found by grepping the class rather than
  the site, plus two more in the message codec.
- `PowerPool.drain()` leaked an abort listener on every non-abort exit.
- `_idempotencySweep` allocated the whole ledger on every post.
- `PowerBroadcastBus.close()` left a zero entry per closed subscriber.
- `PowerSlidingWindow` reallocated its ring on every window boundary.
- `PowerRateLimit.dispose()` did not dispose the per-slot limiters.
- A throwing rate-limit leg was indistinguishable from "no capacity".
- `createSseAdapter` dropped every event emitted during a reconnect gap.
- `PowerRTCChannel` had back-pressure detection with nothing behind it.
- `PowerHistogram.record()`'s rejection of a negative named the constraint but not
  the fix.

### Benchmarks

Eight `bench/claims.js` modes were added to settle questions by measurement rather
than assertion. **Five of them reject the feature they were written to evaluate**,
and nothing in `src/` changed as a result:

- `blockqueue` — Piscina's `FixedQueue` design against the shipped `PowerQueue`
  ring buffer. The structural claim is true and is not enough: a block chain
  allocates 15× the churn, and the worst-case pause the design was meant to bound
  is itself a GC pause. Rejected in ADR 0017.
- `namedexport` — `postMessage(msg, transfer, { name })`. A worker costs 7.88 MB of
  marginal RSS, but `shared/type` (a payload field, available today) ties
  `shared/name` at every skew, and `name` costs a flat +20 bytes per message.
  Rejected in ADR 0018.
- `messageport` — a dedicated `MessageChannel` per worker. The sniffing it removes
  is 11.6 ns per inbound message, 0.065 % of the 17.97 µs framed round trip; the
  port it adds costs 15.97 µs per worker. Rejected in ADR 0019.
- `geocoalesce` — a coalescer against `PowerBatch` + a `Map`. The rejection
  condition fired: at best equal on work, and always fewer mutations applied.
- `flowloop` — **the closed loop is worth building, and the gain band is narrow.**
  The fixed control sits at 71.7 ms p99 after a capacity step, 2.4× the 30 ms
  target; the defaults settle on the closed-form equilibrium with 0.8 ms overshoot,
  while the aggressive settings fail to control at all.
- `geoencode` — four arms on one payload in a real worker. Structured clone of the
  object graph is _slower_ than JSON, a flat buffer is 47× faster than the object
  graph, and **the win is flattening, not transferring**.
- `geoprecision` — rounding coordinates saves nothing on a flat `Float64Array`,
  40.6 % on line-heavy JSON and only 10.8 % on point-heavy JSON.
- `geoprefetch` — **the in-flight window is the wrong knob.** The determinant is
  read-ahead lead vs per-tile latency, not the window: with the lead covering the
  latency every window reads 0.0 % waste, and with the lead too short a _larger_
  window wastes more, not less.

### Tests and gates

- `test/docsCodeAgreement.test.js` gains **GATE-010**, which scans fenced code
  blocks for `recv.method(` calls. GATE-002 and GATE-005 both scan _inline_
  backticked calls and neither can see a code block — exactly the shape of the bug
  GATE-002 was written for. Two layers, both measured before being written:
  **precise** (274 call sites, 0 mismatches) and **union** (409 call sites, 0
  mismatches). Mutation-checked with three planted faults, all caught.
- `test/geoClock.injection.test.js` — 15 cases driving each helper from a clock the
  test owns. Two pin failure modes worth recording: a **frozen** clock does not
  work for `PowerEventLoopMonitor`, and `PowerCircuit`'s drawn open window is
  jittered, so an exact boundary assertion is a coin flip.
- 13 tests in `test/powerPool.readiness.test.js`, mutation-checked 5 of 5 —
  including reverting the single-worker fast path, which is where the first draft
  of the implementation was wrong.
- A Node-version floor guard (`scripts/check-node-floor.mjs`, step 2 of `verify`)
  that rejects `using` / `await using` in `src`, `test`, `bench` and `scripts`,
  because the syntax is a hard SyntaxError on the `engines.node` floor and cannot
  be gated with `it.runIf()`.

### Design notes

- `PowerApdex` does **not** compute its score from a `PowerHistogram`, although
  that would have been less code and no new state. See ADR 0014.
- `countAtOrBelow()` ships as a general rank query and is documented as unsound for
  an SLO attainment figure, with the number, in both its JSDoc and
  `guides/powerHistogram.md`.
- `guides/powerApdex.md` and `guides/metaGuide.md` carry recipes for pairing
  `PowerApdex` with `PowerBrownout`, windowing it with a double buffer, and scoring
  per route — and a section on why it must **not** be used as an adaptive control
  signal. Every adaptive helper in this library takes a signed, unbounded,
  gradient-carrying quantity; APDEX is a bounded ratio that saturates at `1.0` and
  goes blind exactly when the SLO is being met.

## [2.0.0] - 2026-10-08

### Breaking Changes

- Numeric options and request counts now reject invalid, non-finite, fractional,
  or out-of-range values instead of silently coercing them.
- `PowerPool` uses versioned message framing by default. Workers must reply in
  the framing they receive; use `messageCodec: 'legacy'` during migration.
- `PowerHistogram` now uses DDSketch with `relativeAccuracy`; `maxValue` and
  bucket-count options were removed.
- Rate limiters, circuits, and related duration-based helpers use a monotonic
  clock. Tests should inject `now` instead of faking `Date.now()`.
- `PowerCache.hasEqualWithSeen()` and the `seen` option were removed.
- `PowerTTLMap.size` is now a side-effect-free O(1) read. Use `purge()` for
  cleanup and `expiredCount` for diagnostics.
- `admission: 'tinylfu'` is ignored with `policy: 'slru'`. The experimental
  W-TinyLFU admission window is not included in this release.

### Added

- Versioned `PowerMessageCodec` framing, native structured-clone negotiation,
  and incremental frame decoding.
- `PowerRealtimeHub`, `PowerSocketAdapter`, `PowerWebSocketClient`, and the
  WebTransport and SSE lifecycle improvements.
- `PowerGCRA`, `PowerRetryBudget`, retry hedging, decorrelated backoff, and
  adaptive pool concurrency policies (`aimd`, `vegas`, and `gradient2`).
- `PowerCron`, `PowerEventLoopMonitor`, derived `PowerObserver` values, stable
  external-store snapshots, error routing, and framework-neutral integration
  guidance.
- Metrics observations and dependency-free Prometheus text formatting.
- Cache SLRU admission, refresh failure and cancellation diagnostics, bounded
  pool queues, drain limits, and `AbortSignal` support across waiting APIs.
- `dispose()` and `[Symbol.dispose]()` for resource-owning helpers, plus
  lifecycle aliases where `reset()` and `clear()` have the same meaning.
- Published CJS output in `dist/`, corrected TypeScript declarations, and a
  reproducible benchmark harness with noise-floor reporting.

### Changed

- `PowerPool.postMessageBatch()` reduces repeated dispatch work and frames
  messages consistently with individual posts.
- `PowerPool` now enforces adaptive concurrency limits, reports worker and
  aggregate idle data separately, and prevents late worker replies from
  corrupting active-task accounting.
- `PowerRetry` can limit retry traffic with a shared budget and hedge only the
  first attempt when configured.
- `PowerCircuit` grows and jitters consecutive open windows.
- `PowerScheduler` supports native yielding and uses `MessageChannel` for
  unclamped macrotasks where available.
- `PowerPool` payload preparation defaults to retaining cached buffers rather
  than slicing them for transfer. This is an isolated preparation-path change;
  no end-to-end speedup is claimed.

### Fixed

- Corrected pool shutdown, draining, cancellation, queue, correlation, worker
  reply, and batch atomicity failures.
- Fixed limiter batch ceilings, retry delays, non-finite counts, atomic rate
  limiting, and permit-gate accounting and cancellation.
- Fixed cache refresh retention, deep-equality width and depth handling,
  memoized function prototypes, throwing weight functions, and symbol/BigInt
  cache keys.
- Fixed scheduler error handling, timer drift, observer mapping, subscriber
  disposal, worker loading, and transport generation and stream failures.
- Internal timers now call `unref()` by default, so helpers do not keep Node
  processes alive unexpectedly.

### Documentation and Maintenance

- Added troubleshooting and clock guidance, updated API and migration docs, and
  recorded decisions and withdrawn performance claims in ADRs and benchmarks.
- Added commit-time formatting and type generation, bundle export validation,
  type-drift checks, and the full `npm run verify` release gate.

## [1.0.3] - released

The final 1.x release. See the
[GitHub releases](https://github.com/AbelVM/performance-helpers/releases) for
historical 1.x notes.

[2.1.0]: https://github.com/AbelVM/performance-helpers/compare/v2.0.0...main
[2.0.0]: https://github.com/AbelVM/performance-helpers/releases/tag/v2.0.0
[1.0.3]: https://github.com/AbelVM/performance-helpers/releases/tag/v1.0.3
