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
- `HyperLogLog` now takes a register count, defaulting to 64 so nothing changes
  for an existing caller. The relative error is `1.04/sqrt(m)`, so 256 registers
  give ~6.5 % and 1024 give ~3.2 %, at one byte per register. See the two fixes
  below for why this was not already possible.
- `PowerPool`'s `maxQueueLength` accepts `'auto'`, resolving the cap to
  `maxSize ** 2` and reporting it through `getStats().maxQueueLength`, which
  previously did not expose the cap at all. The most common misconfiguration with
  this option is leaving it unbounded — nothing refuses, nothing warns, and the
  failure arrives as an OOM rather than as a refusal. **`Infinity` remains the
  default**: a cap that silently appears is a cap nobody chose. Resolved once at
  construction; a later `resize()` does not re-derive it, because a bound that
  moves under a running pool is a bound nobody can reason about.
- `PowerQueue.unshift(item)` — enqueue at the **head**, so the item is the next one
  `shift()` returns. The mirror of `push`, and the primitive a return-to-front path
  needs: work that was dequeued for dispatch but could not be delivered goes back
  where it came from rather than behind everything that arrived after it. **O(1)** —
  moving a ring buffer's head back one slot leaves every item on its same physical
  slot, so nothing is copied. `unshift` and `shift` are exact inverses, so a
  dequeue-then-restore round-trip leaves the queue exactly as it was. For bulk
  prepends, `unshiftMany(items)` remains the amortised-cheap path.
- `PowerPool`'s `recordTiming` option — opt-in percentile telemetry.
  `getStats().performance` gains `percentiles` and `queueWaitPercentiles`
  (`{ p50, p90, p99, p999 }`) plus `utilization`. **Why a sketch and not more
  counters:** `timePerTask` and `queueWait` already report exact mean, stddev, min
  and max in O(1) memory, and `percentSlowTasks` counts exactly against a threshold
  — none of those can answer "what does the tail look like", and a mean of 12 ms is a
  different pool at p99 = 13 ms than at p99 = 400 ms. `PowerHistogram` is a DDSketch,
  which bounds _relative_ error across decades of magnitude, so a 3 ms task and a 3 s
  task land in the same sketch without one swamping the other. It is
  `PowerHistogram` rather than Piscina's histogram, which is `node:perf_hooks` and
  does not exist in a browser. **Off by default, and the default path pays nothing** —
  with the flag off the histograms are never allocated and each recording site is a
  single boolean test. `percentiles` and `queueWaitPercentiles` are `null` when off
  rather than zeros, because `p50: 0` would read as "the median task took no time"
  rather than "nobody is measuring". `utilization` is _not_ gated — it is two
  comparisons on transitions that already happen — and is interval-based rather than
  sampled, because a sampled utilization is a function of the sampling rate. The
  Welford statistics are additive, not replaced. Cross-reference ADR 0014.
- `PowerPool`'s `loadBalancer` option — a caller-supplied worker-selection policy.
  Called with a frozen array of per-worker views (`{ id, tasks, latencyEwma,
lastActive }`) and returns the id or the object of the worker a new task should go
  to. **The default policy is not replaced:** PowerPool's least-loaded-plus-EWMA rule
  beats Piscina's for heterogeneous tasks, so this adds a choice rather than taking
  one away, and omitting the option behaves exactly as before. **The view is a plain
  frozen object, not the live `WorkerObj`** — a balancer is caller code running inside
  the pool, invoked from the pool's own send path, so the live object would expose
  `terminate()`, the `WorkerAgnostic` and everything reachable from them. A balancer
  that throws or returns nothing usable falls back to the default rule rather than
  breaking the send path, and a non-function is rejected once at construction. The
  same frozen view is reported per worker by `getStats().workers`.
- `PowerPool.close({ force, timeout })` — graceful shutdown as a single entry point.
  A composition of `drain()` + `shutdown()`, both of which stay exactly as they are.
  What it prevents is the _order_: `shutdown()` alone abandons in-flight work, and
  `drain()` alone leaves the workers running — and getting it wrong is silent, because
  the pool looks closed and the last few tasks are gone. `force` and `timeout` are
  mutually exclusive and throw rather than silently preferring one, because a forced
  close has nothing to wait for. A drain that cannot finish is logged and the close
  proceeds. Resolves with the final `getStats()` snapshot.
