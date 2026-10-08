# Changelog

All notable changes to this project are documented here.

The detailed v2.0 release narrative is available in
[`assets/whatsnew2.0.md`](assets/whatsnew2.0.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.0.0]: https://github.com/AbelVM/performance-helpers/releases/tag/v2.0.0
[1.0.3]: https://github.com/AbelVM/performance-helpers/releases/tag/v1.0.3
