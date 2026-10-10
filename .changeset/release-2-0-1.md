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
- `PowerQueue.dispose()`, `[Symbol.dispose]()` and `[Symbol.asyncDispose]()`. The
  ring buffer only ever grows, so a queue that took 5 000 items once kept an
  8 192-slot buffer for life; `clear()` empties the slots but deliberately keeps
  the array, which is right for a container bounding memory and wrong for one
  being torn down. `PowerPriorityQueue` has had these all along.
- `createBroadcastBus`'s `getPendingCounts()`, a snapshot of the per-receiver
  pending-ack counts in the same shape as the existing `getSlowConsumerIds()`.
  It exists because the `close()` fix below is pure retention with no behavioural
  symptom, so without it there was no way to observe the fix working at all.
- `PowerHistogram.fromJSON()`, and a `merge()` that accepts a `PowerHistogram`, a
  cross-realm `PowerHistogram`, **or** a `toJSON()` result. The class doc has
  always advertised exact merging of per-worker sketches and `toJSON()` has always
  existed, but `structuredClone` does not preserve the class — so a sketch
  arriving from a worker is a plain object, and `merge()` rejected it with
  "expects a PowerHistogram". The headline distributed use case was unreachable
  without hand-rolling reconstruction, which is exactly the kind of thing that
  gets the bucket indices wrong. The check is structural rather than `instanceof`,
  per the cross-realm rule.
- `createSseAdapter`'s `lastEventId(sub)` and `lastSentId(sub)`, the two ends of
  a reconnect gap. See the SSE fix below.
- `PowerRTCChannel`'s `lowWaterMarkBytes` and `queueBudget` options, and the
  `queuedBytes` / `queuedFrames` getters. See the back-pressure fix below.
- `PowerHistogram.record()`'s error now names the fix rather than only the
  constraint. See the non-negative scope note below.
- `ReconnectPolicy` in `src/utils/`, the shared decorrelated-jitter backoff curve
  the reconnecting transports compose. Not a breaking change: both transports
  already used this exact curve, and the extraction is behaviour-preserving.

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
- **S3-FIFO served stale evicted values.** `_fetchValidNode` fell back to the
  ghost map, and the ghost node still carried its evicted value, so a `get()`
  after an eviction returned the _old_ value — silently. A ghost hit is now a
  miss; re-admission happens on the write path, which is what the ghost queue is
  for. `_s3fifoAppendGhost` also nulls `value`, `weight` and `expiresAt`, because
  the ghost is an admission hint and holding the value kept up to 20 % of
  capacity reachable indefinitely.
- **S3-FIFO's live set exceeded `maxEntries`.** The Main eviction loop compared
  `_map.size >= maxEntries`, so Main settled at `maxEntries - 1` and the total
  reached `maxEntries + 10 %` — 109 entries against a declared limit of 100,
  measured. The loop now bounds the whole live set. `size` also excluded ghost
  entries, which are not entries; they are exposed separately as `ghostSize` and
  in `stats()`.
- **S3-FIFO leaked weight on every Small-queue exit.** Both Small exit branches
  bypass `_unlinkNode`, which is where the Main path subtracts the weight, so
  every Small entry leaving Small added to `_currentWeight` permanently —
  measured at 58 against 10 resident entries after 60 inserts, which under
  `maxWeight` evicts on the strength of weight the cache is not holding.
- **`PowerPool.drain()` leaked an abort listener on every non-abort exit.**
  `release()` removed the `idle` listener but not the `abort` one, and
  `{ once: true }` auto-removes only when it _fires_ — so a wait that ended via
  `idle` or `timeout` left it attached, each retaining a closure over the whole
  pool. Reproduced at 5 retained listeners after 5 timed-out drains.
- **`_idempotencySweep` allocated the whole ledger on every post.** The spread
  `[...ledger.keys()]` materialised every key before the bounded slice was taken,
  making the cost of opting into idempotency proportional to the number of
  in-flight keys. It now iterates lazily. The rotating cursor the existing
  comment claimed but the code never had is also real now: a head-only scan stops
  draining once the head is occupied by in-flight entries, which are never
  deleted, so every settled key behind more than one batch of them was retained
  past its TTL forever.
- **Two cross-realm `instanceof` sites in the message codec.** A `SharedArrayBuffer`
  from another realm failed the check in `frameTransferList` and reached a
  transfer list, where `postMessage` throws rather than posting; a cross-realm
  `ArrayBuffer` was silently _copied_ instead of transferred by
  `collectTransferables`, on the one path whose job is finding buffers to
  transfer. Both now use the internal-slot checks in `powerBuffer`.
- **`PowerBroadcastBus.close()` left a zero entry per closed subscriber.** It set
  the pending count to `0` rather than deleting the key, and nothing decrements a
  zero — the timers that would have were cleared — so the map grew one key per
  closed subscriber.
- **`PowerSlidingWindow` reallocated its ring on every window boundary.** The
  ring was shrunk to the initial capacity whenever a prune found the queue empty,
  and a sliding window is empty at _every_ boundary by design, so it was
  immediately regrown — measured at 4 reallocations per window under steady
  100-per-window traffic and 6 at 400, for the lifetime of the limiter. It now
  shrinks only when the window that just ended needed less than half the ring,
  which is hysteresis rather than a threshold, so the ring settles. A ring
  correctly sized for the demand that grew it is retained; one whose demand has
  genuinely dropped is still released.