- `postMessage` accepts a per-task `signal` — a standard `AbortSignal`, which is why
  this works the same way in every realm the pool runs in. **Already aborted at post
  time** is refused before any queue work, because a caller holding an aborted signal
  has already changed their mind; fire-and-forget returns `false` rather than throwing,
  matching every other refusal on that path. **Aborted while queued** rejects the
  pending response _at abort time_, not at dispatch time — the item is deliberately
  **not** pulled out of the queue, because neither queue implementation has an
  efficient remove-by-value and the dispatch loop already walks past items it is going
  to discard, the same trade `deadlineAt` makes. **Aborted while in flight: the work
  runs to completion and the waiter is released now.** Piscina terminates the worker;
  that is the wrong trade here, because under `maxTasksPerWorker > 1` a worker carries
  several in-flight tasks, so terminating it to abandon one kills every other task on
  that worker — a blast radius far larger than the task being aborted, and one the
  callers of those other tasks did nothing to earn. It also discards a warm worker and
  its negotiated protocol state. The response is discarded when it arrives, because the
  pending entry is already gone. That is the honest reading of what an abort usually
  means — "stop waiting for this" — and a caller who genuinely needs the work undone
  has to arrange that in the worker, because no pool can undo a side effect.
  **`skipQueue` is rejected** as part of this change: the pool already dispatches
  immediately when a worker is free, the queue is only used under saturation, and a
  `skipQueue` that jumped ahead of queued work would be a priority mechanism by another
  name when `priority` already exists.
- `PowerRateLimit.reserveAsync(n, options)` — the awaiting counterpart to `reserve()`,
  for a `sharedState` adapter whose `checkAndIncrement` returns a promise. Same
  contract, same `{ n }` token shape, same `null` on refusal. `reserve()` now **throws**
  a `TypeError` when the adapter is async, rather than returning `null`: returning
  `null` would tell a caller "you were denied" when the truth is "I could not find
  out", and those need different handling. `reserveAsync()` covers both shapes, because
  `tryConsume` normalises them and `await` on a boolean is that boolean.

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
- `deepEqual`'s `Set` branch no longer allocates an array it never reads.
  `unsigIndices` was declared, pushed to for every member whose `trySignature`
  returned `null`, and never read — dead on arrival, because the structural fallback
  scans every unmatched index whether or not anything remembers them. The coverage
  report showed its `push` branch was never even taken, so no test could have
  observed its absence.
- `PowerPool`'s saturated dispatch path is O(log n) per dispatch instead of O(n),
  removing an O(n²) term under sustained saturation. The queue was a `PowerQueue` and
  every dispatch called `shiftHighestPriority`, which scans every queued item to find
  the best one. With `priorityAgingMs` at its default of `0` the effective priority is
  static, so the queue is now a `PowerPriorityQueue` — a binary heap. This matters more
  here than in a Node-only pool: a long pause on a browser main thread is a dropped
  frame. **`priorityAgingMs` above `0` keeps the O(n) scan, deliberately** — aging makes
  the effective priority `priority + (now - enqueuedAt) / priorityAgingMs`, which drifts
  with the clock, and a heap keys on the priority at push time, so it would order by a
  key that is already stale. The two paths dispatch in the same order for the same
  input, and both keep FIFO among equal priorities; that equivalence is itself pinned
  by a test.
- `PowerPriorityQueue` gained `pushMany(items)` — bulk enqueue, a deliberate loop over
  `push` because each push is already O(log n) and a heap has no block-copy
  amortisation to earn — and `toArray()`, a snapshot in **dispatch order**. `toArray()`
  sorts the heap _entries_ rather than the items, and that is the whole subtlety: the
  FIFO tiebreak is the insertion sequence number, which lives on the entry, so sorting
  items directly would compare equal priorities as equal and fall back on the heap
  array's layout — which is a valid heap but not an insertion order. The result would
  look sorted and not be FIFO.
- `bench/claims.js` gains a `blockqueue` mode, measuring Piscina's `FixedQueue`
  design — a linked list of 2 048-slot circular buffers — against the shipped
  `PowerQueue` ring buffer, with `Array.prototype.shift()` as a control. **The
  proposal does not pay, and the reason is that the two structures allocate in
  proportion to different things.** The ring grows log₂(peak) times and then reuses
  its buffer forever; a block chain allocates one block per 2 048 pushes for the
  life of the queue — 3 999 744 slots against 262 128 over 4 M pushes, 15× the
  churn, and 1 953 growth events against 14. The row's structural claim is true and
  is not enough: a block allocation is cheaper per event than the ring's doubling
  copy by 9× to 98× across four runs (~50× typical, the block chain's own figure
  stable at 0.8–3.8 µs while the ring's moves from 7 µs to 85 µs on the same
  machine), and the worst-case pause the design was meant to bound is itself a GC
  pause — 0.3–250 ms to allocate one array, against the ring's own 0.8–2.1 ms copy.
  The one axis the block chain wins is resident memory at peak depth (200 704 slots
  against 262 144), and it loses that below one block. Recorded as rejected in ADR
  0017; nothing in `src/` changed.
