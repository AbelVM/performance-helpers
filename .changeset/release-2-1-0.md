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

- `PowerApdex` — APDEX scoring over three integer counters. `record(ms)` classifies
  each completed request as satisfied, tolerating or frustrated against a required
  `target` and an optional `tolerance` (default `4 * target`, the APDEX
  convention), and `score()` returns `(satisfied + tolerating / 2) / total`, or
  `undefined` before anything is recorded. `merge()` is exact, so per-worker
  scorers aggregate; `dispose()` is a state reset, since the helper owns no timer.
  `record(Infinity)` files a request that never completed as frustrated.

- `PowerHistogram.countAtOrBelow(value)` — the inverse of `percentile()`: the
  estimated number of samples **at or below** a value, in O(log b) over occupied
  buckets. This is the rank query the sketch was missing, and it answers "what
  fraction of my requests were under X" directly.

- `PowerCache`'s `missCost` option, and the `missCostScan` width that bounds it.
  Every eviction policy this library ships answers _how often_ an entry is used;
  none answers _what a miss costs_. For a cache in front of an expensive
  computation those are different questions, and no recency- or frequency-based
  policy can see the difference.

  When the hook is set, the LRU eviction path evicts the **cheapest of the next
  `missCostScan` candidates** instead of the head. The hook receives both the key
  and the value. With no hook set the path is byte-for-byte the old one — one
  node read, one unlink, no scan.

  The measurement that sets the default, on a two-class workload (2000 cheap keys
  at 1 ms, 400 dear keys at 100 ms, a 500-entry cache, 10 % dear accesses):

  | `missCostScan` | dear keys re-read | dear keys one-off |
  | -------------: | ----------------: | ----------------: |
  |              1 |          baseline |          baseline |
  |              8 |        **−1.8 %** |            +0.0 % |
  |             32 |        **−7.3 %** |            +0.1 % |
  |            500 |       **−84.2 %** |        **+1.7 %** |

  The last row is the reason the default is 8 rather than something impressive. A
  full scan is dramatically better when expensive keys are re-read and measurably
  **worse** when they are not — it fills the cache with entries that will never be
  read again and evicts cheap ones that will be. The benefit is entirely a
  property of the caller's workload, which is why the hook is opt-in and the width
  is a knob. Both rows are asserted in `test/powerCache.missCost.test.js` as
  characterisations, including the adversarial penalty, so "the hook is free"
  cannot be claimed by reading only the beneficial row.

  Eviction becomes O(`missCostScan`) instead of O(1) when the hook is set. The
  walk is bounded and the bound is the design: an unbounded scan would be O(n) on
  the path that runs every time the cache is full.

  A throwing hook is treated as "no opinion" and falls back to recency for that
  candidate, for the same reason `onEvict` is guarded — the eviction path has no
  `try/catch` above it, so a callback error would otherwise turn a cache write
  into a crash. A non-number return is also "no opinion": `NaN` loses every
  comparison, so a candidate whose cost could not be read never wins.

  Mutation-checked 9 of 9 reverts killed by a named test. One of those nine
  established something worth recording: the `this.missCost ?` guard on the
  eviction path is a **performance** guard, not a correctness one. Removing it is
  behaviourally equivalent, because `_cheapestEvictionCandidate` still returns the
  eviction candidate when every cost reads as `NaN`. What changes is that the
  common path would call a `null` hook once per candidate per eviction and catch
  the resulting TypeError. The test that pins it spies on the method rather than
  measuring a duration, per the house rule.