- **`PowerRateLimit.dispose()` did not dispose the per-slot limiters.** It
  dropped the built slot graphs with `fill(null)`, which releases the references
  and nothing else — enough for a limiter whose `dispose()` is only a state reset,
  but not for a slot whose caller-supplied factory returned something owning a
  timer, a listener registry or a `FinalizationRegistry`.
- **A throwing rate-limit leg was indistinguishable from "no capacity".** A leg
  whose `available()` threw during the pre-flight returned `false`, exactly as a
  full bucket does, so a broken custom clock or a throwing third-party leg looked
  like load and `rejectionRate` reported a busy limiter rather than a broken one.
  The fault is now counted in `stats().legErrors`, cleared by `reset()`, and kept
  out of `rejectionRate` so the two are distinguishable. Re-throwing was
  considered and rejected: the commit path has no `try/catch` and already
  propagates, so re-throwing would make the _same_ fault surface differently
  depending on whether the leg happened to expose `available()` — a property of
  the limiter, not of the fault. The pre-flight still refuses, which is the safe
  direction.
- **`createSseAdapter` dropped every event emitted during a reconnect gap.** The
  adapter is server-side — the browser's `EventSource` does the reconnecting — so
  the defect was a missing `id:` field, not missing reconnect logic. An
  `EventSource` that loses its connection reconnects on its own and sends
  `Last-Event-ID` carrying the last `id:` the server emitted; with only `data:`
  lines there was never an `id:` to remember, the header was never sent, and the
  gap was silently lost. It now emits a per-subscriber monotonic `id:` before
  every `data:` line, in one write, and reads `Last-Event-ID` on register.
  `lastEventId(sub)` and `lastSentId(sub)` expose both ends of the gap; the
  difference between them is exactly what a reconnect must replay. The adapter
  deliberately does not replay — it holds no buffer of past frames, and a replay
  buffer is the message source's concern.
- **`PowerRTCChannel` had back-pressure detection with nothing behind it.**
  `isBackpressured` was observable but gated nothing: `send()` called the
  platform unconditionally, so `RTCDataChannel.bufferedAmount` grew without
  ceiling while the SCTP congestion window was full, the browser eventually
  killed the connection, and every frame in flight was lost. The helper is now
  unsafe-free above a few hundred KB, which is most real uses.

  It now implements the two-watermark scheme RFC 8831 and the `rtc.io` guide
  describe: above `highWaterMarkBytes` it stops calling the platform and holds
  frames in a JS-side queue bounded by `queueBudget` (1 MiB default), resuming
  when `bufferedamountlow` fires. **The bound is the point** — back-pressure
  without one is a moved leak, frames held in an array that grows for as long as
  the producer keeps calling. Over budget `send()` refuses and counts the frame
  in `stats().droppedFrames`, which is the producer's signal to slow down.

  `bufferedAmountLowThreshold` is now set to the **low** mark rather than the
  high one. It was the high mark, which made the event fire the moment the buffer
  returned to the level the channel had paused at — so it resumed at the same
  level it paused at and oscillated, moving roughly one frame per drain cycle. A
  two-watermark scheme with one watermark is a detector, not a controller. The
  default ratio is 1:16, and the guidance is to tune the ratio before the
  absolute numbers.

  `send()` returning `true` while paused means **"accepted"**, not "on the wire";
  `queuedFrames` and `queuedBytes` say how far behind the producer is, as against
  `bufferedAmount`, which says how far behind the platform is.

  Known limitation, now documented rather than left to discover: the watermarks
  cover this channel's own `bufferedAmount` and do **not** participate in the
  `RTCPeerConnection`'s shared congestion window, which RFC 8831 asks for and the
  platform exposes no API to join.

- **`PowerHistogram.record()`'s rejection of a negative named the constraint but
  not the fix.** The message read "requires a finite non-negative number", which
  tells a caller what is wrong and nothing about what to do. It now names both
  offsets: `record(v - baseline)` for a delta against a known baseline, or
  `record(Math.abs(v))` for a magnitude.

  Accepting negatives via DDSketch's sign-magnitude mapping was considered and
  **rejected**, with the reasoning recorded in the `record()` docblock, the class
  docblock and the guide. Every caller in this library records a non-negative
  quantity, the class is scoped to latency, and the cost of the change lands on
  the quantile path — the exact-zero bucket moves from "below everything" to
  "between the negative and positive buckets", and `percentile()`,
  `countAtOrBelow()` and `snapshot()` all depend on where it sits. The guard is
  loud, which is what makes documenting the constraint sufficient rather than a
  workaround. `PowerApdex.record()` carries the same guard, so the constraint is
  consistent across the library.

- **`PowerHistogram` lost small values recorded after a large one.** Naive `+=`
  on mixed magnitudes discards the small addends: recording `1e16` and then a
  thousand `1`s gave a `sum` of `1e16`, an absolute error of -1000, because
  `1e16 + 1` is not representable. `Math.sumPrecise` was the obvious fix and does
  not apply — it sums an _iterable_, and a DDSketch does not retain its values,
  which is the whole point of the format; it is also `undefined` on this
  library's declared floor. The accumulator is Neumaier-compensated instead,
  which is the technique an incremental sum requires. Measured after: absolute
  error 0.