- `bench/claims.js` gains a `namedexport` mode, measuring PISC-009's proposal that
  `postMessage(msg, transfer, { name })` "cuts worker count and memory for pools
  that currently spawn one pool per task type". **The premise is true and is not
  attributable to the feature.** A worker costs **7.88 MB of marginal RSS** on
  this machine, measured on the parent process — a `worker_threads` Worker is a
  thread in the same process, so reading RSS inside one reports the whole process
  and summing it across n workers multiplies by n, which is how the first draft
  reported 16 workers at 3.7 GB. A shared pool does need fewer workers than a
  siloed design for the same tail (8 against 9–11, because a siloed design has a
  floor of one worker per task type), but `shared/type` — one pool whose worker
  switches on a payload field, **available today with no codec change** — and
  `shared/name`, the proposal, **tie at every skew**: +1.5 %, +0.5 % and −0.6 % in
  one run and −8.6 %, −1.2 % and +13.4 % in another, so the sign flips between
  runs and there is no difference to measure. What `name` would actually buy is
  ergonomics and static safety, at a flat **+20 bytes per message** (+22.7 % on a
  64-byte payload) plus a protocol version bump. Recorded as rejected in ADR 0018;
  nothing in `src/` changed.
- `bench/claims.js` gains a `messageport` mode, measuring PISC-010's proposal for a
  dedicated `MessageChannel` per worker, which the row says "costs nothing to adopt
  here" and "removes the in-band capability-announcement sniffing entirely". **That
  is a ratio claim and it is false on both halves.** The sniffing it removes is
  **11.6 ns per inbound message** — `isCapabilityAnnouncement` plus
  `isNativeEnvelope`, run on every message to support an event that arrives once
  per worker — which is **0.065 % of the 17.97 µs framed round trip** measured
  against a real `worker_threads` worker. The port it adds costs **15.97 µs per
  worker**: 6.41 µs for the `MessageChannel` and a **9.56 µs port-transfer premium**
  on the startup message that has to carry it, plus a second listener per worker.
  The break-even is 1 376 messages per worker, and even there the saving is 0.065 %
  of the path — bought with a worker-side contract change behind a major version,
  which the row's own third claim identifies while its second denies it. The
  measured fraction is an upper bound, since 17.97 µs is the bare worker round trip
  and the pool's real inbound path adds correlation matching, latency sampling and
  the task queue on top. Recorded as rejected in ADR 0019; nothing in `src/`
  changed.

### Fixed

- **`PowerRateLimit.reserve()` reported every reservation as granted when
  `sharedState` was configured with an async adapter.** The implementation was
  `if (!this.tryConsume(...)) return null;` — and `tryConsume` returns a _promise_ for
  an async adapter. A promise is truthy, so `!promise` was `false`, the guard never
  fired, and the method returned `{ n }` unconditionally, including for reservations
  the shared store had denied. A caller who then `release()`d that token credited
  permits that were never spent, so the distributed budget leaked by one per denied
  request. Reproduced before the fix: an adapter denying everything, `reserve(1)`
  returning `{ n: 1 }` where the synchronous adapter correctly returned `null`. Fixed
  by splitting into `reserve()` / `reserveAsync()` — see the Added section.
- **`PowerPool` now detects a worker that dies, settles it, and replaces it.** Before
  this, a dead worker was simply absent, and three things followed — all observable
  from outside as "the pool stopped working": `drain()` hung waiting for a response
  that would never arrive; every `awaitResponse` promise timed out instead of
  rejecting, so a caller waited the full timeout — 30 s by default, forever under
  `awaitResponseTimeout: Infinity` — to learn what had already happened; and the pool
  sat below `minSize` permanently, because nothing noticed the shortfall. The pool now
  settles the dead worker's in-flight tasks and **rejects its pending responses at the
  moment of death** rather than at a timeout, removes it, emits `pool:worker:exit`, and
  refills toward `minSize`. **The bootstrap guard is the part worth understanding:** a
  worker that dies having never completed a task is a worker that failed to _load_ — a
  syntax error, a missing module, bad `workerOptions` — and refilling on every such
  death is a respawn storm, each replacement loading, throwing, dying and being
  replaced at full CPU forever. So **three consecutive load-failures stop the refill**
  and the reason is logged rather than retried; that bound is a judgement call borrowed
  in substance from Piscina's `workerFailsDuringBootstrap`, not a measured number. A
  worker that had been working and then died is a _crash_, not a load failure, and
  resets the bound. **Known limitation, recorded rather than papered over: this is
  Node-only.** A browser `Worker` has no `'exit'` event, so the handler never fires
  there and the `drain()`-hangs symptom persists in that runtime.
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