- `PowerFlowController` — admission, queueing and latency feedback in one closed
  loop. It composes `PowerGCRA` (admission), `PowerQueue` (a bounded FIFO that
  counts what it drops), `PowerHistogram` (per-window tail latency) and
  `PowerServo` (the loop), with no new arithmetic of its own beyond deciding when
  the loop has something to learn.

  The producer side is `submit()`, which bounds the queue and increments
  `dropped`. The consumer side is `admit()`, which is the GCRA gate. The
  measurement side is `record()`, and the loop is `observe()`, which reads the
  p99 of the window, steps the servo, and writes the result into the limiter.

  Three decisions in it were settled by measurement rather than preference, and
  all three are recorded in the guide:

  - **The latency window resets on every observation that acts on it.** A
    cumulative histogram was measured first and is wrong for this plant: the loop
    then sees a _lifetime_ p99, so a rate that has already been cut keeps being
    judged against the traffic that justified the cut, and it never comes back.
    The consequence a caller has to know is that `p99` is the current, partial
    window rather than a lifetime figure.
  - **`minRate` must be greater than 0, and that is a hard requirement.** The
    actuator is a GCRA, whose rate must be positive, so `minRate: 0` is an option
    the loop cannot honour — it would throw on the first observation that reached
    the floor. Refused at construction, with a message that says to stop calling
    `admit()` instead.
  - **`ki` defaults to non-zero.** With `ki: 0` the output is `kp × error` alone,
    so a window that meets its target exactly produces an error of zero and
    therefore a rate of zero, which the `minRate` clamp turns into the floor.
    Measured: P-only settled at 11 % of the rate the plant could sustain at the
    target latency.

  The default gains (`kp: 0.05, ki: 0.001`) were measured on a plant stated in
  closed form — `latency = 5 ms + (rate / cap) × 90 ms` at a 30 ms target — where
  they reach both equilibria (111.1/s at `cap: 400`, 41.7/s at `cap: 150`) with
  **zero** overshoot on a load step, and hold that equilibrium across sample
  intervals from 100 ms to 2000 ms. The gain band is narrow and the guide says so:
  doubling the gains overshoots by 62 ms, and doubling again limit-cycles across
  the whole range. `saturated` is what distinguishes "the loop chose this rate"
  from "the loop wanted more and could not have it".

  Queue depth is deliberately **not** a control input, and the guide records why:
  a deep queue with healthy latency is a backlog to drain and a deep queue with
  unhealthy latency is overload to shed, and the same number means both. Depth is
  the bound, it is `stats().depth`, and it is the number to alert on — it is just
  not the process variable. This is also why the helper needs no sign inversion,
  unlike `PowerFlowControl`, whose guide devotes a section to the headroom trap.

- `PowerGCRA.setRate(rate)` — change the sustained rate at runtime, keeping the
  accumulated state. This exists because a closed loop needs a rate it can move,
  and the alternative was a trap: `rate` is a plain public field, but `_emission`
  and `_delayTolerance` are derived from it once in the constructor, so
  `limiter.rate = 500` changed the number `stats()` reported and nothing the
  limiter did. A composition that retunes a GCRA had no way to do it.

  The theoretical arrival time is **kept, not rescaled**, which is the
  conservative direction: the TAT is an absolute instant, so the debt it
  represents is debt in _time_, and re-spacing it onto the new emission interval
  would invent capacity the old rate never granted. Lowering the rate therefore
  makes the limiter refuse for longer, and raising it admits up to the new burst
  at once.

`PowerPool`'s `ready` option — a worker readiness gate.

```js
const pool = new PowerPool(WorkerScript, { ready: true });
// in the worker:
postMessage({ ready: true }); // once async setup is done
```

Without this, a task can be dispatched to a worker still running its constructor's async
work. The worker receives the message, cannot answer it, and the caller waits for a
response that will never come — which surfaces as a timeout rather than as a failure to
start.

- **The field name is yours.** Pass a string to name it (`ready: 'initialised'`), or
  `true` for the default `'ready'`. A worker posting `{ ready: true, version: 3 }` has
  signalled; the extra fields are ignored. A bare `true` works too.

- **The signal is pool-internal traffic.** It is consumed by the pool and deliberately
  _not_ forwarded to `message` listeners, which never sent it and would have to
  recognise it to be correct. It is also not a task, so it does not touch the task
  accounting.

- **`readyTimeout` fails open.** A worker that never signals is dispatched anyway after
  that many ms, so a misbehaving worker degrades to the old behaviour rather than
  wedging the pool forever. `0` (the default) waits forever.

