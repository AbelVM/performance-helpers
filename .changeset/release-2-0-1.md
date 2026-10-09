---
'performance-helpers': minor
---

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
- `PowerFlowControl` — an adaptive token bucket whose refill rate is the output
  of a `PowerServo`. The servo's bounds are the rate bounds, so the controller
  cannot ask for a rate the bucket would refuse.
- `PowerRealtimeHub`'s `messagePriority` option, ordering each subscriber's queue
  by the `priority` passed to `publish()`. Off by default; FIFO delivery is
  unchanged.
- `WorkerAgnostic`'s `shared` option, constructing a `SharedWorker` and adapting
  its port to the worker-like surface.
- `Symbol.asyncDispose` on the classes that were missing it, so every long-lived
  helper takes part in `await using` teardown.

### Changed

- `PowerRealtimeHub`'s `drop-oldest` policy evicts the message **furthest from
  delivery** when `messagePriority` is on — lowest priority, and among equal
  priorities the most recently queued. In FIFO mode it still discards the head.
  The two agree about which priority class loses and differ only on the tie.
- `formatPrometheus` validation errors name the offending label key and which
  half of the pair is wrong, and name the specific histogram field that is
  malformed rather than listing all three requirements.
- The published types for `createBroadcastBus`, `createSseAdapter` and
  `createWebTransportAdapter` now include the disposal symbols. Their
  hand-written `@returns` types had drifted and omitted them, and an `any` cast
  on `createSseAdapter`'s return was suppressing the whole type.
- `PowerHistogram.percentile()` documents that a value above 100 saturates to the
  maximum rather than throwing. `NaN` and negatives still throw.

### Fixed

- Two metrics leaks on the `await using` teardown path. `PowerCache`'s
  `[Symbol.asyncDispose]()` repeated `[Symbol.dispose]()`'s body and the copy
  dropped the `detach`; `PowerPool`'s called `terminate()`, which never detaches.
  Both left the series registered and sampled against an unreachable object.
- `PowerGCRA` and `PowerRateLimit` gain the `[Symbol.asyncDispose]()` their
  sibling limiters already had, so `await using` on them takes part in teardown.
- `PowerSemaphore`'s options-object recognition tested for a _known_ key, so
  `new PowerSemaphore({ permits: 3 })` fell through to the numeric path and
  reported "`limit` must be a finite number (received [object Object])" — the
  wrong option and the wrong value. It now recognises any own key and routes to
  the option check. A bare `{}` still throws.
- `PowerPriorityQueue`'s constructor only validated its options when
  `initialCapacity` was present, so `{ initialCap: 4 }` skipped the check and
  reported "must be a finite number (received [object Object])".
- `createWebTransportAdapter`'s socket object now forwards `dispose()`,
  `[Symbol.dispose]()` and `[Symbol.asyncDispose]()` to `close()`.
