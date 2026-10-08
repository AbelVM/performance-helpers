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