**What happens to a post that arrives while nothing is ready.** With the task queue on —
the default — the work is _held_, not refused: the caller is not told "no" for a
condition that resolves in milliseconds. With `taskQueue: false` and no ready worker, the
post is refused instead, because the round-robin fallback would otherwise dispatch
straight past the gate.

An injectable `now` option on the four clock-driven helpers that lacked one:
`PowerDeadline`, `PowerCircuit`, `PowerCron` and `PowerEventLoopMonitor`.

MapLibre GL JS exposes `now()`, `setNow()`, `isTimeFrozen()` and `restoreNow()` so
an application can freeze time and get deterministic rendering and deterministic
tests. These four helpers read the module clock directly, so a frozen clock had no
effect on any of them — and `PowerCircuit` had no injection point at all, which
made it the one helper a caller could not drive from their own clock by any means.

This is not a performance gap, it is an integration gap, and it is the kind that
makes a library feel foreign in an ecosystem: the host has a time-freezing
convention and we did not honour it.

The scope was corrected during implementation. An earlier revision of the analysis
listed ten helpers as having no injection point; reading the source showed six
already accept `now` — the four limiters via `attachLimiterClock`, plus
`PowerTTLMap` and `cache/core`, both of which carry a comment citing PERF-007. The
real gap was four. The lesson is the one `AGENTS.md` records about guessed shapes:
_read the code before writing the list._

`PowerCircuit` defaults to `monoMs()`, which `src/utils/now.js` documents as
deliberately unmovable — it never reads `Date.now()`, so a harness that fakes the
wall clock cannot drive it. Injecting a clock is the only way past that for this
class, and it is now the documented one.

The 141 ns `nowMs()` measurement that PERF-007 and RES-019 are built on is not in
the path: each helper resolves `this._now` once in its constructor and calls it,
which is one property lookup — the same shape `PowerTTLMap` and `cache/core`
already use.

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

- `PowerHistogram`'s cached bucket order now carries cumulative counts alongside
  the sorted index list, so `countAtOrBelow()` does not walk the occupied range.
  One cache rather than two, invalidated at the same four sites.

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

Three guides documented methods that do not exist, each inside a **runnable code
example** — the one place no check in this repository could see:

