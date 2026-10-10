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