- **`HyperLogLog` used the wrong bias constant for the register count it shipped
  with.** `ALPHA` was hardcoded to `0.673`, which is the constant for **16**
  registers; the class hardcoded 64, where it should be `0.709`. Every estimate
  was biased low by roughly 5 %, which is the same order as the 13 % relative
  error the sketch exists to bound — so the class was quoting one number and
  delivering another. The constant is now derived from the register count.
- **`HyperLogLog`'s rank calibration was hardcoded for one register count.** The
  rank was `clz32(bits) - 5`, correct for a 26-bit remainder and silently wrong
  for any other width. Invisible while the count was a constant; exposed the
  moment it became a parameter, with m=1024 overestimating a 100 000-element set
  by 15x. The shift and the maximum rank are now derived from the count.
- **Four cross-realm `instanceof` defects, found by grepping the class rather than
  the site.** `AGENTS.md` records the rule — _"When you fix one site of a defect
  class, grep for the class and not for the site"_ — and three of these four were in
  files that had **already** been fixed for it. In every case a _neighbouring correct
  check_ is what made the file read as covered: `isError` in `memoizer.js`,
  `ArrayBuffer.isView` in `powerPool.js`, an `isArrayBuffer` call in the same
  expression in `core.js`. A future audit should treat "this file already uses the
  realm-independent helper" as a prompt to grep, not as evidence of safety. The
  reasoning is recorded in ADR 0016.

  - **`PowerCache.hasEqual` reported a `Set` as equal when it was not.** The `Set`
    branch groups members by a JSON signature, then falls back to a structural scan.
    Two members with the same signature that compared unequal were compared
    **twice**, and the cycle guard (`if (mapForA?.has(b)) return true`) answered the
    retry with `true`. **No cross-realm fixture is needed to reproduce it:**
    `Set[{a:1}]` vs `Set[new Foo()]` returned `true`, where the direct comparison of
    the same two values returned `false`. A plain object and a class instance with
    identical own properties produce the same signature, so they collided. Fixed with
    a generation stamp recording already-compared candidates, so the fallback never
    re-compares a pair. Mutation-checked 3/3.

  - **`simpleArgsKey` encoded every cross-realm `Date`, `RegExp`, `Map` and `Set` as
    `'O:{}'`** — the same key as an empty object _and as each other_. A live memoizer
    returned `at-1000` twice for two distinct inputs with **one** underlying
    invocation: a wrong value from a public API, not a missed cache entry.
    Mutation-checked 6/6.

  - **`PowerPool` encoded a cross-realm `ArrayBuffer` instead of transferring it, in
    fifteen places.** Views were never affected — `ArrayBuffer.isView` is
    realm-independent and every site checks it alongside the `instanceof` — but a
    bare cross-realm buffer was misclassified as a plain object at the gates, so it
    was JSON-encoded and structured-cloned rather than moved. The data survived, so
    this is a lost zero-copy optimisation rather than corruption; `awaitResponse` on
    the same path _was_ data loss, because it augments the message with a
    `correlationId` via `Object.assign`, which is only safe for a plain object.
    Mutation-checked 9/9.

  - **`markUntransferable()` reported a cross-realm `SharedArrayBuffer` as marked.**
    The guard was `typeof SharedArrayBuffer === 'function' && buffer instanceof
SharedArrayBuffer`, false for a foreign SAB, so it fell through to the platform
    marker and returned `true` — the one case where the answer is wrong rather than
    merely conservative. Mutation-checked 5/5.

- **`PowerHistogram` lost small values recorded after a large one.** Naive `+=`
  on mixed magnitudes discards the small addends: recording `1e16` and then a
  thousand `1`s gave a `sum` of `1e16`, an absolute error of -1000, because
  `1e16 + 1` is not representable. `Math.sumPrecise` was the obvious fix and does
  not apply — it sums an _iterable_, and a DDSketch does not retain its values,
  which is the whole point of the format; it is also `undefined` on this
  library's declared floor. The accumulator is Neumaier-compensated instead,
  which is the technique an incremental sum requires. Measured after: absolute
  error 0.