- `guides/powerServo.md` and `guides/powerFlowControl.md` told the reader to call
  `pool.setConcurrency(n)`. `PowerPool` has `resize(n)` ("Resize the pool's
  maximum size at runtime"); nothing named `setConcurrency` exists anywhere under
  `src/`. A reader following either example got a `TypeError`.

- `guides/powerEventLoopMonitor.md` called `metrics.gauge(...)` in three places
  and `metrics.increment(...)` in a fourth. `MetricsCollector` declares
  `register`, `unregister`, `snapshot` and `names`, and nothing else. All four
  are now the real `metrics.register(name, read)` pull form, matching
  `guides/metrics.md`.

  The same examples were also missing the binding for `metrics` itself — it is
  not a package export, only a local `const` in `guides/metrics.md` — so a reader
  hit a `ReferenceError` before reaching the `TypeError`. Both blocks now carry
  the `import { MetricsCollector }` and the `const metrics = new MetricsCollector()`
  they were missing.

- `PowerGCRA` carried an orphaned docblock. A `tryConsume` comment ("Try to
  consume one operation", `@param {number} [n=1]`) sat above `_notifyClock`'s own
  docblock, separated from the real `tryConsume` docblock twenty lines below by
  the insertion of `_notifyClock` between them. Typedoc attaches the first block
  it finds, so `_notifyClock` was documented as consuming operations. Both
  members are private, so the published types and API reference do not move.

### Benchmarks

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

Four `bench/claims.js` modes that settle questions the geospatial ecosystem keeps
guessing at. All four were added for
[ADR 0015](../adr/0015-geospatial-scope.md); before they existed the questions had
no answers either way.

- **`geoencode`** — four arms on one payload, in a real worker, on the real call
  path: `JSON.stringify` → post string → `JSON.parse`; structured clone of the
  object graph; structured clone of a flat `Float64Array`; zero-copy transfer of
  that buffer. Measured on the MapLibre #106 shape (200 LineStrings × 4,500
  coordinates) and on 200k points.

  The stringify measurement — **196.69 ms** — independently confirms MapLibre
  #106's reported _"about 200ms"_ on the same payload shape, on a different
  machine and a different V8. That the harness reproduces a number reported by
  someone else is the strongest available evidence that it models the real call
  path rather than a synthetic one.

  Three findings, and the third is the one that matters:

  1. **Structured clone of the object graph is _slower_ than JSON** (393.75 ms
     against 296.91 ms). The obvious "just `postMessage` the object" answer is
     worse than what MapLibre already does.
  2. **A flat buffer is 47× faster than the object graph** on the #106 shape and
     232× on points.
  3. **The win is flattening, not transferring.** Cloning a _flat_ buffer (1.66 ms)
     is within timer resolution of transferring one (~1.3 ms after subtracting the
     7.06 ms build). Chrome's ~46× transfer figure does not reproduce at this
     size.

- **`geocoalesce`** — a coalescer against `PowerBatch` + a `Map`, measuring diff
  _quality_ (mutations coalesced, mutations dropped, drop policy honoured) rather
  than latency alone. **The rejection condition fired:** at every window swept
  (1/2/4/16 ms) the coalescer is at best equal to `PowerBatch` + a `Map` on work,
  and it always applies fewer mutations — 1,716 against 1,961 at a 16 ms window, a
  12.5% fidelity loss, because a longer window collapses more under
  last-write-wins. Fewer applied is not free: it means staler positions on screen.

  A note on the harness, because it nearly measured nothing. The first draft
  consumed the stream in one synchronous `for` loop, so every mutation arrived in
  the same event-loop turn: `PowerBatch` flushed once, the coalescer's window fired
  once, and all three coalescing arms tied at one update each. That is the
  `setImmediate`/608× lesson in `AGENTS.md` reproduced almost verbatim by a harness
  that looked reasonable. Mutations now arrive in per-frame batches with a real
  delay between frames, and `CLAIM_COALESCE_FRAME_MS=0` uses `setImmediate` so the
  loop still turns without charging every arm the same artificial wait.

- **`geoprecision`** — what rounding coordinates actually saves, on two payload
  shapes and both representations. **The finding is in the flat column, and it is
  zero:** a `Float64Array` is 8 bytes per coordinate whatever the value, so
  rounding does not shrink it at all. The saving is entirely on the JSON side, and
  it is shape-dependent — 40.6% on line-heavy data, only 10.8% on point-heavy data.

  So MapLibre's "reduce coordinate precision" advice is worth 40% on a line-heavy
  dataset and 11% on a point-heavy one, and nothing at all once you have flattened.
  The win is representation choice, not a rounding pass.

- **`geoprefetch`** — what in-flight window a camera prefetch should use, and the
  answer is that **the window is the wrong knob.** GEO-049's UC4 needs a priority
  cursor bounded by an in-flight window; MapLibre PR #8670 measures 12 as optimal
  against Chromium's ~6 connections per origin and states the ratio explicitly, but
  that ratio is host-dependent, so a recipe that hard-codes it is a claim without a
  number. The mode sweeps the window against a simulated per-tile latency and
  reports requests issued, requests abandoned mid-flight, and work still
  outstanding at arrival.

  **The determinant is lead vs latency, not the window.** With the defaults — 60
  frames of read-ahead, 1 002 ms, against 600 ms per tile — the lead covers the
  latency, so no tile can land late and none can be abandoned: every window reads
  **0.0 % waste**, and the window controls only how far ahead you read (`issued`
  30 / 60 / 96 at windows 6 / 12 / 24) and how much is still in flight when the
  camera lands (`outstanding` 6 / 12 / 0). A window that is too small puts the
  churn back; one that is too large holds requests that queue behind the render
  loop.

  Drop the lead below the latency and the waste appears, and **a larger window
  makes it worse, not better**: at 2 000 ms per tile over a 10 s flight, windows 6
  and 12 both waste 77.8 % and window 24 wastes 87.5 %. The window cannot fix a
  lead that is too short — raise the read-ahead first.

  Two caveats the mode prints itself. **It is a simulation, not a measurement of a
  real browser:** it cannot discover the host's connection limit, so the limit is
  injected (`CLAIM_PREFETCH_CONNECTIONS`, Chromium ~6) and the crossover is
  host-dependent even though the shape of the trade-off is not. And PR #8670's 23
  abandoned at window 6 came from a real browser whose sampled path and actual path
  diverge; this model uses one path for both, so it cannot reproduce that term.

All four modes are seeded (`makeRng(SEED)`, not `Math.random()` — BENCH-001's
unseeded randomness is a recorded defect) and every parameter is overridable from
the environment.

- `bench/claims.js` gains a `flowloop` mode, measuring AUD-031's proposal for
  `PowerFlowController` — "nothing that combines admission + queue depth + latency
  feedback into one closed loop" — against a fixed rate. **The closed loop is worth
  building, and the gain band is narrow.** The plant is deterministic and stated in
  closed form (`latency = 5 ms + (rate / cap) × 90 ms`), so the equilibrium rate is
  arithmetic rather than something to argue about: at a 30 ms target, cap 400
  sustains exactly 111.1/s and cap 150 exactly 41.7/s. The run halves capacity
  halfway through, so the second equilibrium has to be _tracked_ rather than merely
  reached, and the clock is injected and advanced by hand so the run is
  deterministic.

  The `fixed` control — a rate set to the initial equilibrium and never moved —
  sits at **71.7 ms p99 after the step, 2.4× the 30 ms target**, because it cannot
  adapt. The defaults (`kp .05`, `ki .001`) settle in 10 ticks with **0.8 ms** of
  post-settling overshoot and land on **41.7/s against a closed-form 41.7/s**,
  equilibrium error 0.0; the best arm measured is `kp .1 / ki .0005` at 7 ticks and
  0.3 ms.

  The aggressive settings do not settle slowly, they fail to control: `kp .5 /
ki .05` never settles (final 223.8/s against 41.7/s, equilibrium error 182.1, a
  440.7 ms transient, 12 rate reversals) and `kp .2 / ki .01` limit-cycles at
  134.4 ms of overshoot with 10 reversals. **The defaults sit inside the band and
  the aggressive settings do not** — which is the number the guide quotes, now
  reproducible rather than asserted.

  One selection rule is recorded because the first version got it wrong: **"best"
  is the smallest post-settling overshoot among arms that actually reach the
  equilibrium.** Without that qualifier the P-only arm (`ki 0`) wins on a
  technicality — it drives the rate to the floor, where latency is trivially under
  target, and reports zero overshoot while admitting 12% of what the plant can
  sustain. That is a controller switched off, not a controller working. The two
  overshoot figures are also reported separately, because conflating them is how a
  controller gets credit it has not earned: the **transient** is unavoidable (the
  loop cannot have adapted to a change it has not yet observed), while the
  **overshoot** after settling is the controller's own error and the one the gain
  band moves.

### Tests and gates

`test/docsCodeAgreement.test.js` gains **GATE-010**, which scans fenced code
blocks for `recv.method(` calls. GATE-002 and GATE-005 both scan _inline_
backticked calls and neither can see a code block, because a block holds raw
`obj.method(` rather than a backticked name. That is exactly the shape of the bug
GATE-002 was written for: `guides/powerPool.md` documented `prepareBuffer` in its
API list **and called it in a runnable example**, and only the API list was ever
checked.

Two layers, both measured before being written:

- **Precise** — resolves a receiver to a class constructed in the same block
  (`const pool = new PowerPool(`) or to a library singleton
  (`defaultMetrics` → `MetricsCollector`), and requires the method to be a member
  of that class. 274 call sites, 0 mismatches.

- **Union** — for unresolved receivers, requires the method to exist somewhere
  under `src/` or in a stop-list, skipping platform-global receivers
  (`Promise.all(`, `JSON.stringify(`, `Math.ceil(`). 409 call sites, 0 mismatches.

Mutation-checked with three planted faults, all caught: a bogus method on a
resolved receiver, a bogus method on an unresolved receiver, and a bogus method
in `metaGuide.md` — the highest-traffic guide in the repository, and one that
only this gate can reach.

The union layer accepts a name that exists _anywhere_ under `src/`, so a wrong
method on a library object passes if an unrelated class happens to declare it.
`metrics.increment(` was exactly that: `src/utils/smallLfu.js` declares an
`increment`, so the union layer would have accepted a call `MetricsCollector`
does not have. It was found by reading the guide, not by the gate. The precise
layer closes that hole for every receiver it can resolve; for the rest a reader
is still the backstop, and the limitation is recorded in a comment at the check
rather than left for the next person to assume otherwise.

`test/geoClock.injection.test.js` — 15 cases driving each helper from a clock the
test owns, which is the only way to assert deadline and window behaviour without
sleeping. Two of them pin failure modes worth recording:

- A **frozen** clock does not work for `PowerEventLoopMonitor`: `_record` drops
  negative drift readings as a backwards clock, and a frozen clock makes every
  reading `now - scheduledFor` negative, so nothing is ever sampled. The clock has
  to track real time and be jumpable.

- `PowerCircuit`'s drawn open window is jittered between `timeout × 0.5` and
  `timeout` (`DEFAULT_CIRCUIT_MIN_JITTER_RATIO`), so an exact boundary assertion is
  a coin flip. The test asserts the two ends the jitter cannot cross.

13 tests in `test/powerPool.readiness.test.js`, mutation-checked 5 of 5 — including
reverting the single-worker fast path, which is where the first draft of the
implementation was wrong.

Two things about that first draft are worth recording. `singleWorkerDirectFastPath`
resolves `least` to `this.workers[0]` directly and never reaches `_selectWorker()`, so
with `size: 1` the gate was bypassed entirely — measured, a `size: 1` pool with
`ready: true` delivered the first post to a worker whose `ready` was still `false`. And
the ready signal was matched on `data` _before_ the codec's decode block, so it matched
nothing: the codec wraps a payload as `{ version, codec, value, byteLength }`, and
`data.ready` was `undefined` for every real signal.

Two of the tests also started from a wrong premise and were corrected rather than
loosened. The first asserted a _refusal_ when nothing is ready, but the pool queues —
which is better, and the reason the refusal tests now need `taskQueue: false` to reach
the path they mean to test.

### Design notes

`PowerApdex` does **not** compute its score from a `PowerHistogram`, although
that would have been less code and no new state. `bench/claims.js apdex`
(BENCH-002m) measures the derived version: within 0.057 APDEX points of exact on
a lognormal, bimodal or pareto distribution, and **324 points wrong** — reporting
0.625 for a service attaining 0.950 — when the mass concentrates inside one
bucket straddling the threshold. The error is not monotonic in
`relativeAccuracy`, so there is no accuracy setting that repairs it, and a service
operating at its own SLO boundary is exactly that distribution. The exact path is
also a seventeenth of the per-sample cost and `O(1)` in memory. See
`adr/0014-apdex-counters-not-a-sketch.md`.

`countAtOrBelow()` ships as a general rank query and is documented as unsound for
an SLO attainment figure, with the number, in both its JSDoc and
`guides/powerHistogram.md`.

`guides/powerApdex.md` and `guides/metaGuide.md` carry recipes for pairing
`PowerApdex` with `PowerBrownout`, windowing it with a double buffer, and scoring
per route — and a section on why it must **not** be used as an adaptive control
signal. Every adaptive helper in this library takes a signed, unbounded,
gradient-carrying quantity (`PowerServo`, `PowerFlowControl`,
`PowerAdaptiveProposal.propose(signal)`, the pool's EWMA-latency autoscale);
APDEX is a bounded ratio that saturates at `1.0` and goes blind exactly when the
SLO is being met. No meta helper was added, because the one sound composition is
three lines of caller code. See
`adr/0014-apdex-counters-not-a-sketch.md`.