- **`PowerCache { admission: 'tinylfu' }` could never adapt to a working set that
  had changed, and froze permanently on the retired one.** Two defects, both
  required, both in the admission path:

  - **A refused key was never recorded in the sketch.** `set()` returned early
    when the admission filter refused a key, and `get()` only increments on a
    _hit_ — which a refused key never gets. So a key the filter had refused was
    invisible to the filter forever. The comment justifying this claimed counting
    a refusal "would let a scan inflate its own estimate by being refused"; that
    is wrong about what a scan does, because a one-shot key is requested _once_
    and reaches estimate 1 whether or not refusals are counted.
  - **The half-life clock stopped at saturation.** `SmallLfuSketch.increment()`
    advanced its sample counter only on an _effective_ increment — one that
    actually moved a counter. Once every counter saturates at the 4-bit maximum
    of 15, no increment is effective, so the clock stops and the sketch can never
    reset. Halving is the only thing that lets a counter fall below 15, and the
    admission rule refuses on `estimate(incumbent) >= estimate(challenger)`, so a
    counter pinned at 15 is unbeatable by construction.

  Measured before, on a 200-entry cache warmed on working set A for 20 000
  requests and then worked on a disjoint set B: hit rate 99.0 % → 49.5 % → 33.0 %
  → 24.8 % and still falling, with `evictions` 0, `rejectedAdmission` 60 000, and
  200 keys from the retired set resident against 0 from the new one. Plain LRU on
  the same trace recovers to 99 % immediately. After: the cache turns over exactly
  once — 200 evictions, ~20 200 refusals during the transition — and settles at
  65.7 % then 74.3 %.

  **The second defect is the one worth recording as a lesson rather than a bug.**
  The rule that caused it read as a refinement and had a precedent: Caffeine also
  advances only on an effective increment. The flaw is that a decay mechanism
  which stops when the data stops changing is not a decay mechanism. The "resets
  far more often than `sampleSize` describes" complaint was about the _rate_, and
  the fix for a rate is `sampleSize` — which ALG-005 already auto-tunes from
  observed cardinality, and which could not fire while the clock was frozen, so
  the auto-tune was dead in exactly the case it was needed.

  **Scan resistance was verified, not assumed.** The obvious risk of recording
  refusals is that a scan inflates its own estimate. It does not: on a properly
  warmed working set, retention is 100 % at every capacity from 4 to 200, before
  and after. An earlier probe that appeared to show a regression (100 % → 89 % at
  `maxEntries: 40`) was itself wrong — it warmed the "hot" keys with 30 reads over
  40 keys, leaving them at estimate 2 and indistinguishable from a one-shot key at
  1 plus collision noise. It measured the sketch's inability to discriminate in a
  workload where nothing was actually hot.

  **A first-sight exemption was implemented, measured, and rejected.** Making a
  key's first increment free — so a flood of one-shot keys cannot age the working
  set out — bought nothing: identical 100 % retention at every capacity, within
  noise on cold start (22.2 % against 22.9 % mean over 300 seeds), marginally
  _worse_ on the shift above (0.480 against 0.490), and it silently disabled the
  reset for any all-distinct stream, which is what made three existing tests
  fail. The reasoning is recorded in `SmallLfuSketch.increment()` so it is not
  re-derived.

  **What this does not fix, stated plainly.** On the sustained Zipf + scan
  workload `lru` + `tinylfu` now reads **93.0 %** working-set hit rate and
  **37.0/40** survivors, where it used to read 70.8 % and 15.0/40 — it now beats
  `policy: 'slru'` (89.4 %, 33.0/40) rather than losing to it. **The cold-start
  case is still far behind plain LRU and ADR 0003's first acceptance criterion is
  still not met:** 22.2 % mean hit rate against plain LRU's 80.0 %, over 300
  seeds, with a range of 2.5 % to 37.5 %. The collapse is no longer total — the
  working set now survives, at 36.5/40 mean against 0/40 before — and that is
  all. `admission: 'tinylfu'` therefore **stays off by default**, and the
  corrected figures replace the single-draw numbers the guide and ADR 0003
  previously quoted, because that workload draws a random sketch seed and 0.0 %
  was the bottom of a distribution rather than the value.
