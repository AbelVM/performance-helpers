---
'performance-helpers': major
---

This release is long, and the length is the point: it records two dozen commits
of audit remediation, every claim that measurement retracted, and the benchmarks
that replaced them. Read it by section rather than end to end.

| if you want                                         | read                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| what to know before upgrading                       | **Breaking** below, then `## Migrating`                                      |
| the three things that changed direction             | `## What a reader should know about 2.0` in `CHANGELOG.md`                   |
| whether a performance claim survived                | `## Reading a claim in this project` in `CHANGELOG.md`                       |
| why a proposal was closed rather than built         | the `### From <file>` sections under `## Folded in`                          |
| the incremental frame decoder                       | `## createFrameDecoder()`                                                    |
| cache iteration, cancellation and the queue ring    | `## Cache iteration, the window memo, retry cancellation and the queue ring` |
| the benchmark modes, and which numbers they retired | `## Benchmarks: the numbers that were not numbers`                           |

The wire protocol, the histogram, and the release process all changed: 23
commits of audit remediation, two new helper families, and a real release
pipeline.

**Breaking**

- **Out-of-range options now throw instead of being silently coerced** in
  `PowerCircuit`, `PowerPermitGate` and `PowerDeadline`. Each read `0` as
  "absent" and substituted a plausible default, which was the wrong answer:
  `new PowerCircuit({ threshold: 0 })` gave a breaker that **never trips** and
  `{ timeout: 0 }` gave a 30 s open window; `new PowerPermitGate({ capacity: 0 })`
  gave a gate holding **one permit** rather than none, and a gate configured to
  allow nothing is how you switch a dependency off; `PowerDeadline` clamped
  `maxAttempts: 0` and `-5` to 1 and turned `retryDelay: 'soon'` into 0. If you
  were relying on the coercion, pass the value you actually meant — and note that
  `capacity: 0` and `threshold: 0` now throw rather than quietly doing the
  opposite of what they say.

  Three cases are deliberately _still_ accepted, because they are requests
  rather than mistakes: `PowerPermitGate`'s `queueCapacity: 0` and
  `initialTokens: 0` ("start empty and let it refill" is the point of a token
  bucket, so `initialTokens` is clamped to capacity rather than rejected), and
  `PowerCircuit`'s `maxTimeout`, which is derived from `timeout` only when
  omitted so an explicit `maxTimeout: 0` still throws.

- **`PowerPool` no longer under-reports `activeTasks` when a terminated worker replies late.** Terminating a
  worker with tasks in flight settles them in bulk, and a `message` already in flight from that worker still
  reaches the pool handler afterwards — which decremented the global counter a **second** time. The existing
  `Math.max(0, …)` clamp could not prevent this: it guarded the _per-worker_ count, while the thing being
  double-decremented was the _global_ `_activeTasks`. The counter then fell below the number of tasks actually
  running, so `getStats().activeTasks` under-reported, `_isIdle` could go true with work outstanding, and
  `drain()` resolved early against a pool that was not idle. Each worker is now marked settled when its tasks
  are drained, and a late message from it is ignored for accounting purposes.
  **The bug is only observable when the counter is above zero**, because the clamp absorbs a double decrement
  against `0` — so a single-worker reproduction passes against the broken code. The late message has to be made
  to steal a count belonging to a _different, still-working_ worker, which is the user-visible failure; the
  tests do exactly that and were checked to fail with the fix disabled. One consequence is recorded rather than
  fixed: the guard returns before correlation-id handling, so a caller awaiting a response from a worker that
  was terminated late still waits — settling those promises is a separate concern from idempotent accounting.
  (The `_taskTokenSeq` field that previously claimed to solve this does not exist and never did; its JSDoc was
  removed rather than implemented, since a per-worker settled flag covers the actual hazard.)
- **The last six constructors now validate their numeric options**, closing BUG-024's
  "still hand-rolled in ~10 constructors". Thirteen of seventeen had already moved to the
  shared `assertLimitRequired`; `PowerBulkhead`, `PowerEventBus`, `PowerSubscriberSet`,
  `PowerRealtimeHub`, `PowerLatch` and `PowerWebSocketClient` had not. **They were not
  wrong in the same direction, which is why a single blanket rule would have broken half
  of them.**

  - **`PowerBulkhead`'s `queueCapacity: 0` produced the _largest_ queue the class supports.**
    `Math.max(0, Number(x) || 100)` turns `0` into `100`. `PowerPermitGate` documents
    `queueCapacity: 0` as a legal request — "refuse immediately instead of queueing" — and
    this quietly turned that request into the full default. A value that reads as "no
    queue" and produces the biggest queue is a contradiction, not a coercion. **`0` is now
    honoured.** `partitions: 0` produced `4` (you asked for one partition, you got four)
    and `maxConcurrency: 0` produced `1` — the same mistake `PowerPermitGate.capacity` had
    already stopped making, where a bulkhead configured to allow nothing silently admitted
    one task. Both now throw.
  - **`maxListeners: -5` meant _unlimited_.** On `PowerEventBus` and `PowerSubscriberSet`,
    `Math.max(0, -5)` is `0`, and `0` is the documented "no cap". So a typo silently
    **removed the limit that exists to bound a listener leak** — the one direction where
    being permissive makes the failure worse rather than better. `0` is kept, negatives and
    non-finite values now throw.
  - **`pollIntervalMs: 0` meant `20`.** A zero poll interval is a busy loop, not a
    request, and the backoff curve built on top of it was tuned to a default the caller
    never chose. It now throws. The options where `0` _does_ switch a mechanism off —
    `heartbeatIntervalMs`, `heartbeatTimeoutMs`, `highWaterMarkBytes`,
    `lowWaterMarkBytes`, `connectTimeoutMs` — keep accepting it.
  - **`PowerLatch`'s count and `PowerRealtimeHub`'s `batchDelayMs`** accepted a `NaN` as
    `0` by way of `|| 0`. A `NaN` latch silently does not latch: `wait()` returns at once
    and nothing is ever waited for. A `NaN` batch delay flushes immediately, which looks
    like a bug in the hub rather than a bad argument. Both now throw on negative and
    non-finite values; `0` is still a real state for each.

  `test/optionValidation.remaining.test.js` asserts the _specific_ coercion each option
  had, not a generic `toThrow()` — a throw-only test would have passed against the
  original code for a different reason — and proves the surviving `0` cases through
  behaviour (a cap that raises on overflow, a latch that resolves, a hub that flushes)
  rather than by adding getters that exist only for a test.

- **`PowerPool`'s `minSize`, `maxSize` and `idleTimeout` are now validated too**, and the
  failure mode they had was worse than a wrong default: `Math.max(0, value)` is
  silent when `value` is not a number, because the result is `NaN` and **every
  comparison against NaN is false**. A pool constructed with `minSize: 'lots'` did
  not complain — its reaper's idle comparison could never be true, so it silently
  never terminated a worker while reporting a worker count of `NaN`. All three now
  throw a `TypeError` naming the option.

  **Zero remains legal for every size option**, because "start with nothing and grow
  on demand" is a real configuration; `idleTimeout: 0` and `Infinity` are likewise
  both meaningful and both still accepted. `maxTasksPerWorker` is deliberately
  **un**validated — `0` there means "every worker is immediately full" and is used
  that way deliberately, and unlike the size options it is always finite, so it never
  produced the `NaN` this fixes.

- **`PowerMemoizer` keys changed format.** The default `keyResolver` is now
  `simpleArgsKey` rather than `(...args) => JSON.stringify(args)` — ~35%
  cheaper for the scalar arguments memoizers are actually called with, falling
  back to `JSON.stringify` the moment it meets a non-scalar. A memoizer's
  `.cache` is in-memory and not a persisted format, but a caller reading keys in
  a test or a debug dump will see the difference. Pass `keyResolver` explicitly
  to keep the old shape.

- **`PowerPool` frames every message.** The pool now posts a
  `PowerMessageCodec` frame (`[u8 version][u8 codec][u32 length][payload]`)
  instead of a bare `Uint8Array` of JSON, and decodes replies with
  `decodeMessage` rather than sniffing them. A `Uint8Array` task with no
  `transfer` list is framed under the `raw` codec; a supplied `transfer` list
  still means "I own this buffer". Set `messageCodec: 'legacy'` to keep the old
  framing while you migrate. **A worker must reply in the shape it received** -
  a `legacy` pool sniffs replies, and a framed reply leaves its `awaitResponse`
  promise pending forever. Migration steps are in `guides/powerPool.md`.
- **`PowerHistogram` is now a DDSketch.** The fixed dense log buckets over
  `[boundaryMin, maxValue]` clamped every value above `maxValue` into the last
  bucket, so a single 100 ms spike in a 10 ms dataset reported `p99.9` as
  20 ms - 5000x under-reported, with no warning. It is replaced by a DDSketch
  (the format OpenTelemetry uses) with a relative-error bound:
  `{ relativeAccuracy: 0.01 }` by default, unbounded range, and a new `merge()`
  for cross-worker aggregation. `maxValue` and the bucket-count options are gone.
- **Invalid constructor options now throw instead of being coerced.**
  `PowerCache`, `PowerBatch`, `PowerGCRA`, `PowerQueue`, `PowerSlidingWindow`
  and `PowerThrottle` reject non-finite and out-of-range limits with a
  `TypeError`. Previously `new PowerCache({ maxEntries: NaN })` disabled
  eviction entirely, and `maxSize: 0` silently became `Infinity`.
- **Timers no longer hold the Node process open.** Every internal timer is
  `unref()`ed, so a live `PowerCache` with `startCleanup()` no longer hangs a
  CLI or a serverless handler. Pass `{ keepProcessAlive: true }` where the
  helper offers it if you relied on the old behavior.
- **`dist/` is published.** `main` and the `require` condition now point at
  the built CJS bundle rather than ESM source, so `require('performance-helpers')`
  is in sync with `import`. The per-module subpaths stay ESM-only.

**New**

- **`PowerMessageCodec`** - explicit versioned framing for structured messages
  (`json`/`raw`), plus `encodeNative` for the platform structured clone. It
  throws on a short header, an unknown version, an unknown codec, or a truncated
  payload rather than mis-parsing, and returns `byteLength` so a stream reader
  can frame-split a batched socket message.
- **`PowerRealtimeHub`** - topic fan-out over a transport-agnostic `send`
  adapter, with per-subscriber bounded queues and an explicit slow-consumer
  policy (`drop-oldest` / `drop-newest` / `disconnect`). It has no WebSocket
  dependency: the same hub drives a browser socket, a Node `ws` socket, a
  `MessagePort` or a test spy.
- **`PowerWebSocketClient`** - connect state machine, `AbortSignal` timeouts,
  auto-reconnect with decorrelated-jitter backoff, `ping`/`pong` heartbeat with
  RTT into a `PowerHistogram`, and two tiers of real back-pressure:
  `bufferedAmount` watermarks everywhere, and `WebSocketStream` when the runtime
  provides it.
- **`PowerGCRA`** - the Generic Cell Rate Algorithm: one number of state, O(1),
  and an _exact_ `retryAfter()` instead of an estimate. `PowerThrottle` is
  unchanged.
- **`PowerCache` `{ policy: 'slru' }`** - probation/protected segments, opt-in.
  Under a 500-key one-off scan over a 40-key hot set, 40/40 keys survive with
  `slru` against 0/40 with `lru`.
- **`autoScale.policy`** gains `aimd`, `vegas` and `gradient2` alongside the
  existing `ewma` default.
- Every resource-owning class gained `dispose()` and `[Symbol.dispose]`, so
  `using` and `await using` work throughout.
- **`PowerRetry` gained three independent mechanisms**, because the backoff
  curve alone does not address the two retry failure modes that actually hurt
  in production — a retry storm amplifying load on a failing dependency, and a
  p99 orders of magnitude above the p50.
  - **`backoff: 'decorrelated'`** implements AWS, _Exponential Backoff and
    Jitter_ (2015): each delay is drawn against the **previous** delay
    (`min(cap, random_between(base, prev*3))`) rather than recomputed from a
    formula. The existing `2^attempt * random()` re-derives the same curve every
    time, so a fleet that failed together keeps re-synchronising. Being a random
    walk, it rejects `jitter: false` rather than silently ignoring it.
    **A `backoff` outside the four supported strategies now throws** — the
    implementation was `linear | fixed | else exponential`, so `'exp'`
    silently produced an exponential curve the caller never asked for.
  - **`PowerRetryBudget`** (new export) bounds **retry traffic** by the Google
    SRE Workbook's _Handling Overload_ rule: each request funds the bucket,
    each retry spends from it, so retries throttle exactly when the dependency
    can least afford them. It starts **full** — a bucket starting empty would
    refuse the first retry of a fresh budget (one request funds 0.2 of a token,
    a retry costs a whole one), engaging the protection on a _healthy_
    dependency and disengaging on the sick one. Accepts a `PowerRetryBudget`, a
    `{ ratio, capacity }` object, or a bare ratio; a ratio above 1 throws. **It
    only binds if it outlives a single call**, so the `PowerRetry` constructor
    builds one that every `run()` shares.
  - **`hedgeDelay`** sends a duplicate of the _first_ attempt if it has not
    returned in time; the first to succeed wins and the loser is aborted. Only
    attempt 1 is hedged — hedging every attempt would turn `maxAttempts: 3` into
    6 requests on the wire — and a hedge draws a budget token like any retry.
    Off by default because it raises average load and only pays off if `fn`
    honours its `AbortSignal`.
- **`admission: 'tynilfu'` is now a no-op under `policy: 'slru'`,** and composing the two scan-resistant options no longer
  produces the worse of each. SLRU's probation segment is the same mechanism the sketch provides — both absorb one-shot traffic
  before it reaches the main region — and stacking them is not a weaker version of either but a worse cache. Measured on
  `node bench/claims.js zipf`, `slru` + `tinylfu` retained **70.9 %** of the working set against `slru` alone's **89.4 %**, so a
  user reaching for both got the worse of each. Asking for `slru` now gives you `slru`, unchanged, and no sketch is built, so
  the option costs nothing there. **Breaking, because the combination now does _less_** — but it is doing the right thing, and
  `slru` on its own is the fastest scan-resistant configuration in the benchmark by a wide margin.
  **The W-TinyLFU admission window this option was heading towards is not in this release.** Its mechanics are implemented and
  verified, and it fixes the cold-start collapse — but it still measures _worse than plain LRU_ on working-set hit rate
  (59.6 % against 75.0 %), so it did not meet its own acceptance criteria and shipping it under the same name would have been
  the wrong trade. `design/0001-tinylfu-admission-window.md` has the full story: the mechanism, the seven rules the
  implementation needed, the three retracted hypotheses, and the cheap experiment that would settle whether a frequency
  filter earns its keep here at all.

- **`PowerPool`'s message path no longer copies every payload in order to avoid being copied.** The encode cache
  handed out a fresh `u8.slice()` per message so the buffer could be **transferred** rather than copied by the structured
  clone — which looks like the fast path, since a transfer is zero-copy. It is the opposite, and the reason is worth
  stating: the copy being avoided is a **native** one and the copy being paid is an **interpreted** `memcpy` of the whole
  payload. Measured over a Zipf-ish repeat mix of 200 × 200-byte messages, one variable at a time:

  | path                                                     | per message |
  | -------------------------------------------------------- | ----------: |
  | encode + cache, `slice()`, transfer (the old default)    |     2942 ns |
  | encode + cache, hand the cached buffer over to be copied | **1557 ns** |
  | encode every time, `slice()`, transfer (no cache)        |     3441 ns |

  The slice cost ~1385 ns. **The encode cache is emphatically not the problem** — dropping it costs ~1900 ns, nearly
  twice what the slice costs — so it stays and the slice goes. `prepareBuffers(items, { clone })` now defaults to
  `clone: false`, which hands over the cached buffer with no transfer list so the runtime copies it and the cache entry is
  never detached. Pass `{ clone: true }` for a private transferable copy, as before.
  **No pool-level speedup is claimed.** Five runs of the end-to-end `postMessage` path on this machine gave 1847/3506/
  3654/3288/2562 ns before and 2658/2745/2016/2650/1879 ns after — overlapping ranges spanning nearly 2×, consistent with
  the 28 % median spread BENCH-001 measured here. The figure above is the isolated prepare path; the end-to-end path is too
  noisy on this hardware to confirm or refute it, and saying otherwise would be the same overclaim BENCH-001's note warns
  about.

- **`PowerThrottle`, `PowerSlidingWindow`, `PowerGCRA` and `PowerRateLimit` can now be told what time it is,
  and a composition reads the clock once instead of once per limiter.** `nowMs()` reads _two_ clocks per
  call - the high-resolution one and `Date.now()`, the second purely to check they have not diverged under
  a test harness - and measures ~141 ns, against a whole `tryConsume` of ~120-165 ns. An N-limiter
  composition therefore spent N readings deciding what time it was, which is most of the call and all of it
  duplicated: every limiter inside a single `tryConsume` is deciding at the same instant. `tryConsume`,
  `reserve`, `available` and `retryAfter` now take an optional `{ now }`, and `PowerRateLimit` reads once
  per composed call and threads that value into every leg - including the `available()` pre-flight, which
  was a second N reads. Each limiter also takes a `now` **constructor** option for driving a fake clock.
  **The two are deliberately asymmetric, and the rule is the substantive part: a limiter constructed with
  its own `now` ignores any per-call value.** An injected clock always wins, because a limiter built with a
  fake clock is a limiter _under test_, and a composition overriding it mid-run would make the test silently
  measure something else. **The composition takes no constructor `now` at all** - `now` is a function on a
  limiter and a number in a composition's per-call options, and one name meaning two types on adjacent APIs
  is a trap; the per-call value covers every use it did, since the composer reads once and tells everyone.
  A limiter that takes no second argument reads its own clock, so threading needs no capability check and
  works with third-party limiters unchanged. **No speedup is claimed**: the win is arithmetic - one reading
  instead of N, at ~141 ns each - because the previous attempt at this item measured _below the noise
  floor_, and a benchmark on shared CI would be a number nobody could reproduce.
- **`PowerSocketAdapter`** (new export) normalises the three socket models a server actually
  receives — Node `ws` (EventEmitter), browser `WebSocket` (EventTarget) and `WebSocketStream`
  (streams) — behind one interface, and adds socket-level liveness, per-message rate limiting and
  a graceful `drain()`. **There is no WebSocket server in this package, and there deliberately is
  not one** (REJ-007): RFC 6455 is a security liability to reimplement and `ws` already does it.
  What was missing is the layer either side of one. The models are genuinely incompatible and the
  mismatches fail _silently_ — a `message` handler written for `ws` receives `(data, isBinary)`
  and never fires against an `EventTarget` socket, `addEventListener` throws against a `ws`
  socket, and a `WebSocketStream` has neither `on`, `readyState` nor `bufferedAmount`, so the
  MDN-recommended `bufferedAmount` pause loop cannot be written against it at all. This is the
  same normalisation `WorkerAgnostic` already does for `Worker` constructors, applied to sockets.
  Transport is detected by **capability, not constructor name** — the same class is reachable as
  `ws` in Node, `undici`'s `WebSocket` in newer Node, and the browser global, and the last two are
  different objects sharing a name. An unrecognised object throws rather than defaulting, because
  a silent default attaches no listeners and looks healthy while receiving nothing.
  **Three things the first draft got wrong, each caught by writing the test before the claim:**
  the heartbeat listened for `ws`'s `ping` event instead of `pong` — `ping` is what a _server_
  receives from its clients, so every client's ping would have read as a liveness answer while the
  server's own probes read as dead, inverted in both directions; stream detection required
  `getWriter` on the socket rather than on `socket.writable`, so every `WebSocketStream` was
  misdetected; and `send()` took a fresh `getWriter()` per call, but `getWriter()` _locks_ a
  stream, so the second send on a stream adapter would have thrown and the stream would have
  stayed locked for the life of the object. The writer is now acquired once and released on
  `dispose()`. `drain()` resolves **`false`** on timeout rather than `true`, because pretending a
  drain finished cleanly is how a deploy silently drops work. On transports with no `ping()` the
  adapter reports `canPing === false` in `stats()` and does not pretend to be heartbeating.
  **Two deliberate scope boundaries:** the adapter exposes `bufferedAmount` as a getter for a
  caller to poll but does not implement producer-side pause/resume (a `WebSocketStream` has no
  such signal, and the outbound watermark loop belongs to the client, which is
  `PowerWebSocketClient`'s job); and `send()` on a stream is synchronous-and-refusing rather than
  queued, so a caller wanting fire-and-forget there must await `drain()` and retry.

**Fixed**

- **`PowerScheduler`'s `scheduling: 'macrotask'` no longer pays Node's timer clamp.** It posted via `setTimeout(fn, 0)`, and Node clamps a zero timeout to **1 ms**, so every flush cost a full millisecond. It now posts to a `MessageChannel` — a real macrotask with no clamping floor, available in Node and every browser — falling back to `setImmediate` and only then to `setTimeout`. Measured over 10 000 macrotasks in this runtime: **37 ms against 10 554 ms**. The port is created once at module scope rather than per flush, and each post adds a listener that removes itself when it fires, so `flush()` and `cancel()` detach a pending post rather than leaving it queued.

The ones that could bite an existing user:

- **`PowerGCRA` admitted a batch larger than its burst, and
  `available()` under-reported its own headroom.** A batch is now admitted only
  if its own span fits inside the delay tolerance (`n <= burst + 1`, the same
  requirement `golang.org/x/time/rate` states as `n <= burst`). Before this,
  `rate: 1, burst: 0` and `tryConsume(5)` returned `true` — a batch of five at
  one operation per second, admitted instantly and leaving the limiter 5 s in
  debt on a configuration whose steady state is one operation per second. The
  deeper half is separate from batching and pre-existing:
  `available()` computed `Math.floor(delayTolerance / emissionInterval) + 1`,
  and that division does not round-trip — at `rate: 3, burst: 7` it reads
  `6.999999999999999`, so a limiter covering 8 operations reported 7. Swept over
  `rate` 1-40 × `burst` 0-12 × `n` 1-16 with varied history, 255 configurations
  had `tryConsume(n)` admitting a batch that `available()` had just refused. The
  two now share one computation and cannot disagree, and a saturated limiter
  reports its true `burst + 1`.
- **`PowerGCRA.retryAfter(n)` grows with `n`**, by `(n - 1) * emissionInterval`.
  It previously reported the single-operation wait for every `n`, which
  under-waited: the caller woke early and was refused. Separately, it reported
  `0` while the next `tryConsume` refused in 69 swept cases, which turns a retry
  loop into a spin at full speed.
- **`PowerGCRA.retryAfter(n)` now throws a `RangeError`** when `n` is above the
  burst ceiling. A batch past `burst + 1` can never be admitted at _any_ wait,
  because the ceiling comes from `burst` and not from the TAT — 200 000 tries
  across four configurations, one past the ceiling, zero admissions. The old
  behaviour reported a finite wait for it, so a retry loop would wait, be
  refused, and wait again forever. **This is a new throw on a previously
  returning path**; `take(n)` propagates it rather than inventing a wait. Split
  the batch or raise `burst`.
- **A non-finite request count now throws instead of admitting.**
  `PowerGCRA.tryConsume`, `PowerGCRA.retryAfter`, `PowerThrottle.tryConsume`,
  `PowerThrottle.reserve`, `PowerThrottle.addTokens`,
  `PowerSlidingWindow.tryConsume`, `PowerRateLimit.tryConsume` and
  `PowerRateLimit.reserve` all coerce their count through
  `Math.max(0, Math.floor(n) || 0)`, which turns `NaN` into `0` — and `0` is
  the _admit_ case. So `throttle.tryConsume(NaN)` returned `true` having
  consumed nothing, and `PowerRateLimit.tryConsume(NaN)` returned `true` while
  **no limiter in the composition was consulted at all**. Non-finite and
  non-numeric counts now throw a `TypeError` naming the class and method. This
  is a second new throw, from `assertCount` in `utils/options.js`, and it is
  deliberately _not_ `assertLimit`: a fractional **limit** has to throw
  (RES-010, `capacity: 2.5` over-issues because each consumer rounds up),
  whereas a fractional **count** floors safely because rounding down can only
  under-charge. `0` and negative counts remain the documented no-op.
- `PowerPool` resurrected itself after `shutdown()` and after
  `stopThePress({ recreateWorkers: false })`, orphaning worker threads that
  pinned the process forever. `recreateWorkers: false` was a no-op.
- A duplicate `correlationId` orphaned a pending promise forever and leaked its
  timer, reachable from `postMessageBatch` with a `correlationIdFactory`.
- `PowerScheduler` turned an async `flushFn` rejection into an unhandled
  rejection instead of calling `onError`.
- `PowerRateLimit.tryConsume` could throw _and_ leave its limiters partially
  consumed; `atomic: true` silently degraded to non-atomic.
- `PowerBulkhead.run()` permanently inflated its active count when a permit was
  rejected, so `drain()` never resolved.
- `PowerCache.getOrSetAsync` discarded a successful computation on a client-side
  timeout, so the next caller paid the full cost again.
- `PowerMemoizer` returned a function that had lost `Function.prototype`, so
  `.call`, `.bind` and `.apply` were `undefined` on a memoized function.
- `WorkerAgnostic` eagerly resolved the Node `Worker` constructor even for pure
  factory functions, contradicting its own `preloadNode()` documentation.
- `simpleArgsKey` threw on `bigint` and mapped every `Symbol` to the same cache
  key - a cache-poisoning bug, not just imprecision.
- `PowerCache` silently ignored a throwing `weightFn`, voiding the whole
  `maxWeight` budget.

`PowerPool` remains backwards compatible at the API level; the only migration
required is the worker reply shape.

- **`PowerBackpressure` `{ adaptive: true }`** — AIMD tuning of the refill
  amount, off by default. The controller already refilled on pressure but had no
  idea whether the consumers it handed permits to were coping; now a refill tick
  that finds every permit still out cuts the window multiplicatively, and one
  that finds permits coming back grows it additively. The signal is "did my
  probe come back" rather than a measured delay, so it needs no clock and cannot
  be fooled by a fast consumer that keeps everything. `bp.refillAmount` reads
  the current window; `reset()` returns it to its base.

- **`AbortSignal` on the whole permit-gate family** — `PowerPermitGate.acquire`,
  `PowerSemaphore.acquire`, `PowerBulkhead.run` and `PowerBackpressure.acquire`
  all accept `options.signal`. Cancelling the wait rejects with an `AbortError`
  and the caller leaves the queue instead of holding a slot until a permit
  arrives. Three properties worth relying on: an already-aborted signal rejects
  even when a permit is free (a dead signal is a refusal, not a suggestion);
  an aborted waiter never consumes a permit when the queue drains, so a cancel
  storm cannot leak capacity; and `pending`/`isFull` count live waiters only.
  For `PowerBulkhead.run` the _wait_ is cancelled, not the work — a task that
  already holds a permit runs to completion.
- **`PowerBatch.flush` and `PowerPool.drain` accept a `signal` too**, and mean
  something slightly different: they cancel the _wait_, not the work. A batch
  flush that was abandoned still delivers the items its `add()` callers are
  waiting on, and an abandoned pool drain leaves the pool dispatching for
  everyone else. Rejecting the batch's shared pending promise would break every
  queued caller with a cancellation they did not ask for.

**Added**

- **`PowerObserver` derived observables** — `derive(fn)`, `filter(predicate)`, `distinct()` and a static
  `PowerObserver.combineLatest(a, b, …)`. `map()` mutates the observer's mapping and returns nothing, so these are the
  pure counterparts: chains are built without disturbing the source. The upstream is subscribed **on first subscribe** and
  released **on last unsubscribe**, so a chain of ten derived observers held by one consumer does not keep all ten upstreams
  alive, and a consumer that unsubscribes and is collected takes them all with it. While nobody is subscribed a derived value is a
  **snapshot, not a live value** — the cost of not subscribing, and the reason an unused chain is free. A derived inherits its
  source's `async` mode, so `derive` on a synchronous observer delivers synchronously.

  ```js
  const label = user.derive((u) => u.name).filter((name) => name.length > 0);
  const off = label.subscribe((name) => render(name));
  ```

- **`PowerCron`** — a drift-free interval scheduler, available from the root and as the
  `./powerCron` subpath for tree shaking. `setInterval` does not mean "every N ms"; it
  means "every N ms after the previous callback returned", so a run that overruns pushes
  every subsequent fire later and the phase error accumulates without bound, while a run
  that stalls _queues_ and fires repeatedly on resume. `PowerCron` re-arms from an
  **absolute target** — each run records the time it was aimed at and the next timer is
  computed from that target rather than from `Date.now()` — so drift cannot accumulate and
  an overrun skips the periods it missed instead of stacking them. `averageDriftMs` and
  `fireCount` make drift measurable rather than folklore.

  ```js
  const cron = new PowerCron(() => collectMetrics(), {
    intervalMs: 60_000,
    catchUp: 'skip', // or 'catch-up' to replay each missed period, or 'run-once'
    jitter: 0.1, // spread a fleet off the same minute boundary
    onError: (err) => report(err),
  });
  cron.start();
  // ... cron.stop(), or cron.dispose(); [Symbol.dispose] is also supported
  ```

  A throwing or rejecting task is routed to `onError` and the schedule continues — an
  unhandled rejection from a timer callback takes the process down, so without that,
  "one run threw" would silently become "the cron is dead". The pending timer is
  `unref`'d by default, so a cron alone does not keep a Node process alive. It is an
  interval scheduler, not a calendar: there is no `@daily` parsing or timezone handling,
  and the first fire is one interval from `start()` rather than aligned to the top of the
  minute, because a shared boundary is the largest single source of thundering herd in a
  fleet.

- **`PowerEventLoopMonitor`** — a latency number going up does not tell you
  whether _your_ code got slower or the host was busy, and the two need
  different fixes. It measures timer drift (a probe scheduled `intervalMs` out;
  the gap when it actually runs is the loop having been unavailable) into a
  [`PowerHistogram`](./guides/powerEventLoopMonitor.md), and reports Node's
  `eventLoopUtilization()` where the runtime has it. `utilization()` returns
  `null` — never `0` — where it cannot be measured, and Node's `perf_hooks` is
  reached through an opaque dynamic import so a browser bundle never tries to
  resolve a Node builtin. Internal timer is `unref()`d, so a monitor you forget
  to dispose cannot hang a CLI.

**Fixed**

- **`hasEqual` counted its depth limit per array _element_ instead of per nesting
  _level_.** A flat array of 101 objects exhausted `MAX_DEEP_EQUAL_DEPTH` (100),
  and every remaining pair fell back to reference equality — so two
  structurally identical copies compared as **unequal**, and such an entry was
  unfindable through `hasEqual` for as long as it lived in the cache. For
  scalars the bug was invisible; for objects it silently disabled the API.

**Added**

- `hasEqual` gains a **width budget** (`maxNodes`, default 10 000) alongside the
  depth limit, because depth says nothing about width: a flat 50 000-element
  comparison recurses at depth 2, never trips a depth limit, and blocked the
  event loop for tens of milliseconds on what a caller expects to be a cache
  lookup. Truncation reports **false**, never `true` — a false negative costs a
  recompute, a false positive returns the wrong value, and this is a cache.
  Reference equality is answered before any budget arithmetic, so passing the
  same object back is still a hit at any `maxNodes`.
- `hasEqual` gains a **`compareFn`** escape hatch for values the structural walk
  cannot model — private fields, domain objects, anything with its own notion of
  equality. Return `undefined` for "no opinion" and the walk continues.

- **`PowerCache` `{ admission: 'tinylfu' }`** — a 4-bit Count-Min frequency
  filter (W-TinyLFU) in front of the cache, off by default. An LRU admits
  anything that misses, so a one-off scan evicts the whole working set; a
  frequency filter refuses an insert when the entry it would evict is still
  wanted. **The release note previously claimed "plain `lru` keeps 0 of 40,
  `lru` + `tinylfu` keeps 40 of 40" over a 40-key working set hit by a
  500-key scan. That claim has been withdrawn: `bench/claims.js zipf` does not
  reproduce it, and inverts it.** On a cold 40-entry cache with a 460-key scan
  burst, `admission: 'tynilfu'` measured a **2.5% hit rate against plain LRU's
  66.4%**, retaining 1.7 of 40 working-set keys against 40/40. On a sustained
  Zipf mix it is a mild loss (15.2/40 against LRU's 17.2/40) while `policy:
'slru'` wins outright at 33.0/40. **The option remains available but is not
  recommended until the cold-start behaviour is fixed.** The cause is confirmed,
  and it is not the sketch: a brand-new key's estimate is 0, and the admission
  check refuses whenever the incumbent's estimate is greater than or equal to it
  — so in a cold sketch, where every estimate is 0, every admission is refused
  and a cache that filled with one-shot scan keys can never recover. W-TinyLFU's
  unconditional admission window (the "W") is what should break that tie, and it
  is missing. Treat this entry as experimental rather than a recommendation, and
  run `node bench/claims.js zipf` before trusting any number about it.
  **The fix is known and is not a comparison operator** — it is W-TinyLFU's admission _window_, a small
  unconditional LRU in front of the filtered space, so scan traffic dies in the window and the filter only
  arbitrates that window's victim against a main-space victim. It is written up in
  `design/0001-tinylfu-admission-window.md`, which records the two measured attempts, the two retracted
  hypotheses, four acceptance criteria for the eventual patch, and the two open decisions — now both made.
  The window size is `min(max(4, ceil(maxEntries * 0.01)), floor(maxEntries / 4))`: the floor of 4 matters
  because an earlier attempt used Caffeine's bare ratio, which on a 40-entry cache clamps to a **one-slot**
  window and made scan resistance measurably _worse_ (30/40 → 22/40). And `admission: 'tynilfu'` is to be a
  **no-op under `policy: 'slru'`** — SLRU already has a probation region doing the same job, and stacking
  them measures as the worst variant. **Scope, stated honestly:** the window is a second LRU region with its
  own weight accounting, so `maxEntries`/`maxWeight`, iteration, `size`, `stats()` and disposal all have to
  change together. It is a structural change to a hot path, not a patch, and it is **not** in this release.
- **`PowerScheduler` gained `scheduling: 'yield'`** and **rejects an unknown `scheduling` value.** `scheduler.yield()`
  is the browser-native way to hand control back to the event loop, and it is prioritised ahead of the rendering and task
  queues — which is what makes it the right primitive for a scheduler whose whole job is to run _promptly_. The feature is
  detected once at module load rather than per flush, and where it does not exist (Node, Firefox until recently) the
  strategy falls back to a macrotask: a degradation in **ordering**, not correctness, and one that is now visible through
  the new `strategy` getter (`{ scheduling, supported }`) rather than silent. **An unrecognised `scheduling` now throws.**
  The old line was `scheduling === 'macrotask' ? 'macrotask' : 'microtask'`, so `'idle'`, `'macrotask '` with a trailing
  space, or `'Macrotask'` all silently selected the **fastest** strategy for a caller who had asked for something else — a
  typo in a performance option making the code faster is the worst direction for it to go wrong.
  **`requestIdleCallback` was considered and refused**, for a reason about the contract rather than the implementation: a
  scheduler promises its flush _happens_, promptly, and `drain()`/`flush()` are meaningless against a callback that may never
  run. Idle work belongs in something that does not promise latency. This closes ALG-007.
  **A generation counter was written, mutation-tested, and deleted.** A `scheduler.yield()` continuation is already queued
  and returns only a promise, so `flush()` and `cancel()` cannot un-schedule it and a staleness counter looks necessary.
  Removing it entirely left all seven yield-path tests green — an _equivalent mutant_, caught by mutation testing rather
  than by reading. `_run()`'s existing `if (!this._scheduled) return` already does the job. Machinery no test can
  distinguish from its absence is machinery nobody maintains.

  `maxEntries` and `clear()` are still honoured exactly.
  **The withdrawal originally reached this note but not the guide** — `guides/powerCache.md`
  still carried a benchmark table asserting `policy: 'lru'` + `admission: 'tinylfu'`
  retains **40 / 40** working-set keys, which `bench/claims.js zipf` measures as
  **15.2 / 40**. The table has been replaced with the measured numbers and marked
  experimental, since a reader consulting the guide is the one most likely to act
  on the number. If you read the earlier claim, it was wrong.

- **`PowerPool` `{ maxQueueLength }`** — the pool's missing backpressure story.
  `queuePolicy` decided what happened when the pool was saturated but never
  whether that situation could _keep going_: with the default `'enqueue'` and no
  cap, producers outrunning their workers grew a `PowerQueue` until the process
  ran out of memory, with no error, no event, and nothing to alert on. A finite
  cap makes the overflow observable, and the _incoming_ task is the one refused
  — a caller-provided bound is a statement about the newest arrival, and
  refusing it keeps the work already accepted. `'drop-oldest'` keeps its
  documented meaning and still evicts to make room (it was already self-bounding:
  it evicts one and admits one, so the cap never turns it into a refusal). A
  refused task returns `false`, or rejects with `ERR_POOL_QUEUE_FULL` when
  awaiting a response, so you can tell "the queue was full" from "the worker
  failed". `queueHighThreshold` remains a _notification_ and now says so; the
  two compose — threshold for alerting, cap for safety.
- **`PowerPool.drain({ timeout })`** — a drain against a wedged worker waited
  forever, which is indistinguishable from a hang. It now also takes
  `maxDrainWaiters` (default 100) alongside the existing `signal`, and rejects
  with `ERR_POOL_DRAIN_TIMEOUT` / `ERR_POOL_DRAIN_TOO_MANY_WAITERS`. As always,
  these abandon the **wait** and never the work: the pool keeps dispatching and
  keeps serving every other caller. The timeout timer is a plain `setTimeout`
  rather than the library's `unref`'d default, because a process must not exit
  out from under a caller that is `await`ing a drain it explicitly bounded.
- **`pool:idle` now carries two payloads**: `data.workers` (the per-worker
  `{ id, tasks, lastActive }` array) and `data.stats` (the aggregate `getStats()`
  summary). Both used to be one field called `stats`, and the documentation
  described an _array_ while the code produced a _summary_ — so a listener
  written against the docs did `ev.data.stats.map(w => w.id)` and got a
  `TypeError`. `stats` keeps its key, so existing listeners are unaffected, and
  both new payloads stay lazy so an idle transition still costs nothing.

**Fixed**

- **`drain()` leaked an `idle` listener on every abandoned wait.** `signal` was
  implemented with `raceWithAbort`, which rejects the returned promise but
  cannot touch the listener registered underneath it — so an aborted drain
  retained a closure and a listener slot until the pool happened to go idle
  again, and a caller draining in a loop accumulated one per call.
  `drain()` now owns its listener lifecycle and detaches on every exit path,
  including an idle/timeout race.
- **`postMessageBatch` could dispatch half a batch and orphan the other half.**
  A `correlationIdFactory` is caller code, so a constant or sloppy one returns
  the same id twice; `postMessage` does not defend against that (a second
  registration under a live key rejects the first waiter and takes the key
  over). A 3-item batch with a constant factory left caller 1 holding an
  already-rejected promise and the last result resolving for everyone, _after_
  items 0 and 1 had been dispatched. Ids are now resolved once, up front, and
  validated as a set before anything is sent: a collision throws
  `ERR_POOL_DUPLICATE_CORRELATION_ID` atomically, with nothing on the wire.
  Collisions with an id already in flight from an earlier call are caught too.
- **`stopThePress(msg, _, { recreateWorkers: false })` always returned `true`**
  even when the enqueue was refused, contradicting its own documented "same
  return value as `postMessage`" contract. It now forwards the real result.
- **`_postToWorkerObj` reported a failure it had caused itself.** When the
  direct-to-worker post threw, it silently retried through the wrapper with the
  _same_ transfer list — but a `postMessage` that throws may already have
  detached part of that list, so the retry failed with `DataCloneError:
ArrayBuffer at index N has already been detached`, a message that reads like a
  caller bug and hides the error that actually happened. The retry is gone, the
  transfer list is checked for detached buffers _before_ posting, and the
  `_underlying` reach-through is now a checked internal contract
  (`instanceof WorkerWrapper` plus a callable check) rather than a truthiness
  test that also passed for a non-function value and failed with an unrelated
  `TypeError`. (For the record: that branch is reachable **only** under
  `zeroCopy: true` — `_prepareForTransfer` encodes plain objects to framed
  `Uint8Array`s first — so it is a `zeroCopy` escape hatch, not a general path.)

**Breaking**

- **`PowerCache.hasEqualWithSeen()` and the `seen` option are removed.** The
  `seen` WeakMap is a **per-walk cycle guard**: `deepEqual` consults it as
  "have I already compared this exact pair _in this walk_?" and short-circuits
  to `true`. Reused across two `hasEqual` calls, the second returned `true` for
  a pair the first had recorded **without comparing anything**. Reachable in
  ordinary code because the stored value is mutable — compare a probe, mutate
  it, compare again, get a false hit — so the failure mode was a cache
  reporting a hit for a value that is not in it. The allocation it avoided was
  one `WeakMap`, created only when a walk reaches _object_ comparison; the
  primitive, reference-equality and typed-array fast paths return before
  touching it. `hasEqual(key, value, { ignoreExpiry, maxNodes, compareFn })` is
  unchanged. If you were passing a reusable `seen`, just drop it.
- **`PowerTTLMap.size` is now a pure O(1) read.** It used to
  `_sweepExpirations()` first, which iterated the expiration index, removed
  entries and fired `onExpire` — so `if (map.size)` was a mutation, a size
  check in a render loop was O(k) per frame, and the cost was invisible at the
  call site. It is now `Map.size`: resident entries, expired or not, counted,
  with no side effects. **Migrating:** call `purge()` where you were relying on
  the implicit collection, and use the new read-only `expiredCount` for
  diagnostics (live count is `size - expiredCount`). Note that
  `entries()`/`keys()`/`values()` still collect as they iterate — iteration is
  an observable operation, unlike a property read.

**Added**

- **`PowerCircuit` grows and jitters its open window.** `timeout` is now the
  **base** window rather than the only one: consecutive trips double it
  (`2x`, `4x`, … capped at the new `maxTimeout`, default `timeout * 16`), and
  the result is jittered before use. With a fixed window, every circuit
  guarding the same dependency opened on the same tick and retried on the same
  tick, so the first request after the timeout arrived as an N-wide burst that
  re-tripped every breaker before the dependency had recovered — a
  self-inflicted thundering herd, and exactly what the breaker exists to
  prevent. The window is drawn once per open period and held, because it is read
  by every `call()` and every `state` read. The jitter is **equal**
  (`[delay/2, delay]`), not AWS full jitter (`[0, delay]`): full jitter is
  right for a retry delay, where the goal is spreading attempts, but a breaker's
  goal is stopping traffic, and a full-jitter draw of a 30 s backoff can land
  near zero and leave you a breaker that flaps instead of holds. A successful
  trial — or `reset()` — clears the backoff.
- **`PowerTTLMap.expiredCount` and `PowerTTLMap.purge()`** — the read-only and
  explicit forms of what the `size` getter used to do implicitly.

**Fixed**

- **`PowerSubscriberSet.dispose()` left its `FinalizationRegistry` live.**
  `clear()` emptied the listener set but never touched the registry, so a
  disposed set — disposed _precisely so it could be collected_ — stayed
  reachable through a registry whose held values are `WeakRef`s to listeners
  the set no longer owned, and a later collection fired a callback closing over
  it. The `dispose()` JSDoc already claimed the registry was "replaced"; the
  code did not do it. `clear()` now unregisters every token and drops the
  registry, and a cleared-and-reused set rebuilds a fresh one rather than
  silently downgrading to GC-agnostic pruning. `PowerEventBus` was verified
  correct already.
- **`PowerObserver` ran a user-supplied `map` twice per write.** The setter
  applied it to both the previous and the new value, making the mapper the
  most-executed code in the class. `map(prev)` is what the previous write
  already computed, so it is cached; steady state is one call per write. Swapping
  the mapper invalidates the cache, so the next `prev` comes from the mapper
  that produced it.

**Docs**

- **New [troubleshooting guide](guides/troubleshooting.md)**, led by the pure-ESM `preloadNode()` failure. It is the most
  likely first-run problem and it is specific to one environment: `require` does not exist in an ES
  module's scope at all, so the pool cannot reach `Worker` synchronously and the only way to build a
  `require` from `node:module` is asynchronous. The guide gives the exact error the pool throws and
  three fixes — with a recommendation, because the best one is not the obvious one: **pass a factory
  function** rather than satisfying the preload, since that removes the step instead of paying it. It
  also covers the framed-vs-plain-object worker mismatch introduced by the 2.0 default codec,
  `ERR_POOL_QUEUE_FULL` as a load-shedding signal rather than a retry signal, and `setInterval` drift.

**Internal**

- **Formatting, linting and generated types are now enforced at commit time.** Prettier and eslint run over the
  changed files only (husky + lint-staged), and `types/` is regenerated and staged whenever a commit would leave it stale.
  Added `.editorconfig` (mirroring `.prettierrc`, since the two tools disagree when they drift and the symptom is churn on every
  format) and `.nvmrc` pinning the _floor_ of the supported Node range, so the `>=22.12.0` boundary the `engines` field
  advertises is actually exercised. The pre-commit hook deliberately does not run the test suite: a hook that takes minutes gets
  bypassed with `--no-verify`, and a bypassed hook protects nothing while appearing to. `npm run verify` remains the gate.

- **A new `npm run check:bundle` step, wired into `npm run verify`, verifies the
  built CJS/UMD bundle actually exports what `src/index.js` declares**, and that
  the bundle is not older than its sources. This exists because the check cannot
  live in the test suite: `test/globalSetup.js` rebuilds `dist/` from `src/`
  before every run, so within a run the two cannot diverge and any such assertion
  passes no matter what — three attempts at one were written and discarded before
  the real reason was found. A bundle missing an export, or stale against
  `src/`, is now caught in CI rather than shipping to a consumer who gets
  `undefined` from a bundled app. For maintainers: the bundle is not committed,
  so this is a release-gate check, not a drift check across releases.

- The benchmark harness is now reproducible, and reports its own noise floor. Workloads are generated from a seeded PRNG (printed in every report, overridable
  with `BENCH_SEED`) — previously every run measured a _different_ workload, so no
  delta between two runs was meaningful, because repetition reduces timer noise
  but not workload noise. Repeats raised to 9, `global.gc()` between repeats and
  phases (the npm scripts now pass `--expose-gc`; running `node bench/run.js`
  directly skips it and the report says so), and a symmetric one-from-each-end
  trim replaces the bare median so a GC pause cannot masquerade as a result.
  Every report opens with a **Measurement quality** section giving the seed, the
  outlier policy, whether GC ran, and a measured **noise floor**.

  **On the machine this was measured on, that noise floor is 28.71%** (median
  min/max spread across 22 timed variants, p95 113%). The harness has been
  reporting deltas well below that as if they were results. Treat sub-30% claims
  from these numbers as unsupported until you check the figure in your own run —
  and note the spread is dominated by sub-millisecond variants, where timer
  resolution is a large fraction of the measurement, so heavier workloads resolve
  better than more repeats.

- Eleven tuning numbers across eight helpers were bare literals with no
  recorded reason — the `PowerQueue` preallocation (five sites), the
  `navigator.hardwareConcurrency` fallback (two), the histogram bucket floor,
  the two chunking multipliers, and the pool's own "start small" default. They
  are now named constants in `constants.js`, each with the _why_ next to it, and
  `test/constants.naming.test.js` pins both the values and the wiring so the
  sweep cannot silently regrow. No behaviour changes and no API changes. The
  constants stay internal.

**Added**

- **`reset()` / `clear()` aliases on the classes where the two words mean the
  same thing.** `reset()` is now available on `PowerQueue`, `PowerEventBus`,
  `PowerSubscriberSet`, `PowerTTLMap` and `PowerBatch`; `clear()` is now
  available on `PowerSlidingWindow`, `PowerEventLoopMonitor` and `PowerGCRA`.
  Purely additive — each alias delegates to the method the class already had, so
  there is no behaviour change and no second implementation to keep in sync.

  **The limiters deliberately do _not_ get these aliases**, and that is the point
  worth reading. `PowerThrottle.reset()` **refills** the bucket, so a `clear()`
  alias would describe the exact opposite of what it does; the same goes for
  `PowerPermitGate`, `PowerSemaphore`, `PowerBackpressure`, `PowerBulkhead`,
  `PowerCircuit`, `PowerLatch` and `PowerRateLimit`. `PowerObserver` is excluded
  because its `clear()` removes _subscribers_, not the value, so `reset()` would
  promise something the class does not do. A consistent vocabulary that
  misdescribes seven methods is a worse API than an inconsistent one that is
  accurate. `test/lifecycleAliases.test.js` pins both halves of this rule.

**Types**

The shipped `types/*.d.ts` are what TypeScript consumers actually compile, and
they had drifted from `src/`. All of the following were wrong in 1.0.3 and are
now correct — if you have a `skipLibCheck: false` consumer, or work around any
of these with `as any`, you can delete the workaround:

- **The package no longer requires `@types/node`.** `u82o`/`b2o` were declared
  with `TypedArray` and `Buffer`, both Node global aliases, so the published
  types could not compile for a consumer who had not installed them. They are
  `ArrayBufferView` now, which is a TypeScript built-in. `Buffer` needs no
  mention at all: it extends `Uint8Array`.
- `PowerPoolOptions` was missing `autoScale` and `messageCodec` — both of which
  the pool reads.
- `PowerBulkhead` never documented its `onError` option, which has existed
  since 2.0. It is now in the published options type.
- `PowerSemaphore.acquire()` returned `Promise<Function>`. `Function` is not
  assignable to `() => void`, so the documented
  `acquire().then((release) => release())` did not compile.
- `PowerMemoizer.memoize()` returned bare `Function`, so `memoized(1)` was not
  assignable to anything and none of `get`/`has`/`delete`/`clear`/`stats`/
  `cache`/`original` appeared in the types — even though `original` has worked
  at runtime for two releases. It now returns a callable-and-augmented type.
- `PowerTimedCache.set`/`has`/`startCleanup` were declared with _required_
  parameters, so the two-argument `timed.set(k, v)` failed with "Expected 3
  arguments, but got 2".
- `PowerCache` accepted `defaultAsyncTimeout`, `onError` and `policy` at
  runtime but omitted all three from its options type — a duplicated JSDoc list
  had drifted from the `PowerCacheOptions` typedef it duplicated. There is now
  one source of truth.
- Every class with a disposal method was emitting `[x: number]: () => void;` —
  a numeric _index signature_ — into the shipped declarations, which made
  `using cache = new PowerCache()` fail to type-check and left `dispose()`
  missing entirely.
- `o2u8`'s second parameter is now documented and optional.
- `PowerWebSocketClient.readyState` is typed `0 | 1 | 2 | 3` rather than
  depending on the `lib.dom` alias `WebSocketReadyState`.
- **`PowerPermitGate.release()` now returns a number.** It is the number of
  permits that actually came _back_ to the gate rather than being transferred
  straight to a queued waiter. A caller tracking outstanding work needs that
  difference: a release that serves a waiter is not a free permit, and
  subtracting the requested count is what pinned the backpressure controller in
  additive increase. `PowerBackpressure.release()` overrides it and passes the
  value through rather than dropping it, so the override's type matches its
  base's.
- The `typecheck:ratchet` ceiling of 300 is now met at **291** — the permit-gate
  work reduced measured type debt by 9, since the new members are documented
  well enough for `tsc` to type them.

**Added in the review cycle**

The items below landed while the plan table in `review.md` was being worked through. Five of them are worth reading even if you skip the rest: two proposals were **closed on a measurement rather than built**, one feature shipped under a justification the row did not predict, and **a guard that had been passing for the wrong reason was found by deliberately breaking it** — twice, in the same file.

#### Concurrency: the permit gate's accounting was wrong on two of three paths

Fixes a family of defects in `PowerPermitGate` and everything built on it —
`PowerSemaphore`, `PowerBackpressure`, `PowerBulkhead` — and records the design
decision the fix forced. **The short version: the gate's one count of outstanding
work was incremented on one of its three grant paths, so most of the time it
described a quarter of the truth.** The AIMD controller reads that number, and
the tests that cover it were passing _because_ of the bug.

`active` is now counted from a single grant point rather than computed as
`capacity - available`, and four defects follow from making it honest:

- **A reset no longer mints a permit that is still held** (`RES-023`).
  `reset()` set `available` unconditionally, so resetting a gate of 1 with one
  holder running produced a **second** concurrent holder against a limit of 1,
  permanently — the first holder's release was then absorbed by the capacity
  clamp. `using sem = new PowerSemaphore(1)` reaches it: a `run()` in flight at
  scope exit is not hypothetical. Outstanding holders cannot be _settled_ by a
  reset (the promise that produced a release callback has already resolved, so
  there is nothing to reject), but a teardown can stop pretending their permits
  are free. `available` is now capped at `capacity - active`, and a holder's
  release returns its permit normally afterwards.

- **A queued producer is no longer starved behind a cancelled one** (`RES-001`).
  The refill loop shifted queue entries itself, so it neither skipped aborted
  entries nor decremented the cancelled-waiter counter. One cancellation was
  enough to leave that counter permanently one too high: `pending` then reported
  **0 with a live waiter still queued**, every refill tick short-circuited on
  `pending === 0`, and the queue could not make progress at all. The only way out
  was `reset()`.

- **The in-flight count is not decremented for a transfer** (`RES-024`). A
  release that hands a permit straight to a queued producer is a transfer, not a
  return: the permit is never in the pool in between. Subtracting on that path
  walked the counter below zero after one cycle, and the AIMD controller — which
  asks "is everything I handed out still out there?" — was **pinned in additive
  increase forever after**. A window that only ever grows is not congestion
  control. `release()` now returns what actually came _back_.

- **A fractional `capacity` is rejected** (`RES-010`). `capacity: 2.5` admitted
  **three** concurrent holders — each grant decremented the fractional counter,
  and three decrements of 1 still leave it above 0 — and then reported
  `available: -0.5`. This is a `TypeError` now, at thirteen count-like option
  sites. The flag is opt-in rather than a blanket `Math.floor` in `assertLimit`,
  because some options are genuinely fractional: `PowerRetryBudget.ratio` among
  them.

Also: `PowerBackpressure.acquire()` delegates its admission decision to the
parent instead of re-implementing it (`RES-028`), and the override had already
drifted — it rejected an already-aborted signal with a bare `Error` where the gate
gives an `AbortError`, so the `err.name === 'AbortError'` check this class's own
docs tell you to make **failed for exactly the class that documents it**.

**Two user-visible changes:**

```js
// Before: three holders, available: -0.5
new PowerBackpressure({ capacity: 2.5 });
// After:
new PowerBackpressure({ capacity: 2.5 });
// TypeError: PowerBackpressure: `capacity` must be a whole number (received 2.5).
```

```js
// Before, on a full queue:
await bp.acquire(); // Error: PowerBackpressure queue is full
// After — one admission decision, one set of words:
await bp.acquire(); // Error: PowerPermitGate queue is full
```

If you match on the second string, match on `'queue is full'` or on `instanceof`.

#### The decision that fix forced: what a permit _is_

`capacity` is a **hard ceiling** on concurrent holders for `PowerPermitGate`,
`PowerSemaphore` and `PowerBulkhead`. It is the **pool size** the refill draws
from for `PowerBackpressure`. The two are not the same question, and the code had
to pick one without saying so.

The ceiling reading cannot be used everywhere. A producer only queues when the
pool is empty; an empty pool means every permit is out; so "missing" is always
zero and the refill could never grant anything. `refillAmount`, `refillInterval`
and the whole AIMD window would be dead code, and `PowerBackpressure` would
become `PowerSemaphore` with three inert options. The guide's own words were
already the pool reading — "base number of permits **restored** during each
adaptive refill".

So the pool model is what ships, and two things changed with it:

- **`active` counts holders rather than reporting `capacity - available`.** The
  two are identical for the ceiling classes, so this is invisible there. Under
  the pool model they diverge, and the old form cannot represent the divergence:
  `capacity - available` cannot exceed `capacity`, so on a `PowerBackpressure`
  whose consumers are not returning their permits it sits **pinned at the ceiling
  and reports a healthy gate while the work is piling up**. `active` can now read
  above `capacity` on that class, and `examples/backpressure.mjs` prints the case
  rather than hiding it.
- **`guides/powerBackpressure.md`'s claim that "`_inFlight` is bounded by
  `capacity`" was wrong** and is now corrected. It was written as an aspiration
  and believed because the counter that would have falsify it was incremented on
  one of three grant paths.

A refill also cannot relieve a queue whose every permit is out and never coming
back. That is the pressure the class exists to express, not something a timer
can schedule around — and the controller now stops re-arming when it has nothing
to mint, rather than holding a live handle open behind a queue it cannot relieve.

[ADR 0004](../adr/0004-permit-capacity-ceiling-or-pool.md) records the model, both
rejected alternatives, and the rows that depend on it (`ALGO-005`, `ALGO-010`,
`RES-008`).

#### The tests that were passing for the wrong reason

`test/powerBackpressure.aimd.test.js` had two tests asserting that the AIMD
window _grows_ while consumers return permits. Both passed against a controller
whose congestion signal was structurally dead — a permanently-false signal is a
permanently-growing window — and both were red the moment the count was honest.

The replacement asserts the count through the refill path rather than through
`acquire()`, because that is the route that bypassed it, and drives the AIMD
branches from a state that is actually reachable. That state is narrower than it
looks: a queued waiter implies the pool is empty, and an empty pool with a waiter
only arises when the gate starts drained (`initialTokens: 0`) and is handed work
faster than the first tick. **The additive branch is not reachable from a
saturated gate at all**, which is `ALGO-010`'s question and not a test problem.

Two more bugs in the fix were caught the same way rather than by reading: a
transfer was being counted as both a grant and a return (4 holders releasing into
3 waiters read **7** in flight), and `release()` was decrementing by the pool's
_increase_, so a permit the capacity clamp discarded left a phantom holder
outstanding forever.

#### Cache: a one-character typo silently disabled TTL, and a "verified" claim withdrawn

Fixes a live defect in `PowerCache` that made a mistyped TTL produce an
**immortal entry** — and withdraws a claimed cache bug that a measurement could
not reproduce.

**`ttl: 'abc'` made an entry never expire.** `now + ttl` on a non-number is string
concatenation, not a failure, so the stored `expiresAt` became the string
`"3000abc"`. Every expiry test then compared a number against a string, produced
`NaN`, and `NaN > anything` is `false`. The entry could not expire, and nothing
reported a problem — a TTL from an environment variable is a string, so a
one-character typo in a config value silently turned expiry off, which is the
worst direction a cache has to fail in: it looks accepted, and memory grows until
something unrelated breaks.

```js
// Before: expiresAt === "3000abc", and the entry is immortal.
cache.set('k', v, { ttl: 'abc' });
// After:
cache.set('k', v, { ttl: 'abc' });
// TypeError: PowerCache: `ttl` must be a finite number of milliseconds or
// Infinity (received "abc"). A value that is not a number concatenates rather
// than adds, and every expiry comparison against it is false — so the entry
// would never expire.
```

A **numeric** string is still accepted, because `process.env.TTL` is a string and
rejecting that would be pedantry. Note that the plan's own example was
`ttl: '1e3'`, which is _not_ a bad value — `Number('1e3') === 1000`. The string was
never the problem; the concatenation was. `'1e3'` is now accepted and expires
correctly.

A second hole turned up while probing the validation surface rather than by
reading the code: `Number([]) === 0` and `Number(true) === 1`, so a value check
alone would have accepted `{ ttl: [] }` as "expire now" and `{ ttl: true }` as "one
millisecond". A `typeof` guard rejects those. The arithmetic was written out three
times — in `set`, `setMany` and `touch` — and there is now one
`_expiresAt(ttl, now)` all three call, since fixing two of three copies would have
left the defect in the third.

**The "most serious defect found in this review" is withdrawn.** `CACHE-001` is
recorded in the plan as `**[verified]** A dangling cursor destroys the whole linked
list: size 5, head null, tail null, entries() undefined`. It does not reproduce. A
fuzzer over ~2.4 million operations — 40 000 seeds × 60 operations, across
`admission: 'tinylfu'` with a window, without one, and under `policy: 'slru'`, using
thirteen operation types — **never produced a stale cursor**. Every path that
removes the node the cursor points at either passes an explicit "advance it" flag
or is removing the head, which `_remove` already repairs.

Two candidate fixes were written and **both reverted**: a differential trace over
every public method found them observationally identical to the original, and a
change that cannot be distinguished from no change is not a fix. What ships instead
is the invariant test `CACHE-002` asked for — which also revealed that **no test
mentioned `cache.resize` at all** before this, only `PowerPool.resize`, and that
absence of coverage is a large part of why the premise went unexamined. The
`_unlinkNode` comment now states the invariant and tells a future fifth caller to
advance the cursor, which is the one place the reasoning is worth keeping.

Two corrections are recorded so the next reader does not repeat the work: the
plan's `[verified]` label was not, and `resize()`'s
`this._evictionCandidate = this.head` **is not a typo** — `head` is one of ten
`Object.defineProperty` aliases, and `cache.head === cache._head`. That was
asserted the other way round on the strength of one misread probe before the alias
was checked.

#### Cache: `setMany` was making different decisions from `set`

`setMany` had its own copy of the insert path, and it was a simplified one. Three
of `set`'s per-entry decisions were simply absent from it:

- **`rejectOversized` was ignored.** An oversized value written through `set` was
  refused with `onEvict` reporting `'rejected-oversized'`; the same value written
  through `setMany` was admitted, then swept out by the bulk eviction pass
  wearing the **wrong reason**, `'evicted'`. Anyone counting rejections from
  `onEvict` — which is the only way to count them, since `setMany` returns `this`
  — was counting the wrong thing, and `stats().rejected` stayed at 0.
- **The TinyLFU sketch never saw the writes.** `sketch.estimate(k) === 0` after a
  bulk load, and a frequency-driven filter cannot judge a key it has never seen.
  Combined with the admission filter's own defect (a key at estimate 0 can never
  re-enter), a bulk-loaded key was effectively locked out of a cache it was in.
- **The admission window was bypassed entirely**, so a bulk load skipped the one
  mechanism that makes `windowSize > 0` worth having.

`setMany` still returns `this` and still gives no per-entry signal — that is its
chaining contract, and changing it would break a thousand-entry load for a
`false` nobody can use. The signal is `onEvict` and `stats().rejected`, and both
are now correct.

The fix deletes the duplication rather than patching the second copy: the insert
path, the oversize check and the update arithmetic are now `_insertNew`,
`_rejectIfOversized` and `_updateExisting`, and `set` and `setMany` both call
them. `set` went from 127 lines to 47. That is the same lesson as the TTL defect
above — three copies of one arithmetic, three places to get it wrong — and the
reason `CACHE-003` and `CACHE-004` are one change in spirit even though the rows
do not say so.

Worth knowing if you hit an oversize rejection and cannot work out why: the
**default `weightFn` counts entries, not bytes**, so `set('k', <999 bytes>)` is
weight 1 and is not rejected however small you make `maxWeight`. The rejection
only fires under a size-based `weightFn` or an explicit `weight`.

#### Event bus: a rejecting `async` listener killed the process

`PowerEventBus.emit()` wrapped each listener call in `try`/`catch`, and its docs
said errors were swallowed. That was true of a synchronous throw and false of a
promise — and the difference is fatal rather than noisy. An unobserved rejection
reaches the process, and **Node's default `--unhandled-rejections=throw` since
v15 terminates it**, so an `async` listener that threw killed its host from
inside a fire-and-forget notification:

```js
const bus = new PowerEventBus();
bus.on('ready', async () => {
  throw new Error('boom');
});
bus.emit('ready'); // the process used to die here, on Node's defaults
```

`emit` now observes a thenable return and attaches a no-op rejection handler. The
check is one property access and allocates nothing on the sync path, which is the
common case; a handler is attached only when a listener actually returned
something awaitable. It is a `typeof result.then === 'function'` rather than
`instanceof Promise`, so a hand-rolled deferred or a cross-realm `PromiseLike` is
covered too.

**Reaching `once` needed a second fix.** `PowerSubscriberSet`'s once-wrapper was
`try { fn(...) } finally { this.delete(fn) }` and it _discarded the return
value_ — so the promise died inside the wrapper, before `emit` had anything to
observe. The wrapper now returns it. `once`-ness is unaffected, and the sync
return value is now passed through rather than dropped.

A rejecting listener is **not** unsubscribed: a listener that throws is not the
same as one that removed itself, and dropping it would turn one bad event into a
permanently missing one. `emit` still reports `true`, because the listener was
notified. If you want a failing listener surfaced rather than swallowed, that is
what `emitAsync` is for.

**The tests are subprocesses, and that is load-bearing.** "The rejection did not
reach the process" is not observable from inside the process that would have died,
so a `waitFor`, a fake timer or a try/catch all pass against the broken code —
the failure is a _later_ exit, not a thrown error. Three cases spawn a real
`node --input-type=module` child on default settings and assert it exits cleanly.
Mutation-checked both ways: reverting the `thenable` check fails two, and
reverting the wrapper's return value fails two.

Closes OBS-003.

#### Metrics: registrations outliving the object, or dying too early

Two P0 rows in the same area, and both directions of the mistake are silent. A
registration that outlives its object is sampled forever by a collector holding a
closure over something nobody can reach — and because `getStats()` still answers,
the series looks live, so nothing fails. A registration destroyed too early is
the mirror image: the helper is working, reporting nothing, and there is no error
to find.

**`PowerEventLoopMonitor.stop()` was destroying the receipt.** Its own JSDoc
advertises "in-flight samples already recorded are kept, so a stop/start cycle
does not lose history" — and `start()` does not re-attach. So the cycle the
method explicitly invited, an app performing on a debug toggle, left the monitor
sampling and reporting nothing for the rest of its life. The only way back was a
new monitor, which discards the collected history too. `stop()` no longer
detaches; `dispose()` remains the only thing that does. Eight other helpers
detached in teardown only — this was the only one detaching in a method
documented as reversible.

**`PowerBulkhead.dispose` and a new `PowerRetryBudget.dispose` now detach.**
`guides/metrics.md` states the guarantee and then _lists both of these two
helpers_ as ones that must honour it; neither did. `PowerBulkhead.dispose` was a
bare alias for `reset`, and `Symbol.dispose` called `reset()` too — so a
`using` block, which is a scope exit and exactly the teardown the guarantee is
about, left the bulkhead registered. `PowerRetryBudget` had no `dispose()` at all,
so it could not be released even in principle.

The split between `reset` and `dispose` is deliberate and is the thing worth
keeping: **`reset()` and `stop()` keep the registration, `dispose()` and
`terminate()` release it.** Both `reset` operations are reversible — a budget or
a bulkhead is still usable afterwards — and unregistering there would make the
series flap on every reset.

Tests are in `test/metrics.lifetime.test.js`, and they assert the _sampling_, not
just the registration name, so a receipt whose reader was swapped out cannot pass.
Mutation-checked three ways: putting the detach back into `stop()` fails 1 of 9,
and making either `dispose` a no-op fails 2 of 9 each.

Closes OBS-001 and OBS-002.

#### Backpressure: the AIMD controller was not being consulted

`ALGO-010` asks a design question — keep a loss-based AIMD, or invent a third
signal? The answer turned out to be neither, because the controller was almost
never _asked_. It is fixed, and the question is now answerable on evidence rather
than by argument.

**The refill drains the queue it exists to relieve.** A producer only queues when
the pool is empty, a tick mints, and the queue empties — so the queue is a
_transient_, present for roughly one tick. Anything gated on "is anyone waiting?"
is gated on something that is usually false. And the AIMD heartbeat was gated on
it: `_adaptiveHeartbeat` means "keep probing", but the only thing that armed a
refill timer was a producer arriving to find an empty pool, and after the first
tick there is neither.

Measured, 16 producers against a capacity of 8, each holding its permit:

```
aimd steps   2                    (400 ms)
window       8 → 4 → 2, frozen    (floor is 1)
inFlight     16 of 8              (2x oversubscribed)
heartbeat    true                 (nothing acted on it)
_refillTimer null                 (nothing armed it)
```

Two real cuts, then a controller that had stopped — holding at 2 while the gate
stayed twice oversubscribed. The loss signal was fixed by `RES-003`/`RES-024`; the
thing reading it was asleep. After the fix: **97 steps, and the window reaches its
floor.**

Two properties keep this cheap, and both are asserted:

- **`adaptive` defaults to `false`.** The heartbeat only exists for a caller who
  explicitly asked for adaptation, so a default-constructed controller gains no
  timer at all. This is the test that stops the fix becoming "every
  `PowerBackpressure` polls forever".
- **It terminates.** The heartbeat clears when there is no queue _and_ nothing in
  flight, so the controller probes while there is work to observe and stops when
  the gate goes quiet.

The rejected alternative is worth stating, because it is the second time this
ADR rejects it: making `capacity` a hard ceiling would make the loss signal
correct by construction, and would also make `missing` structurally zero — a
producer only queues when the pool is empty — which deletes the refill and turns
`PowerBackpressure` into `PowerSemaphore`.

One measurement correction along the way, because it changed the conclusion: an
earlier probe of mine sampled the in-flight count at _grant_ time rather than at
the decision, and reported 7% congestion, which hid this completely. A second
probe sampled at the decision but used producers that acquired once and never
released, so the "blindness" looked like an artefact of producers that stop
arriving — it is not; continuously-arriving producers freeze it too. The
instrumentation has to sit on `_aimdStep` itself.

ADR 0004 records this, and the note there also corrects something the changeset
above states: the AIMD **additive** branch is _not_ reachable only from a gate
that starts drained. A refill grants `min(refillAmount, missing)`, so whenever
`refillAmount < capacity` the post-grant in-flight count is below capacity and the
additive branch fires — 93% of grants in a transient-load probe. The window
oscillates between its floor and the refill amount, which is what a loss-based
AIMD should do.

Closes ALGO-010.

#### The type-debt ratchet could measure nothing and report it as progress

A ratchet that measures nothing while printing a number is worse than no
ratchet, because it is believed. Every number the type-debt gate prints is
downstream of `tsc`, and three of the ways it could measure nothing were open.
All three are now closed, and each was verified by breaking it.

**A zero count is a failure, not a windfall.** The script never looked at
`run.status`, so a deleted `tsconfig` or an `include` glob matching no files —
non-zero exit, nothing countable — reported `0`, took the "debt fell" branch, and
printed _passed_ while measuring nothing. It now fails, and the message says which
of the two modes it is by quoting the exit status: exit 0 with no diagnostics
means the glob matches nothing; a non-zero exit with nothing countable means tsc
never got as far as checking. The plan notes that reproducing this needs editing
`PROJECTS` in the script; both modes are reachable without that, which is the part
worth having.

**An unparsed source file no longer lowers the ceiling.** The defence was a list of
21 TypeScript grammar error codes. It could not be maintained — 18 further codes
escaped, including `TS1110` — and, measured, it matched **0 of the 29 codes this
project actually emits**, so it had never once fired on a real diagnostic. A code
range is not the replacement either: `TS1016` (module resolution) and `TS18048` (a
real semantic null-check) sit either side of the `1xxx` boundary.

What replaced it is a property of the _shape_ of the output rather than of the
codes: **a file that stops parsing stops reporting diagnostics, so it leaves the
set of files with diagnostics.** A real syntax error takes tsc from 12 reporting
files to 1, because tsc aborts the program. That set now has a floor in the
committed config, and it cannot rot — a new file starts outside it, and a file
only leaves when it reaches zero diagnostics, which is the same event as lowering
the ceiling.

The "half the debt vanished in one run" heuristic is also promoted from a warning
that exited 0 to a hard failure. A ratchet that accepts a headline drop silently
is the exact shape of the lie this script exists to prevent.

**The ceiling is a reviewable artefact.** It moved out of a `const BASELINE = 300`
— which read as a typo to anyone who had not read the forty lines of history above
it — into `scripts/typecheck-ratchet.json` with `{ ceiling, minFilesWithDiagnostics,
recordedAt, reason }`. Moving it requires `--raise` or `--lower` **and** a
`--reason`, so the change is a diff with a justification. Both directions refuse the
wrong flag, so a flag name cannot substitute for reading the number. The plan
records the gate as "tolerating 11 new type errors and answering with advice and
exit 0"; that is no longer its shape.

Two of the row's proposals were checked before being written and did not survive:
"every `src/**/*.js` file appears in tsc's output" is not implementable, because 32
of 44 source files are clean and correctly appear nowhere; and a `code < 2000` rule
false-positives on a live diagnostic. Both are recorded in the rows so the next
person does not try them again.

Closes GATE-006, GATE-007 and GATE-011.

#### Two new gates, and a guide documenting a method that does not exist

`GATE-001` and `GATE-002` are the same kind of row — _make a claim about the
codebase checkable_ — and one of them found a bug immediately.

**A guide documented `pool.prepareBuffer(...)` in its API list and called it in a
runnable example.** No such method exists; only `prepareBuffers` does. The
description was also wrong twice over: the real method returns
`{ message, transfer }` entries rather than a bare `Uint8Array`, and `clone`
defaults to `false`, not `true`. A reader following that example got a
`TypeError`, and nothing in the build noticed — the guide is prose, and prose does
not fail `tsc`. The guide is fixed in four places, and the example now shows the
array form unwrapped and says why there is no singular method.

`test/docsCodeAgreement.test.js` makes that class of mistake checkable. The scale
is worth knowing: a scan finds **54** backticked calls in `guides/power*.md` that
are not methods of the same-named helper, and **53 are correct** — a builtin, a
shared util, a callback parameter the guide is documenting, or a method of another
class. So the test ships a stop-list grouped by _why_ an entry is exempt, and
asserts that the list's guide-specific half has no dead entries, because a list
that only grows is how the real bug walks back in.

**Every swallowed error in `src/` now has to say why it is safe.** `QUAL-006`
claimed that listener errors are swallowed deliberately and that this "cannot
regrow silently" — which was structurally false, since ESLint's `no-empty` ignores
a block whose body is a comment, and that is every one of them. Measured with the
TypeScript parser: **273 `catch` clauses, 72 with no statement at all**, across 21
files. `test/catchJustification.test.js` requires either an empty body to be
impossible or the comment to be a _justification_.

The interesting part is how "is this a justification?" is decided: structurally,
not by a word list. A comment is a **dismissal** if it is a swallowing verb with
no second clause. That matches 44 sites across 16 distinct texts with **zero false
positives**, and it correctly keeps out `ignore formatter errors **and fall back
to** original payload` and `swallow undo errors **— nothing more we can do**` — the
two of us who wrote it first tried a keyword list, and it would have needed
re-tuning for every correctly-written sentence.

**The first version of that gate did not work, and mutation-checking is why it was
found.** Keyed by allowlist text alone, it accepted a _new site_ of an existing
dismissal — a freshly added `/* ignore */` passed. Each entry now records how many
sites may use it, so a twentieth one fails with a message saying to fix the comment
rather than the ceiling. Four mutations: a new `/* ignore */` site fails, a new
dismissal text (`/* skip */`) fails, a truly empty catch fails, and a genuine
justification passes.

The first three of those were also **vacuous on the first attempt** — the injections
targeted `powerBuffer.js`, which has no class, so nothing landed and the mutants
appeared to "survive" for entirely the wrong reason. Re-run against `powerCache.js`
they all fire. A surviving mutant is only evidence once you have checked the
injection landed.

The 26 sites behind `/* ignore */` and `/* swallow */` carry no information at all
and remain a real gap; they are allowlisted with a ceiling, and recorded in
`review.md` as follow-up.

Closes GATE-001 and GATE-002.

#### Pool: every batched request failed at the first line

`postMessageBatch` and `prepareBuffers` did not speak the documented framed
protocol. The user-visible symptom was `unsupported protocol version 123 (expected
1)` — and **123 is `{`**, the first byte of a JSON body. Every batched request
failed, pointing nowhere near the cause.

Measured on the single-worker fast path before the fix: the first byte of every
message the worker received was 123.

The cause is that `prepareBuffers` was a **third copy** of the pool's message
preparation logic, and it had drifted from `_prepareForTransfer` twice over: it
never framed, and it never set the `deferred` marker. The fast path then posted
`prepared.message` verbatim, because it bypasses `postMessage` entirely — which is
how the batch path came to speak a different protocol from the single-message path
that is supposed to be the optimisation.

The fix is a judgement rather than a patch, and the judgement is that
**`clone: false` is only meaningful under `messageCodec: 'legacy'`.** Framing wraps
the body in a fresh header on every call, so a _cached_ body can never be both
shared and correct on the wire:

| Mode                     | Returns                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `clone: false` (default) | unencoded, marked `deferred`; framing happens at dispatch                 |
| `clone: true`            | a framed private `Uint8Array` — the mode that can actually save an encode |
| `messageCodec: 'legacy'` | the shared cached body, which _is_ the wire format there                  |

`transfer` stays `undefined` wherever the buffer is shared, which is the property
worth keeping: a transfer list on a shared buffer would detach the cached encode
entry. A deferred item carries no buffer at all, so nothing there _can_ be
detached.

**One existing test pinned part of the bug.** `test/powerPool.prepareBuffers.test.js`
asserted the default returns the shared body as a `Uint8Array` — the bare body. It
is rewritten to assert the property underneath it rather than the shape, which is
stronger, plus a `'legacy'` case proving the cache is still shared there.

`test/powerPool.framing.test.js` asserts on the **wire bytes, not a return value**,
which is the only thing that could have caught this: the defect was that everything
the API returned looked correct while the bytes were wrong, so the existing
result-array assertions passed against the broken code. Mutation-checked both
directions.

`POOL-004` — the single `_dispatchToWorker` choke point across all four dispatch
sites — is **not** done. This removes the drift at the two sites `POOL-001` names;
the structural answer remains open and is recorded in the row.

Closes POOL-001.

#### Pool: a queued `awaitResponse` promise could hang forever

A task that was queued and then dispatched by the **inline drain inside
`worker.onmessage`** was never associated with the worker that took it. So when
that worker was terminated, `_rejectPendingForWorker` walked the pending map for
entries whose `workerId` matched, found none, and the caller's promise was never
settled. Under `awaitResponseTimeout: Infinity` — which is the documented way to
say "wait as long as it takes" — that is a permanent hang with no error and no
timeout.

Meanwhile the drain had already counted the task on the worker (`tasks++`,
`_activeTasks++`), so the pool's own state claimed the work was outstanding. It
was not a lost task; it was a promise nobody was going to answer.

Reproduced before fixing: with a worker that accepts work and never replies, and
two `postMessage` calls in flight together, the drain **dispatched** the queued
item — the worker's send count went 1 → 2 — and the pending entry was still
`workerId: undefined`. After the fix the same probe shows the entry marked, and
the promise **rejected** on `terminate()`.

The fix is one line. Two of the three dispatch paths — `_postToWorkerObj` and
`_dispatchQueuedTasks` — already did this marking; the inline copy of the drain
was the one that drifted, which is `POOL-004`'s reason for wanting a single
`_dispatchToWorker` choke point. `POOL-004` is not done and is recorded there.

**Three things about this bug are worth more than the fix.** Getting a
reproduction took three attempts, and each failure mode was one that makes the
defect _unreachable_ rather than absent — which is exactly how a passing test gets
written about a real bug:

- Both `postMessage` calls must be in flight **together**. Awaiting the first lets
  `tasks` fall back to 0, so the second is dispatched directly and the queue stays
  empty — the drain never runs, and a test asserting the hang passes.
- The worker must **never answer**. A worker that echoes the frame settles the
  promise by another route, so the hang cannot be demonstrated with one.
- The response event has to be delivered by hand, as the frame the worker actually
  received, since that is what the pool decodes to find the correlation id.

Two smaller versions of the same trap, both caught: `pool.workers[0].worker` is
**not** the fake worker object, so a first draft threw on every case in the costume
of a broken pool; and `void promise` discards the reference without attaching a
handler, so a rejected promise became an **unhandled rejection** and the suite
reported "1625 passed" with 2 errors that were invisible in the test count. That
last one is the same defect `OBS-003` fixed in the event bus, and a test must not
reintroduce it.

Closes POOL-002.

#### Pool: `stopThePress` enqueued a message nothing had prepared

`stopThePress` handed the caller's `message`/`transfer` straight to
`_enqueueOrReject`, skipping `_prepareForTransfer` — the one call every other
enqueue route makes. One line to fix, and the row is right about the cause.

**But half the row's claim does not reproduce, and the row says it does.** It
asserts the message goes on the wire unframed. It does not: the drain calls
`_encodeForWorker` on whatever it dequeues, and that frames it — measured, the
drained message reaches the worker with first byte 1 and decodes cleanly. So the
on-the-wire symptom is the luck of a downstream rescue rather than design, and the
row's `[verified]` framing is right about the cause and wrong about the visible
effect. Worth knowing, because it is the difference between "this message is
broken" and "this message is unlabelled".

The **`deferred` half is real**, and it is a genuine bypass. Measured, pool full
with one task in flight:

```
codec=negotiated   postMessage   -> message, transfer, deferred   (true)
codec=negotiated   stopThePress  -> message, transfer             (undefined)
```

Under `messageCodec: 'negotiated'` the carrier is a _per-worker_ decision, so an
item the drain finds without the marker gets encoded for a worker that may not
have asked for that codec.

`test/powerPool.stopThePress.test.js`, 4 tests, mutation-checked — reverting the
line fails 3 of 4. The main assertion compares the two enqueue routes against
**each other** rather than against a hard-coded expectation, because "an item in
the queue is a `PreparedItem`" is the property, and two paths disagreeing about it
is what regressed.

Two of my own test expectations were wrong and are recorded in the row: a refusal
cannot be asserted here because draining the queue is the method's documented
purpose, so there is always room by the time it enqueues; and
`recreateWorkers: true` _rebuilds_ the worker, so the instance captured at
construction is stale.

`POOL-004` is the structural answer and is not done. This is the **third** site
that drifted — the direct path, the inline drain, `stopThePress` and
`_dispatchQueuedTasks` each had their own idea of what a prepared item is.

Closes POOL-003.

#### Pool: one dispatch choke point, and the three bugs it would have prevented

The post-and-account sequence existed in **eight copies** — the direct path, the
inline drain in `worker.onmessage`, `_dispatchQueuedTasks`, the single-worker batch
fast path, the least-loaded batch loop, the new-worker batch loop, the fallback
batch loop, and `broadcast` — and each had dropped a different step:

| Copy                               | Missing step           | Symptom                                                                                         |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| single-worker batch fast path      | the deferred encode    | every batched request failed at the first line (`POOL-001`)                                     |
| inline drain in `worker.onmessage` | the worker association | a queued `awaitResponse` promise hung for good (`POOL-002`)                                     |
| `stopThePress`                     | preparation entirely   | an unlabelled item in the queue (`POOL-003`)                                                    |
| direct path only                   | —                      | only it reported a failed post via `_failPost`; idle-state policy differed in three more places |

All four are one defect: **a property is checkable only when one place owns it, so
a fourth copy of a sequence is a fourth place to forget a step.**

`_dispatchToWorker(workerObj, prepared, { correlationId, startTime })` now owns the
post, the deferred framing, the worker association, and
`tasks`/`_activeTasks`/`lastActive`. The fast path's hand-rolled deferred frame is
gone — that is what the method's `deferred` branch replaces.

`test/powerPool.dispatchChoke.test.js` — **the lead test is syntactic on purpose.**
"There is exactly one call site" is not something a behavioural test can see, and a
ninth copy would be re-introducible without any behavioural failure until something
broke on the wire again. It counts `postMessage` call sites in the source and
asserts the two inside the choke point, and asserts the four accounting steps are on
the method rather than on any caller. Mutation-checked: a rogue ninth raw dispatch
fails it, and removing the worker-association fails it. Behavioural tests sit under
it as the net.

**Type debt is unchanged at 290**, which is the part worth noting: the duplication
was not generating measurable debt, only defects. Two intermediate states added 14
and then 6 errors while getting there, and both are recorded in the row — a JSDoc
splice that ate `_failPost`'s `@param` block, and annotating `workerObj` as
`WorkerObj` when that type is over-specified relative to what the worker records
actually are, which costs an error at all eight call sites for no gain.

Closes POOL-004, and with it the whole `POOL-00x` block.

#### A row that was already done, and a "verified" throughput figure that was not

Two corrections to the plan itself, both found by checking a row against the tree
instead of against memory.

**`GATE-003` was half-shipped and left open.** `GATE-002` found a guide
documenting a method that does not exist, and the fix removed it from the API
list, a second entry, a cross-reference and a runnable example — but the _other_
half of `GATE-003`, the `clone` default, was corrected in the prose only. The guide
said `clone = true` in the API list and `clone = false` in the body, and the API
list is the line a reader looks up. A P0 row marked `[verified]`, open against work
that had already shipped, with a self-contradiction surviving three commits — and
`test/docsCodeAgreement.test.js` could not catch it, because that test checks that
a _name_ exists, not that a _default_ is right.

**`types:drift` was blind to untracked declarations.** `GATE-008` reproduced by
hand before changing anything: `git diff --exit-code -- types` compares to the
index, so a probe `types/__probe.d.ts` left the check reporting clean and exiting 0. That is the whole scenario in the row — a newly added source file ships with no
declaration — and the pre-commit hook masks it locally by regenerating _and
committing_ `types/`, so a developer never sees it. Only `--no-verify`, a squash
bot, or a fresh clone does, and by then it surfaces as a "cannot find module" from
`test:types`, pointing at the consumer rather than at the missing declaration.
`types:drift` now reads `git status --porcelain -- types`, so it sees tracked
modifications and untracked additions alike, and prints what to do about it.

**A SIEVE claim that was `[verified]` and is a concurrency result.**
`ALGO-009` asked for two corrections to the plan's cache-adoption analysis, and
both were wrong in the tree:

- §5.1 presented "twice the throughput of an optimised 16-thread LRU" as a
  property of the algorithm. `go-sieve`'s own benchmark says: _"On a single
  goroutine, SIEVE and LRU are within 15 % of each other — the ~100–300× gap is a
  concurrency-scaling story."_ This cache is single-threaded, so the 2× is the
  16-thread comparison. **SIEVE's advantage here is hit ratio, not throughput.**
- §5.1 implied SIEVE removes the dangling-cursor class by mapping onto the
  existing code. It does not: _"the eviction candidate in SIEVE is an object that
  can be in the middle of the list"_ and _"SIEVE's mid-list removal prevents a
  simple circular buffer"_ — so it still needs a doubly-linked list and a hand, and
  a hand that can sit mid-list is the same shape of problem. `GAP-004` is the
  design that removes it, by not having a hand at all.
- And a third correction, to the row's own dependency claim: it ended "CACHE-001
  is required either way". It is not — that defect could not be reproduced, and
  two candidate fixes were reverted after a differential trace found them
  observationally identical to the original. SIEVE and the cursor class are
  separate questions.

Closes GATE-003, GATE-008 and ALGO-009.

#### WebSocket client: a failed connect never settled, and a browser got `Blob`s

Two P0s in `PowerWebSocketClient`, one of which a Node test cannot see at all.

**`connect()` never settled when the attempt failed.** Measured: still `PENDING`
60 ms after both an `error` and a `close`, and with `connectTimeoutMs: 0` — the
documented way to say "wait as long as it takes" — it never settled _at all_. The
socket tier reported the event but never settled the promise, so the only paths
left were `open` and the connect timer. A caller awaiting a connection to a dead
endpoint waited 10 s by default, or forever, against a guide that promises
"rejects on a failed connect".

Two things the fix got wrong first, both caught by **existing** tests rather than
by mine:

- The connect **timeout** path closed the socket _before_ rejecting. Since `close`
  now settles a pending connect — that is the fix — the close's event object won
  the race and the caller got an empty message instead of
  `connect timed out after Nms`, losing both the code and the reason on the one
  error a caller is most likely to handle. Reordered to settle first, then close.
  `test/powerWebSocketClient.test.js` had been pinning the correct error all along
  and is a better test than the one I would have written.
- I wrote a `catch (e) { this._debugLog?.(e, …) }` around the `binaryType`
  assignment. **`_debugLog` is a `PowerPool` field; this class has no such
  member**, so the call would have been a silent no-op that looked like a
  diagnostic. The type-debt ratchet caught it — the gate working as intended on a
  change made two commits after it was hardened.

**A browser delivered every inbound frame as a `Blob`, and the client never said
otherwise.** `binaryType` was never assigned anywhere in the file. A browser hands
you a `Blob` unless it is set, and this library only ever _sends_ binary — so on a
browser every received binary frame failed to decode, while the identical code
against a Node `ws` socket worked. **A test on Node cannot observe it**, which is
why it survived and why it is worth naming separately from the connect fix.

It is now set at **construction**, not on first message: the browser reads the
property when it delivers each frame, so a frame arriving before the assignment is
already a `Blob`. The first attempt used `if ('binaryType' in socket)`, which
does not work — it skips a socket that _accepts_ the assignment but does not
pre-declare it, which is exactly the case where setting it is harmless and
skipping it is not. The try/catch alone is the right shape: it tolerates a
getter-only accessor that throws, since a client that cannot connect is worse than
one that connects with the platform default.

`test/powerWebSocketClient.connect.test.js`, 8 tests, mutation-checked both ways.

**`RT-003` is closed, and the row that seemed to be blocking it was my own
measurement error.** A healthy `ws` socket is no longer closed with 4000 and
reconnected forever: the `pong` reply is handled, the probe deadline is cleared,
RTT is recorded, and `stats().rtt.canPing` says _unmeasured_ rather than showing
0 ms — 27 pings in 150 ms, 0 closes, against 0 pings and a dead RTT series
before.

While fixing it I found what looked like a serious new P0: the heartbeat's
detection timer is armed with an unref'd `setSafeTimeout`, so on a socket that
accepts a ping and never answers the deadline **never fires at all**, and the
heartbeat cannot detect a dead socket. It reads convincingly, it is traced, and it
is **entirely wrong**:

- An unref'd timer _does_ fire while the event loop is alive — verified side by
  side with a ref'd one in the same 60 ms window. The unref is irrelevant, and is
  the right default for a library that promises never to hold a process open.
- The real fault was in my probe: the option is `heartbeatTimeoutMs`, and I passed
  `pongTimeoutMs`, which the class does not recognise. It silently used its **10 s
  default** — so the whole investigation was 100 ms measured against a 10 s
  timeout. With the correct name the same socket produces 5 timeouts and a
  `close(4000)` in 100 ms.

**An option a class does not have is not a no-op; it is the default, and the
resulting number is shaped like a measurement without being one.** The same wrong
name was in the new test file, so every heartbeat assertion in it was measuring a
10 s timeout inside an 80 ms window — which is why the `pong` mutation survived
twice, and why a whole P0 row got filed on the strength of it. All four fixes are
now mutation-checked, and the file carries the correction at the top.

A second, smaller lesson from the same episode: filing that finding used
`RT-022`, **which was already in use** by an unrelated open row about
`SharedArrayBuffer` transfer lists. `scripts/review-row.mjs --check` reported
_clean_, because a duplicate ID is neither a column-count nor a header problem.
That is the third time in this series a guard has reported clean about a file it
had not read correctly, and it is recorded on the row.

Closes RT-001, RT-002 and RT-003.

#### The plan-table validator could not see a duplicate row identifier

A finding was filed under `RT-022`, which was already in use by an unrelated open
row about `SharedArrayBuffer` transfer lists. Two rows with one identifier render
perfectly — markdown shows two well-formed rows — and
`scripts/review-row.mjs --check` reported **clean**, because it validates the
column count and the plan-table header, and a duplicate is neither. So a new row
silently shadowed a real open item, and the guard that exists to keep the table
honest had nothing to say about it.

`checkTable` now records the first line each ID was seen on and reports a repeat
naming **both** lines, so a shadowing row is visible and says what it is
shadowing. `test/reviewTable.test.js` asserts uniqueness over the same table.
Mutation-checked both ways: inserting a duplicate row makes the script exit 1
naming lines 2019 and 2020, and fails the test. The guard then immediately caught
its own second collision — a first attempt to file this row under `GATE-015`
reported a duplicate before it had been written.

**The scope is deliberately narrow.** The table also contains six references to
identifiers that are not rows — `BUG-011` and `QUAL-006` among them, cited as
`review2` provenance for findings that were consumed into rows. Those are
deliberate, so the check asserts uniqueness only. Asserting that every referenced
ID resolves would demand either the consumed findings stay in the table forever or
the references be reworded, and both are worse than a pointer to a finding that is
now a closed row.

This is the **third** guard in this series to report clean about a file it had not
read correctly: `test/reviewTable.test.js` matching no rows at all, the ratchet's
21-code grammar list matching 0 of the 29 codes the project actually emits, and
now this. The common shape is a pass condition that does not cover the property
the guard is named for, and the cost of each was a defect that looked handled.

Closes GATE-017.

#### A home for interaction bugs, which are the ones that unit tests cannot see

`RES-009` closes with `test/gates.interactions.test.js`: one file over the
cancel/reset/release/dispose cross-products of `PowerPermitGate`,
`PowerBackpressure` and `PowerSemaphore`, plus a 200-step seeded random walk over
the same operations. Counters and shapes only, no durations.

Every bug in the permit-gate family was of a kind the per-unit organisation
cannot catch — **each component is correct alone**. A reset that minted a permit a
holder was still using, a cancelled waiter that consumed a permit it never held, a
release that decremented the outstanding count for a _transfer_ so the count went
below zero, a queue-drain route that never recorded which worker took a task so
its promise could never be settled. None of those is a bug in `reset()`, in
`acquire()` or in `release()`. Each is a bug in the composition, and with no home
for composition tests they go unwritten.

Mutation-checked against two of the defects that family actually shipped. The
second is the interesting one: **every permit assertion in the file passes without
the cancelled-waiter decrement**, because a cancelled waiter does consume a permit
on the way through and the pool still balances. Its effect is only visible on the
_counter_ afterwards — `_cancelledWaiters` left one high makes `pending` overstate
the queue for the rest of the gate's life — and only once something queues behind
the corpse. So the test saturates the gate before queueing, which is the entire
difference between catching that mutation and not.

Three versions of this test passed for the wrong reason before the fourth worked,
and the reasons are the point. A random walk that strands promises (a queued
`acquire()` with no release and no abort never settles). A **transfer asserted as a
return**: a release issued before awaiting the waiter is still a transfer, because
the waiter is still queued and takes the permit directly — the order _is_ the
claim, and an earlier draft read 4 where it expected 3. And a `pending` assertion
that failed against correct code because with a permit free the next `acquire`
takes the fast path and never queues.

**`PowerBulkhead` is deliberately not in the cross-product.** It is a _runner_ —
`run`/`tryRun`, no `acquire`, refusing with `null` rather than `false` — so the
permit arithmetic here does not describe it, and a `?.` chain that quietly skipped
it would have made the file look broader than it is. Establishing that turned up
something worth recording: with `maxConcurrency: 2`, four concurrent `tryRun`s were
all accepted and `active` read 4, `isFull` false, `pending` 0. **Whether that is a
ceiling that is not a ceiling, or `maxConcurrency` means something else, is not
established** — so it is filed as `GATE-018` as a measurement to take, and asserted
in neither direction. A test claiming a ceiling I cannot back is the same error as
one blessing a number I do not understand.

Closes RES-009, and opens GATE-018.

#### A string worker path in a browser: `baseUrl`, and a dead branch that looked alive

`WorkerAgnostic` resolved a _string_ worker source against the first base URL it
could find, starting with `import.meta.url` via
`new Function('try { return import.meta?.url } …')()`. **That branch has never run.**
`new Function` evaluates in **global** scope, where `import.meta` is a syntax
error, so the generated function fails to parse, the inner `catch` swallows it, and
the branch yields `undefined`. Verified directly.

The consequence is browser-only and matches the plan: `document.currentScript` is
`null` in a `<script type="module">` per the HTML spec, so the _module's own URL is
never used_. The base falls through to `location.href` — **the page** — so a worker
path written relative to the module resolves against the page and 404s. And because
the fetch is asynchronous the failure arrives as an `error` event on the worker
rather than a throw at construction, so it reads as a typo in the path rather than
as a resolution failure.

The fix is an option, not a repair, because the code **cannot** do what it was
trying to do. The module URL is unreachable from a `new Function` in global scope
rather than awkwardly obtainable, and writing a bare `import.meta.url` would fix
the browser while breaking the CJS and UMD builds the same file must support.

```js
new WorkerAgnostic('./workers/task.js', { baseUrl: import.meta.url });
```

Unnecessary for a classic script or an absolute worker source; Node is unaffected,
since a string source goes to `node:worker_threads` directly. Documented in
`WorkerAgnosticOptions` and in the guide, and the browser test file's header — which
asserted the false claim that `import.meta.url` was one of three fallbacks — is
corrected.

Three tests, mutation-checked: ignoring `baseUrl` fails 2 of 8. **One mutation
survived and it was my code, not the test's** — accepting an empty `baseUrl` as a
base also passed, because `if (baseUrl)` already treats `''` as absent, so the
guard was redundant and the test claiming to pin it was decoration. The guard and
the test were removed rather than loosened.

Closes WRK-001.

#### A teardown that hung its own waiters, and a capability probe per timer

Three defects, each found by reproducing before changing anything, and two of
them are behaviour changes rather than internal cleanups.

**`PowerLatch.dispose()` is now terminal, and pending `wait()`s reject.** It was
implemented as `this.reset()` — whose default argument is `1` — so disposing a
latch left every pending `wait()` **pending for the life of the process**, and
left `remaining` at 1 and `done` false, reporting a torn-down object as still
armed. Worse, `reset()` clears the aborted state by design, so `dispose()` on an
aborted latch made it **live again**:

```js
const latch = new PowerLatch(1);
const waiter = latch.wait(); // was: never settled
latch.dispose(); // was: count re-armed to 1
await waiter; // now: rejects, code 'EDISPOSED'
latch.remaining; // 0
```

This is not a family defect, which was worth checking: `PowerPermitGate.reset()`
already rejects its waiters and `PowerSemaphore.dispose()` inherits that, so
`PowerLatch` was the only `dispose() → reset()` in the library whose `reset()`
did not settle waiters. `EDISPOSED` joins `EABORT`, `ETIMEOUT` and
`ECIRCUITOPEN` as a rejection code, so `catch (err) { switch (err.code) }` can
tell a teardown from an abort.

`PowerGCRA.retryAfter(n)` joins the throwing surfaces as a `RangeError` rather
than a code, because it is a caller mistake about the configured burst rather
than a state transition — see "A batch the limiter could admit, and one it could
never admit" below. The request-count `TypeError` from `assertCount` is in the
same category: both are a caller passing something the limiter cannot honour,
and both are documented per-helper rather than as codes.

`abort()` is now idempotent, and keeps the **first** reason. A second call used
to re-fire `onAbort`, which is reachable from ordinary code — every finally
block that aborts defensively fires it twice for one logical abort — and it used
to overwrite the reason an error-path caller was about to surface.

**Two fixes for a documentation bug where the guide was the only copy.** This
project has now paid for the documented-but-wrong option twice, and both halves
of this release are that class again:

- `defaultMetrics` is exported from the package root. `guides/metrics.md` and
  the `attach()` JSDoc both show `defaultMetrics.snapshot().series` **with no
  import**, and neither mentions the `/metrics` subpath that did have it — so
  following the guide produced a `ReferenceError` at module load.
- `setSafeTimeout` / `setSafeInterval` allocated **two** timers per call, not
  one. Each asked a `_canUnref()` helper whether the runtime's handle supported
  `unref`, and the helper implemented that question by calling `setTimeout`
  itself — a throwaway 0 ms timer, never cleared, per invocation. 4000 calls
  made 8000 timers. The 17 call sites are on the paths that schedule in a loop:
  cache eviction sweeps, the pool idle reaper, the backpressure refill, socket
  and websocket heartbeats, and `PowerEventLoopMonitor` — which made 100 wasted
  timers a second at a 5 ms sample, in the code whose job is to measure the
  loop.

```js
// before: 4000 calls -> 8000 timers
// after:  4000 calls -> 4000 timers
```

The capability is now read off the handle that was actually returned
(`typeof t?.unref === 'function'`) and the helper is gone, which removes the
allocation rather than amortising it — the fix is not the "cache the probe at
module scope" the plan proposed, because the probe was asking a question about
a value the caller already had.

**Three of the regression tests were wrong before the code was, and mutation is
what found it.** Every one of the 19 new tests is checked by reverting the fix:
restoring the old `dispose()` fails 9 of 11, deleting the abort guard fails 2 of
11, deleting the `wait()` guard fails 3 of 11; reinstating the timer probe fails
3 of 8, an unconditional `t.unref()` fails 1, ignoring `keepProcessAlive` fails
1; dropping the `defaultMetrics` export fails 2.

The failures that mattered were all in the instruments:

- A test asserting "a pending `wait()` now rejects" **passed with the fix
  reverted**, because it watched a waiter registered before the abort — already
  rejected, so re-running the reject is a no-op. It only discriminates when it
  issues a `wait()` _after_ the aborts.
- The `setSafeInterval` allocation test counted only `setInterval` and passed
  with the probe reinstated, because the probe billed its throwaway timer to
  `setTimeout`. The probe's cost was real; the accounting was not.
- Detecting the hang by racing a promise against `Promise.resolve()` **loses**:
  chaining off a settled promise costs an extra microtask hop than attaching to
  an already-fulfilled one, so it reported `PENDING` for a promise that really
  had rejected. Raced against a `setTimeout(0)` sentinel — ordered strictly
  after every promise reaction, so a settled promise always wins and only a
  genuinely pending one loses — the same test both discriminates and cuts a
  regression from 45 s of vitest timeouts to 1-6 ms. That is a happens-before
  guarantee rather than a threshold, so it cannot go flaky on a busy machine.

The allocation tests assert a **count**, not a duration, for the same reason the
rest of this repository's tests do: at the ~28% median spread the harness
measures, a duration cannot reliably separate one timer from two, and timing a
throwaway `setTimeout` would be measuring the thing under test.

Closes RES-014, RES-027, PERF-001 and GATE-009.

#### A TCP socket was classified as a `WebSocketStream`, and the override that should have saved you did not work

**Breaking**

`PowerSocketAdapter` detected a `WebSocketStream` by testing `socket.readable &&
socket.writable`. On a Node `Duplex` — `net.Socket` above all — those two
properties are **booleans**, so the test matched every TCP socket in existence.
Measured against a real `net.Socket` on a real loopback connection whose peer
echoed every byte it received:

```js
detectSocketKind(socket); // 'stream'
adapter.kind; // 'stream'
adapter.send('ping'); // false, every call
adapter.isOpen; // true    <- reports a healthy connection
adapter.readyState; // 1
// 0 of 1 messages delivered, while the socket was echoing them
```

The adapter read `socket.readable === true`, found no `getReader`, and returned
without attaching anything. Not one inbound message was ever delivered, and
nothing failed visibly. `send()` returned `false` on every call, which a caller
could mistake for a closed socket.

Detection now asks for the capability each model actually needs, and a
`net.Socket` **throws** — which is what `guides/powerSocketAdapter.md` has always
said an unrecognised object should do.

```js
detectSocketKind(socket); // 'stream'  <- writable.getWriter / readable.getReader
// 'websocket' <- addEventListener
// 'ws'      <- on AND send
```

Two of those tests are load-bearing in both directions. `writable` is checked
before `readable` because a `WebSocketStream` reports `readable: null` until its
connection opens and is still a stream. And the `ws` test requires `send` as
well as `on`, because `on` alone matches every `EventEmitter` in Node — without
it, tightening only the stream test would have moved `net.Socket` from `'stream'`
to `'ws'`, still deaf, and now reporting its TCP `close` as a WebSocket close.

**The `kind` option did not work, and its own error message said to use it.**
That message ends _"Pass `kind` explicitly to override detection"_, and the line
after the assignment called `detectSocketKind` a second time regardless — so on
precisely the sockets detection rejects, following the message reproduced the
error it told you to bypass. `kind` now short-circuits detection, and an
unrecognised value **throws** rather than being stored; a stored kind matching no
branch would attach nothing and report itself open, which is the failure this
class exists to avoid.

**A closed stream stayed locked.** The writable writer is acquired once and the
lock is only released by `releaseLock()`, so a socket that closed — including
through the adapter's own `close()` — left `writable` locked for good, and a
caller holding the socket could not write to it again. The lock is now released
on a close, not only on `dispose()`.

The related row **RT-004 stays open**: the message pump still reads
`socket.readable` once and never retries, so a `WebSocketStream` that is not yet
open receives nothing. That needs a wait mechanism and is not fixed here.

`test/powerSocketAdapter.detect.test.js` covers all of it against real
`net.Socket` connections and real `ReadableStream`/`WritableStream` pairs, with
four mutations checked. Two of the tests were wrong before the code was — the
override test asserted a not-yet-open stream was undetectable, which the
tightened predicate now detects, and one loop asserted all three `kind` values
against a single object although `_attach` dispatches on `kind`. Both were found
by running the suite, and both are explained where they were fixed.

Closes RT-005.

#### A histogram of zeroes reported `max` of `-Infinity`, and one `Infinity` halved the mean

**Breaking**

Two edges where the accumulator and the sketch disagreed, and the documentation
was right about both.

`guides/powerHistogram.md` says `count`, `sum`, `mean`, `min` and `max` are
**exact** — only the quantiles are estimated. Two of them were not.

**A histogram whose every record was `0` reported `max` of `-Infinity`.** `_max`
is initialised to `-Infinity` and values are non-negative, and the `record(0)`
branch updated `_min` and returned. `min` was correct, which is what made this
easy to miss: the histogram contradicted itself in `max` alone, below every one
of its own samples. It reached `toJSON().max` and the metrics series, and
`-Infinity` is not even JSON-representable.

```js
const h = new PowerHistogram({ maxValue: 10, buckets: 5 });
h.record(0);
h.record(0);
h.min; // 0
h.max; // -Infinity  ->  now 0
```

This reached `merge()` transitively and further than the obvious case: `merge`
compares `other._max > this._max`, and `-Infinity > -Infinity` is false, so
**no merge of any number of all-zero histograms could ever produce a finite
max**.

**One `Infinity` halved the mean.** `record(+Infinity)` increments `count` and
then returns _before_ adding to `sum`, because an infinity is deliberately kept
out of the sum and counted in `infCount` instead. Dividing `sum` by `count`
therefore under-reported every histogram that ever saw one:

```js
h.record(10);
h.record(Infinity);
h.count; // 2
h.sum; // 10
h.mean; // 5   ->  now 10
```

`mean` now averages the records that carry a value. `count` still reports every
record — stopping the count would make the mean right and `count` wrong, and
`infCount` is reported beside it precisely so a caller can see how many samples
carried none. A histogram of nothing but `+Infinity` reports `mean` of
`Infinity`; the old `0/0` answered `NaN`, which claims the sketch is broken,
and `0` would claim the samples were zero-sized.

`test/powerHistogram.extremes.test.js` covers both against 16 tests, with four
mutations checked. The fourth is the one worth having: counting infinities out
of `count` instead of fixing the getter is the tempting wrong fix, and it fails
5 of 16.

**`percentile(1)` is unchanged, and that is deliberate.** It returns the 100th
percentile, because the `0..100` and `0..1` ranges overlap at `1` and the
fraction reading wins. `guides/powerHistogram.md` has documented this on purpose
and calls `1` "the one to watch", so it is characterised by a test rather than
changed — which means altering it is now a deliberate act with a guide rewrite
attached, not a silent fix. The JSDoc states the collision and points at the
guide, rather than restating a contract in a way that reads as a promise it does
not keep.

Closes OBS-006.

#### A noisy partition could starve a critical one, which is the one thing the bulkhead exists to prevent

**Breaking**

`PowerBulkhead` partitions its permits and its gates, and did **not** partition
the queue budget. One `_pendingCount` for the whole bulkhead was compared
against every partition's admission decision, so the partition that spent the
budget decided for the others.

Measured with 2 partitions, `maxConcurrency: 1`, `queueCapacity: 2`, submitting
five tasks back to back and reading the state after each:

```
A1   pending 0   A(avail,queued) 0,0   C(avail,queued) 1,0
A2   pending 1   A(avail,queued) 0,1   C(avail,queued) 1,0
A3   pending 2   A(avail,queued) 0,2   C(avail,queued) 1,0
C1   pending 2   A(avail,queued) 0,2   C(avail,queued) 0,0   <- took C's permit
C2   rejected: "PowerBulkhead queue is full"                  <- C had queued 0
```

C's own queue held **nothing**, C's own permit was in use by C1, and C's own
gate reported `queueCapacity: Infinity` — and C was still turned away, by
partition A. Each partition's gate now carries the budget as a backstop (it was
hard-coded to `Infinity`, so the gate could never be the thing that refused),
and the bulkhead checks first so the refusal is still its own error.

**`queueCapacity` is now a per-partition budget.** The total that can wait is
`queueCapacity * partitions`, so this configuration admits more work than it
did:

```js
new PowerBulkhead({ partitions: 4, queueCapacity: 100 });
// before: 100 waiting tasks in the bulkhead
// after:  100 per partition, 400 total
```

That is the intended trade. A shared budget is not isolation, and the number
that made it shared was never visible in the option's name.

**`isFull` and `stats().saturated` changed meaning**, because "is the bulkhead
full" is no longer one comparison. Both are now `true` when **every** partition
is at its budget — when no task that would have to queue can be admitted
anywhere. The alternative, `true` as soon as _any_ partition is busy, would
report the normal state of a working isolated bulkhead as full and make the
flag useless for backing off.

Also: `drain()` no longer waits on `active` and `pending` together. Deleting
the bulkhead's duplicate `_pendingCount` in favour of each gate's own count
exposed a window — a released permit hands the permit to the next queued task
and drops the queue count in the same synchronous turn that the predecessor
settles its own bookkeeping, so both counters read zero while a task is
promoted and not yet begun. `drain()` now waits on a single count of admitted
work. Caught by the pre-existing drain test the moment the gate took over the
count.

`test/powerBulkhead.partition.test.js`, 9 tests, four mutations checked.

Closes RES-008.

#### The admission filter was not sized to the cache it was protecting

`PowerCache` built its TinyLFU sketch with only `sampleSize` set, so `width` and
`depth` kept the sketch's own defaults: a fixed 64×4 = 256 counters, 128 bytes,
whatever the cache's capacity. Counters per cache entry, measured:

| `maxEntries` |      before | after |
| ------------ | ----------: | ----: |
| 16           |       16.00 | 16.00 |
| 64           |        4.00 | 16.00 |
| 1 000        |   **0.256** | 16.38 |
| 1 000 000    | **0.00026** | 16.78 |

The accuracy of an admission filter depending on nothing about the cache is not
a tuning question — at 1 000 entries it stops working. Measured, with a working
set at capacity, on the old 256-counter table:

```
maxEntries 1000:  hot keys all read 15
                  a key NEVER inserted also read 15
                  -> 1 distinct estimate across 6 keys
```

One estimate for everything means the filter cannot refuse a scan key, which is
the only reason a filter is in the admission path. The table is now sized from
the cache's capacity on Caffeine's recipe — a 4-bit CountMinSketch "growing at
8 bytes per cache entry", which is 16 counters per entry, with the width a
power of two because the sketch indexes with a mask.

**The cache now spends memory on the filter proportional to its size.** That is
the cost of accuracy, and it is worth stating plainly: `maxEntries: 1000` takes
8 KB instead of 128 bytes, and the table is capped at the `1e6` entry the
`sampleSize` clamp already used, so a 1 000 000-entry cache spends ~8 MB.
`maxEntries` defaults to `Infinity`, which is why the cap exists at all — and a
cache that large never consults the filter anyway, because `_admit` only
arbitrates once `size >= maxEntries`. Plain `admission: 'lru'` and
`policy: 'slru'` still build no sketch at all.

**The half-life counted operations instead of changes.** `increment()` advanced
`sample` whether or not any counter moved, so once the sketch saturated every
further increment was a no-op on the data — the minimum across rows is already
15, so no estimate can move — and a full countdown on the clock. Caffeine
advances only on an effective increment. The half-life now describes what it
claims to.

**Both benches were re-run, and no conclusion moves.** `lru` and `slru` came back
byte-identical, which confirms the harness is deterministic, and the TinyLFU
figures moved by at most 0.8 points of working-set hit rate. Plain LRU still
beats TinyLFU on the sustained mix, the window still does not rescue cold start
at any size, and SLRU is still the measured answer.

One stale number turned up on the way: the guide listed `policy: 'slru'` with
`admission: 'tinylfu'` at 70.9 % / 15.2, which described a build where the
sketch was still constructed for SLRU. It is `null` under any policy but LRU, so
the row is the same configuration as plain `slru` and now reads 89.4 % / 33.0.

`test/powerCache.sketchSize.test.js`, 10 tests, four mutations checked. The
sizing assertions are ratios and thresholds, never a pinned width — a pinned
number would be a claim about one machine's arithmetic that breaks when the
target ratio or the depth changes, and the review that asked for this recorded
that a previous attempt's exact figures could not be reproduced by the person
who filed it.

Closes CACHE-005 and ALGO-011.

#### The generated API reference was not checked by anything, and had been superseded

`docs/` is committed, the project website links into it, and `AGENTS.md` calls it
the second-most-consulted artefact in the repo — and no check anywhere asked
whether it matched `src/`. `types/` had `types:generate` then `types:drift`;
`docs/` had neither. `npm run verify` is now **nine steps**, and the ninth is
`docs:drift`.

It found real drift immediately. Regenerating produced **106 changed files**,
mostly deletions: the entire `docs/helpers/jsdoc-types/` tree. `typedoc.json`
excludes `src/helpers/jsdoc-types.js`, `src/utils/options.js` and
`src/utils/timers.js`, so those pages stopped being produced when the exclusions
landed and survived only because `cleanOutputDir: true` means nothing deletes
them but a regeneration nobody ran. This is the direction of drift that hides
itself — a stale generated tree still looks exactly like documentation.

Two properties of the new step are not true of the other eight, and both are in
the script's docblock rather than left to be discovered:

- It is the only step that **rewrites a committed tree** before comparing it.
  `cleanOutputDir: true` leaves no incremental mode to diff against, so a bare
  `git diff -- docs` would have passed forever. It regenerates and _then_ asks.
- It runs **last**, after `types:generate`, so the tree `docs/` was generated
  from is the one `types/` was generated from — and because at 2.1 s over ~100
  files it is the slowest step and never the interesting failure.

The gate was **observed failing**, not just passing: with the index reset to the
stale committed tree it exits 1 and names all 106 files. A first attempt at that
observation passed, and the reason is worth recording — `git checkout HEAD --
docs` does not prune the index, so the pathspec checkout left the regenerated
pages staged and the working tree matched the index, which is what the check
compares. It compares to the **index** rather than to `HEAD` on purpose, so a
pre-commit tree passes and a `--no-verify` or squash-bot tree fails, but that
does mean a polluted index can mask real drift.

`test/verifyGate.test.js`, 9 tests. The one that matters most: every step in
`verify.mjs` must have a matching `package.json` script, because a typo there is
not a skipped check — it is a gate that exits 1 with `npm ERR! Missing script`,
which reads as a broken gate and invites being switched off. The tests also
assert that each `generate` step precedes its `drift` step, and that the failure
message no longer hardcodes **"eight steps"** — it did, and a hardcoded total in
the message that names the failing step is the same class of thing that drifts
when a step is added.

Closes GATE-010.

#### The gate that checks the generated docs could not fail

`docs:drift` was committed wrapped in parentheses, and the parentheses made it
unfailable. `exit 1` inside braces inside a subshell exits the **subshell** — the
rest of the script carried on, the exit status came from whatever ran last, and
the gate reported success on a tree it had just found dirty.

It went unnoticed _despite being observed failing once, on a tree that really was
drifted_, because that failure came from the untracked-pages arm, which is at
top level. This is the limit of "did I see it fail", and it is worth stating
plainly: **a guard whose failure has been observed can still be failing in the
wrong place.** That is an argument for pinning the structure and not only the
behaviour, which is what the three new assertions in
`test/verifyGate.test.js` do — no `exit 1` reachable from an unclosed `(`, a
top-level `exit 1` for the diff rather than no arm at all, and the generate step
guarded separately, because `A and B or C` groups as `(A and B) or C` in the
shell and a **typedoc crash was being reported as "docs/ differs from the
index"** — a misleading message about the wrong problem.

The same commit shipped the wrong `docs/` content for a related reason: typedoc
writes a `***` thematic break, the committed tree held `---`, and 132 files were
diverging. The cause was that `.husky/pre-commit` runs `prettier --write` on
`*.{json,md,yml,yaml}`, which matches every generated `docs/**/*.md` — so the
commit hook and the generator were **two writers to one committed tree**, and
which one won depended on whether a commit happened. `docs/` is now excluded
from lint-staged, and the regenerated tree is committed. Generated output must
never be handed to a commit-hook formatter.

Closes GATE-010.

#### The quick chooser told a newcomer to call a method that does not exist

`guides/metaGuide.md` attributed `eventLoopUtilization()` to
`PowerEventLoopMonitor`:

```
- `PowerEventLoopMonitor`: Event-loop delay histogram and `eventLoopUtilization()`.
```

The accessor is `utilization()`. A reader following the router that
`AGENTS.md` points people at would write `monitor.eventLoopUtilization()` and get
a `TypeError`. Node does export an `eventLoopUtilization()` — from
`perf_hooks` — which is what made the sentence plausible enough to survive
review, and which is why it was fixed in the guide rather than excused in a
stop-list.

It was found by a check, not by reading. The existing GATE-002 gate compares a
guide's backticked calls against the source of the **helper the guide is named
after**, and skips any guide with no same-named helper. Measured across all 40
guides, that is **6** — `autoscale.md`, `errors.md`, `metaGuide.md`, `now.md`,
`traceContext.md`, `troubleshooting.md` — carrying 22 distinct call names
between them that no check in the repository looked at, including `drain(`,
`getStats(`, `nowMs(`, `decodeMessage(`, `tryConsume(` and
`eventLoopUtilization(`.

The extension is a **union across all of `src/`** rather than a per-guide check:
any class member or any exported name satisfies it, so a name belonging to a
class the guide is not about is satisfied once instead of needing an entry in
every file. Six of 40 guides are now covered that were not, and the two
highest-traffic ones — the quick chooser and the error guide — are among them.

It went into the existing `docsCodeAgreement.test.js` rather than into
`apiSurface.test.js`, as the row proposed. That file already pins export names;
the defect is a property of guides, not of the package's export list, and a
second file holding a second list of method names is precisely the
two-lists-drift shape that made this project's CI run neither `test:types` nor
`check:bundle` for as long as both existed. Four mutations, all caught, including
reintroducing the bad sentence in the guide.

Closes GATE-004 and GATE-005.

#### A `WebSocketStream` that had not connected yet was permanently deaf

`PowerSocketAdapter`'s stream pump read `socket.readable` **once** and returned
if it was not a `ReadableStream`. A `WebSocketStream` reports `readable: null`
until its connection opens, so the pump gave up before there was anything to
read, and nothing ever re-armed it. The adapter's own state was
indistinguishable from health the whole time: `kind` was `'stream'`, `isOpen`
was `true`, `send()` returned `true` and `bufferedAmount` was `0`. Measured
before the fix, 0 of 1 messages delivered with the stream opened and the message
pushed afterwards.

It now waits, and the choice of mechanism is the interesting part: **a poll with
backoff, not an event.** `WebSocketStream` from `ws` does emit `'open'`, but a
browser `WebSocket` exposed as a stream may not, and an object that merely gains
a `readable` later certainly does not — an event-based wait would fix the easy
case and leave the rest.

The interval starts at 5 ms and doubles to a 250 ms cap. Backing off is not
cosmetic: the failure mode of this design is a stream that never opens, and a
fixed short interval would cost 100+ wakeups a second for as long as the socket
lives. There is **no attempt limit**, because a connection that takes a minute to
open should still be read when it does, and a deadline would be a new option and
a new documented failure. `close()` and `dispose()` both stop the wait, and the
retry timer is cleared with the rest — it had to be, because nothing else re-arms
it, so it would have sat re-checking `readable` on a socket the adapter had
finished with.

Two properties worth stating plainly:

- The cost on the ordinary path is **zero**. The first attempt is synchronous and
  the timer is only armed after it fails, so a stream that is already readable
  never schedules work.
- The timers are unref'd, so an adapter waiting on a socket that never connects
  cannot hold a Node process open.

Until the stream opens the adapter looks entirely healthy, so a socket that is
never going to open is not distinguishable from a slow one. That is deliberate:
failing a merely-slow connection is the worse outcome, and the pump cannot tell
"not yet" from "never".

`test/powerSocketAdapter.streamWait.test.js`, 7 tests against real
`ReadableStream`/`WritableStream`, four mutations checked. Two claims in the
review row were wrong and are corrected on it: **there is no `backpressureMode`
on `PowerSocketAdapter`** — it is a getter on `PowerWebSocketClient` — and the
adapter's equivalents are `stats().kind` and a `bufferedAmount` of `0`.

This completes RT-004; the `releaseLock()` half shipped in the socket-adapter
commit above.

Closes RT-004.

#### `using` a cache leaked its metrics series, and a memoized method's entry could never be invalidated

**`using cache = new PowerCache({ observability: true })` left the series
registered.** `dispose()` called `detach(this._metrics)` and then
`[Symbol.dispose]()`; the symbol did only `stopCleanup()` and `clear()`. The
detach now lives in the symbol, because a `using` block is a scope exit and that
is the teardown path the guarantee is about. Nothing failed this way — the
collector kept sampling an object nobody could reach and answering every time.

This is the same bug `PowerBulkhead` and `PowerRetryBudget` were already fixed
for, in a class that fix did not reach. `test/metrics.lifetime.test.js` pins both
of those, which is why the gap was findable.

**A method-memoized entry was cached and unreachable at the same time.** The
helpers attached to a memoized function were arrow functions, which discard their
receiver, so `memo.call(obj, 10)` stored `r1:10` while `memo.get(10)` looked up
`10`:

```js
obj.double(10); // 20, stored under obj's scoped key
memo.get(10); // undefined
memo.has(10); // false
memo.delete(10); // false — and the scoped key stayed in the cache
```

No helper could remove it. They are ordinary functions now, and the receiver is
turned back into a key. **The documented signature is unchanged** — the guide
says `get(...args)`, and calling a helper plainly leaves the memoized function
as the receiver, which resolves the unscoped key a plain `memo(10)` call stored:

```js
memo.get.call(obj, 10); // 20
memo.delete.call(obj, 10); // true, and the scoped key is gone
```

A detached helper (`const g = memo.get`) still resolves the unscoped key, which
the arrow form gave for free and a `function` in a module does not — pinned
explicitly, since that is the one behaviour the change could have silently
broken.

`test/powerCache.memoizedKeys.test.js`, 12 tests, four mutations checked. The
`delete` mutation returns `true` without evicting, which is why the test reads
the cache keys directly rather than trusting the return value.

Closes CACHE-010.

#### One `yield()` anywhere kept your Node process from exiting

`PowerScheduler`'s macrotask strategy builds a **module-level** `MessageChannel`
and assigns `port1.onmessage`, which _starts_ the port — and a started
`MessagePort` keeps the Node event loop alive. So a single scheduler with
`scheduling: 'macrotask'` anywhere in a program kept that program from exiting,
**including after `dispose()`**, which only neutralised `cancel`.

A CLI, a serverless handler, or a test that touched the scheduler once hung at
the end, doing no work, waiting on a port nothing would post to again. The whole
of it needs no library at all:

```js
const c = new MessageChannel();
c.port1.onmessage = () => {};
// …this process now never exits
```

The port is now `unref`'d when it is started, and `dispose()` closes both ports
and clears the module reference. `unref()` rather than only closing, because
`dispose()` cannot help a scheduler that is simply never disposed — the same rule
`utils/timers.js` and `PowerCron` already follow, with the same trade: a flush
pending when the process would otherwise exit is dropped rather than holding the
process open. Guarded, because a browser `MessagePort` has no `unref` and
browsers have no loop to hold open.

**This is not the `setImmediate` swap.** That change was already measured in this
project at 608× per turn and then found to be **within noise end to end** —
`PowerChunker` posts chunks as a batch, so per-turn cost is not batch cost. The
performance half of the review row was a withdrawn claim; the hang is the real
defect, and it is a correctness one.

`test/powerScheduler.macrotask.test.js`, 10 tests, in a **subprocess** because a
hang is not observable in-process — vitest owns the event loop, so a pinning
scheduler looks identical to a non-pinning one. The `microtask` path is the
control in the same file, because "the process exits" is only evidence if
something in it does not.

Worth recording: the first version of that test file was **decoration, and
mutation said so**. Deleting the port teardown from `dispose()`, and not clearing
the module reference, both reported every test green — `unref()` alone is enough
to let a process exit, so "the process finished" cannot tell the two mechanisms
apart. The port teardown had no test at all until tests that observe the real
ports were added.

Closes RES-005.

#### Message protocol

Adds **protocol negotiation** to `PowerPool`, and corrects a claim.

The framed protocol is the default because it is portable. It is also lossy, silently, for a class of values a worker will reasonably be handed. Measured through the shipped path (`node bench/claims.js carrier`), a worker using `decodeMessage` receives:

| you post                  | the worker receives                                     |
| ------------------------- | ------------------------------------------------------- |
| `new Map([['a', 1]])`     | `{}`                                                    |
| `new Set([1, 2])`         | `{}`                                                    |
| `new Date(1234567890123)` | an ISO **string**                                       |
| `10n`                     | the message posts unframed, then `decodeMessage` throws |
| `Infinity`, `NaN`         | `null`                                                  |

`Date` is the sharpest: nothing fails at the boundary, and the first `.getTime()` in the worker throws somewhere unrelated, long after the `postMessage`. Framing every message is a decision to describe every message as JSON, and that description is wrong.

`messageCodec: 'negotiated'` fixes it without changing what any other worker receives. **The worker advertises; the pool only listens:**

```js
// pool
const pool = new PowerPool(WorkerScript, { messageCodec: 'negotiated' });

// worker
import { decodeInbound, announceCapabilities } from 'performance-helpers';
parentPort.postMessage(announceCapabilities());
parentPort.on('message', (data) => {
  const { codec, value } = decodeInbound(data);
  // ...
});
```

The pool posts a frame to every worker until one advertises, then the native structured-clone carrier to that worker alone — which preserves `Map`, `Set`, `Date`, `RegExp`, `BigInt`, `Infinity`, `NaN` and sparse arrays intact. A mixed fleet is a normal state during a rollout, so the pool can be switched on before any worker is ready; `pool.getStats().protocol` reports how many workers have upgraded.

**The direction is the design.** A pool-asks handshake would have to put a control message on a worker's port, and any worker that did not implement it would run that message as a task. Asking only that a peer stay quiet cannot break a peer that has never heard of the protocol.

Also in this release:

- **The "2–5× faster" claim is withdrawn.** It was never measured, and measurement says
  otherwise: a structured clone is a tie for small objects, up to ~1.7× _slower_ for deeply
  nested structure, and faster only for string-heavy payloads (a 64 KB string goes 171 µs to
  8.9 µs). Fidelity is the reason to adopt the native carrier, not speed — which is why it
  is negotiated per worker rather than made the default. `node bench/claims.js carrier`
  reproduces the table.
- `decodeInbound(data)` reads every carrier a pool can send — a framed message, a native
  envelope, and a 1.x bare-JSON body — in one call. It replaces the
  try-the-frame-and-fall-back-to-bare-JSON dance that every worker otherwise re-derives, and
  that this repository had in three places. Only a body whose version byte claims version 1
  is decoded as a frame, so a version-2 or truncated frame still reports its real error.
- `encodeNativeEnvelope`, `announceCapabilities`, `isNativeEnvelope`,
  `isCapabilityAnnouncement`, `collectTransferables`, `NATIVE_ENVELOPE_KEY`,
  `NATIVE_PROTOCOL_VERSION` and `MESSAGE_CODECS` are exported.
- A `pool:protocol` event fires when a worker's advertised capabilities change. Capability
  announcements are consumed by the pool rather than forwarded to `message` listeners, and do
  not touch task accounting.
- An unknown `messageCodec` value now resolves to the documented default rather than
  selecting a protocol the caller did not ask for.
- A message containing an `ArrayBuffer` is copied before being transferred on the native
  carrier, so a caller's buffer is never detached by a `postMessage`. This costs a copy, and
  it is the price of not destroying the caller's data.

Fixes `WorkerAgnostic` silently ignoring a bundle-relative worker path in the
browser.

**The symptom:** in a browser, `new WorkerAgnostic('./workers/task.js')` passed
the string straight to `new Worker(...)`, which the browser resolves against the
**document** base URL rather than the bundle that named it. The worker 404s as
soon as the app is served from a subpath — and a 404 from a worker constructor is
indistinguishable from a typo in the path, so the failure reads as your string
being wrong rather than as a resolution base being wrong.

**The cause:** `resolveWorker` had a fast path returning
`new GlobalWorker(workerSource, options)` for _any_ string source, placed above
the environment check. A browser always has a global `Worker`, so every string
source took that branch. The URL resolution below it —
`createWebWorkerFromString`, which prefers `document.currentScript.src` and falls
back to `location.href` — was therefore **dead code in a real browser**: present,
commented, and never executed by anything.

`browser` and `webworker` now go through that resolution. `node` and `unknown`
keep the fast path, which is what it is for: a runtime aliasing `worker_threads`
to `Worker` (the bench harness does) has no browser base URL to resolve against,
and routing it through the browser helper would look for a `document` that is not
there.

Also in this release:

- `test/WorkerAgnostic.browser.test.js` covers the path, including the two
  fallbacks (no `currentScript` → `location.href`; no base URL at all → the raw
  string) and the `new URL()` rejection fallback.
- `WorkerAgnostic.js` branch coverage 73.42% → **83.44%** (statements 77.3% →
  86.52%, lines 81.35% → 89.83%), closing TEST-003's `WorkerAgnostic` target.
  **The uncovered lines were not merely a metric — they were the only place this
  bug could be seen.** Lines 47–65 and 91 stay uncovered because they run only in
  pure ESM, where `require` is genuinely absent; vitest injects `require` into the
  module _scope_, so stubbing the global does not reach them (verified, not
  assumed). Their _behaviour_ is tested in a real ESM subprocess by
  `test/WorkerAgnostic.pureEsm.test.js`. Behaviour versus coverage is the
  distinction that matters here: one is a contract, the other is a number.
- `test/reviewTable.test.js` no longer asserts a tally of how many plan rows cite
  a section reference. `review.md` is gitignored, so the count describes nothing
  in CI (the suite skips) and had to be retuned in the same commit as every row
  that was closed. The stronger form — "every row cites a section" — is false:
  60 of 107 rows do not, and they are not malformed. A test whose expected value
  is "whatever the untracked file currently says" is not a test.

#### Benchmarks and the timing gate

Runs the W-TinyLFU admission-window experiment, and closes it on a measured
**no**.

`design/0001-tinylfu-admission-window.md` ended on one question — _raise the
window floor and see whether retention follows_ — after two implementation
attempts were reverted. It has now been asked.

The window is implemented in `PowerCache` behind an opt-in `windowSize` option
(default `0`, so nothing shipped changes), and the sweep runs inside
`bench/claims.js zipf` rather than in a private script. A standalone harness
written first produced numbers that disagreed with the benchmark — 58 % against
its 75 % — and was discarded: the moment the workload stops being the
benchmark's own, the measurement stops meaning anything.

**The first sweep read negative, and it was an artifact.** All seven window
sizes (1–32) landed within a point of the shipped no-window behaviour, which
reads as "a frequency filter earns nothing here". It was not that. Two boundary
bugs were producing the result, both found by the tests the experiment required,
and neither raised an error:

- Arbitration judged the entry count **after** the insert, so the last key of
  every fill contended with a main-space victim it should have been promoted
  past, and a 40-key warm ended at **39** entries.
- `_windowOldest()` walked a fixed number of steps, which is correct only while
  the window is full. A challenger that loses arbitration is dropped and the
  window is briefly one short, at which point the walk crossed into main space
  and a recency bump landed _behind_ a key inserted fifty sets later, silently
  destroying main space's recency order.

Fixing the first moved `windowSize: 1` from 70.9 % to **76.5 %** — from below
plain LRU to above it. **A negative sweep result deserves a second look before it
is believed.** This one looked like a finding about the mechanism and was a
finding about a boundary.

Corrected, retention follows the floor and then runs away from it:

| variant                | ws hit rate | survivors |
| ---------------------- | ----------: | --------: |
| `lru`                  |      75.0 % | 17.2 / 40 |
| `admission: 'tinylfu'` |      70.8 % | 15.0 / 40 |
| `+ windowSize: 1`      |  **77.3 %** | 15.4 / 40 |
| `+ windowSize: 16`     |      70.7 % | 19.2 / 40 |
| `policy: 'slru'`       |  **89.4 %** | 33.0 / 40 |

_Re-measured after the sketch was sized from the cache capacity; see "The
admission filter was not sized to the cache it was protecting" below. No
conclusion moves: TinyLFU without a window still loses to plain LRU, and SLRU
is still the answer._

Small windows maximise the hit rate; large windows maximise the survivor count
and lose it, because a bigger window admits more scan keys into main space and
more working-set keys survive the run having been displaced and re-admitted
during it.

**The cold-start case is not met at any window size**, and it is the case the
window was built for. `node bench/claims.js coldstart` — a cold 40-entry cache
flooded with 460 one-shot keys, then the working set worked five times:

| variant                |   hit rate |
| ---------------------- | ---------: |
| `lru`                  | **80.0 %** |
| `admission: 'tinylfu'` |      0.0 % |
| best window size       |      2.0 % |

A working-set key arriving into a cold sketch ties with the scan keys already
resident, and a tie is not a win — so the filter refuses exactly the traffic it
should admit, indefinitely, because a key that is never admitted never
accumulates the frequency that would let it win. TinyLFU needs history, and a
cold cache flooded by a one-shot scan is the workload built specifically to deny
it.

The design note's gate was four criteria, all or nothing. **Two of four are
met**, so the window does not ship as a recommended option: `windowSize` stays
`0` by default and is documented as not recommended, and `policy: 'slru'`
remains the measured answer to scan resistance at 89.4 %.

Also in this release:

- `node bench/claims.js coldstart` is a new workload measuring cold start
  separately from the sustained mix, because the two answer differently and
  reporting only the second is what made the sustained result look like a win.
- `node bench/claims.js zipf` now includes the window-floor sweep by default.
  `CLAIM_WINDOW_SWEEP=0` turns it off.
- Twelve tests in `test/powerCache.window.test.js` pin the invariants the
  mechanism rests on: a 40-key warm reaches 40, the window and the counter
  always describe the same set of nodes, `size` never exceeds `maxEntries`, and
  `onEvict` fires on window evictions.

Adds a per-machine performance-regression gate, and closes TEST-006's remaining
half.

The item specified "a coarse CI check: `PowerCache.get` and
`PowerThrottle.tryConsume` within ±20 % of a committed baseline". That is not
what shipped, because it cannot work: BENCH-001 measured a **28.61 % median
min/max spread** (p95 85 %) on this machine, so a ±20 % gate would fail on a
clean tree about as often as it passed. The fastest way to get a flaky gate
ignored is to ship one.

What shipped is a gate whose threshold is **derived rather than chosen**:

```bash
npm run bench:baseline       # measure this machine and record its baseline
npm run bench:gate           # measure and compare
```

- **The threshold is each site's own recorded spread**, so a clean tree passes
  by construction and a site calibrated at 80 % spread is not held to the same
  bar as one at 8 %.
- **Baselines are per-machine and gitignored**, in `bench/baselines/<hash>.json`.
  A committed absolute baseline is a claim about every other machine's hardware.
- **Three answers, not two.** `PASS`, `FAIL`, or `INCONCLUSIVE` — and
  _inconclusive is never a failure_. It covers a machine whose level has drifted
  (detected by the median delta across all sites, so one real regression cannot
  hide inside it) and one noisier than it was calibrated.
- **A failure re-measures before it is reported.** Nine samples trimmed one from
  each end still admit a GC pause landing on one measurement; a real regression
  survives the second run and a blip does not.

**Mutation-checked, because a gate that always passes is worse than none.** A
deliberate second `get` inside `PowerCache.get` is caught and reproduced
(`cacheHitMs` 9.9 ms → 16.0 ms, +62 % against a 17.6 % threshold); a clean tree
is not. Two earlier versions of this gate failed that check and were fixed
rather than shipped:

- One had **no cache site to move at all**. The helper benchmarks covered twelve
  helpers and neither `PowerCache` nor `PowerThrottle` was among them — the two
  the item names. It passed a deliberate constant-factor slowdown in
  `PowerCache.get` and reported `PASS`. Both are now measured, through the same
  `benchVariantRepeat` trimming as everything else.
- One turned a site's recorded 60 % band into a 3000 % allowance through a
  units error, and passed a 64 % regression.

Also:

- `bench/run.js` writes `measurement.bands` — every per-site median, min, max
  and spread — into `results.json`. Previously only the aggregate survived,
  which made per-site gating impossible.
- `test/benchBaseline.test.js` covers the decision logic: pass, fail, both
  inconclusive paths, the per-site threshold being the recorded spread, and a
  single regression not being hidden by the machine-shift check.
- The gate measures the harness's `helpers` mode. The full run takes the better
  part of an hour, which is too long to run before landing a change;
  `BENCH_GATE_MODE=all` overrides.
- On a fresh CI runner with no baseline, `bench:gate` exits 0 and says why. A
  missing measurement is not a regression, and exiting 1 would put a red X on a
  run that told the truth.

Adds `observability: true` to the helpers that report stats.

Since 2.1.0 a helper can register its own `stats()` with a metrics collector,
so the three-line setup from the previous release is now one option:

```js
import { defaultMetrics } from 'performance-helpers/metrics';

const cache = new PowerCache({ observability: true });
const pool = new PowerPool(workerPath, { observability: true });

defaultMetrics.snapshot().series; // { 'cache.hitRate': …, 'pool.activeTasks': … }
```

Or pass your own collector, with an optional prefix so several processes' helpers
stay apart:

```js
const metrics = new MetricsCollector({ prefix: 'worker-3.' });
new PowerCache({ observability: metrics });
```

Available on `PowerCache`, `PowerPool`, `PowerBulkhead`, `PowerGCRA`,
`PowerEventLoopMonitor`, `PowerRealtimeHub`, `PowerSocketAdapter`,
`PowerWebSocketClient` and `PowerRetryBudget`.

**Off by default on every one of them**, so the common case allocates nothing
and no closure is created. Declared in each helper's options type, so a typo is a
type error rather than a silent no-op.

**`PowerRetry` deliberately does not respond.** It has no counters of its own —
the `PowerRetryBudget` it holds is the thing with numbers — and an always-zero
series would read as "this helper is idle", which is a different and wrong
claim. Use `new PowerRetryBudget({ observability: true })`.

**Helpers detach on teardown.** A disposed, stopped or terminated helper
removes its own registration, because a collector that keeps sampling a dead
helper is worse than one that never had it: `terminate()` on a pool still
answers `getStats()`, so a leaked registration keeps reporting a dead pool
forever and nothing fails visibly while the series quietly stops moving.

Adds the measurement that closes FEAT-012's streaming half without building it.

`node bench/claims.js stream` compares posting a payload in one message against
pushing the same payload through a `TextEncoderStream` in pieces and
reassembling it — the work a chunked protocol would require.

| payload | chunks | one message |   streamed | reassemble | total |
| ------- | -----: | ----------: | ---------: | ---------: | ----: |
| 16 KB   |      1 |     15.7 µs |   226.6 µs |     2.0 µs | 14.6× |
| 64 KB   |      1 |     87.9 µs |   598.6 µs |    17.4 µs |  7.0× |
| 256 KB  |      4 |    252.0 µs |  2530.4 µs |    13.4 µs | 10.1× |
| 1024 KB |     16 |    800.0 µs | 10280.0 µs |    59.3 µs | 12.9× |

No size pays, and the gap is not stream overhead — it is that there is nothing
to stream _for_. Streaming is a bandwidth discipline: it exists because a link
delivers bytes progressively and a consumer that needs all of them would rather
start than wait. A `Worker` port is not a link. The payload is already resident
in this process's memory, `postMessage` hands over its `ArrayBuffer` by transfer
rather than by copy, and there is no slow producer on the far side for
backpressure to apply to. A chunked protocol would add an envelope shape, an
ordering and completeness contract, and a reassembly buffer, to arrive at the
same bytes.

Where a payload genuinely does arrive in pieces — a file, a `fetch` body, a
`WebSocket` — the caller already has a `ReadableStream`, and `PowerMessageCodec`
already reads frames off one. That is where the capability lives, and it shipped
in 2.0.

This is the same structural finding as FEAT-013 (compression) in the same
session: a proposal to optimise a transport that does not charge for what the
optimisation saves.

Adds `performance-helpers/metrics`: a stable, versioned shape over the numbers
the helpers already report.

Every helper that reports anything does it through its own `stats()`, and those
shapes are not merely different — they are different _kinds_ of thing. A
`PowerCache` reports counters. A `PowerGCRA` reports mostly _configuration_
(`rate`, `per`, `burst`) plus one state variable. An `PowerEventLoopMonitor`
reports measurements. A `PowerPool` carries a _nested array_ of per-worker
objects. Plotting cache hit rate beside event-loop p99 means knowing all of
that, and re-learning it whenever a helper's internals move.

```js
import { MetricsCollector } from 'performance-helpers/metrics';

const metrics = new MetricsCollector();
metrics.register('cache', () => cache.stats());
metrics.register('pool', () => pool.getStats());

const { version, collectedAt, series } = metrics.snapshot();
series['cache.hitRate'];
series['pool.activeTasks'];
```

Three rules make a flat `series` map work across all four shapes, and each is a
decision rather than an implementation detail:

- **`null` is kept**, so "never called" and "not reported" stay distinguishable.
- **Arrays are omitted.** Joining them would put an unbounded number of series
  in the map; per-worker detail stays on `pool.getStats()`.
- **`Infinity` and `NaN` become strings.** `Infinity` is how a rate limit says
  "unlimited", and coercing it to 0 would read as a measurement.

Snapshotting is explicit and pull-based — a sink that fires on every operation
becomes a performance problem, and one that samples on a timer is a timer you
cannot turn off. A source that throws is recorded under `errors` and the rest is
still collected.

**This adds no counters.** Every number reported already exists in some
`stats()`; the module supplies a shape, and a second source of truth would
drift from the first.

Not included: an `observability: true` option on the individual helpers. There
are nine helpers with `stats()`, and shipping that option for a subset would
make `observability: true` mean three different things depending on which helper
you passed it to. Until it lands for all nine, register sources yourself.

Closes two features on a measurement rather than a guess, and adds the
benchmarks that did it.

Both rows carried a precondition — "needs a large-payload bench to justify",
"the one change that could move the pool's floor cost" — and neither had been
run. Now they have, and both premises turned out to be wrong.

**FEAT-013 (compression on the message path) is not built.** `node bench/claims.js payload`:

> A `Worker` port is not a wire. The threads are in the same process — no
> network, no serialisation link, no bandwidth to save. `postMessage` already
> moves a large payload by _transferring_ its `ArrayBuffer`, and the pool
> already offers that path.

At 650 KB, gzip costs **1183 µs** in the sender to save 92% of the bytes, and
brotli costs **417 ms**; transferring rather than copying costs **30 µs**, and
the pool already does that. At 596 bytes brotli costs 653 µs for a 596-byte
message, because the cost is not proportional to the saving. `CompressionStream`
— the web API the row named — is _worse_ than the one-shot API, at 7692 µs
against 230 µs for the same payload: a stream carries fixed per-call overhead,
which is the wrong shape for a message where the whole payload is in hand at
once. There is no size threshold that makes this pay.

It would pay on a link that charges per byte — a `WebSocket`, `fetch`, or a
worker on another host. `PowerMessageCodec`'s framed byte-stream mode already
covers those, and `bench/claims.js` already demonstrates reading frames off a
stream.

**FEAT-011 (a `SharedArrayBuffer` permit pool) is not built.** `node bench/claims.js permit`:

> `PowerPool` gates every dispatch with `tasks < this._maxTasksPerWorker` — a
> plain field read at **1.82 ns/op**. A shared-memory permit pool makes the same
> decision through an atomic: `Atomics.load` at **11.65 ns/op**, `Atomics.add` at
> **11.23 ns/op**.

That is 6.4× more expensive at the one place the pool would consult it, and the
pool's floor cost is worker creation and message transport rather than permit
accounting. The blocking half is worse: `PowerSemaphore` documents itself as an
async gate that does not block the event loop, and 1000 `Atomics.wait` calls of
1 ms measured **1055.7 ms** — it parks the thread for its full timeout, exactly
the behaviour that exists to be avoided. `Atomics.waitAsync` does not block, so
it is a timer and adds nothing an async queue does not already provide. And
`Atomics.wait` is forbidden on a browser main thread while `SharedArrayBuffer`
needs cross-origin isolation, so the feature would work in Node and be silently
unavailable on the web.

The capability itself is not unreasonable — a global cap across a fleet is
already `size × maxTasksPerWorker`, enforced centrally. Sharing a budget across
_independent_ workers is a real need, but it is a new helper with a new API,
specified from a use case rather than from a mechanism.

**TEST-006 is complete.** Both halves are done: the counter-based guard
(operation counts, machine-independent) and the timing gate, whose threshold is
derived from a measured per-machine spread rather than chosen in advance. It
reports `PASS`, `FAIL` or `INCONCLUSIVE`, and inconclusive is never a failure —
so a busy machine cannot produce a red build. A `FAIL` re-measures before
reporting, because a single GC pause is not a regression. It is
mutation-checked: a deliberate constant-factor slowdown in `PowerCache.get` is
caught and reproduced, and a clean tree is not.

Rejects an `awaitResponse` promise when the worker that owes it is retired.

If a worker was terminated while it still had in-flight `awaitResponse`
requests, the pool decremented the task counter and terminated the worker but
left the caller's promise outstanding. The response was never coming, so the
promise sat until `awaitResponseTimeout` — 30 seconds by default, and **forever**
under `awaitResponseTimeout: Infinity`. Every other path that abandons a pending
response (queue eviction, post failure, pool-growth failure, shutdown) already
rejected it.

It now rejects immediately with a new code:

```js
try {
  const result = await pool.postMessage(payload, undefined, { awaitResponse: true });
} catch (err) {
  if (err.code === 'ERR_POOL_WORKER_TERMINATED') {
    // The work was accepted and is now lost with its worker.
  }
}
```

This is reachable without the caller doing anything, because a worker can be
retired by `resize()`, idle reaping (`idleTimeout`), autoscale shrinking the
fleet, or `stopThePress()`.

Also in this release:

- `PowerPoolShutdownError` now carries `code === 'ERR_POOL_TERMINATED'`, matching
  the synchronous throw from a dispatch method on a shut-down pool. It previously
  had no `code`, so a caller following the `switch (err.code)` pattern in
  `guides/errors.md` fell through to `default` for the case most likely to be
  hit — shutting down while promises are outstanding. `err.name` is unchanged.
- `new PowerPool(Worker, null)` no longer throws
  `TypeError: Cannot read properties of null (reading 'size')`. The options
  guard already exempted `null`, but the option destructuring ran before it.

#### Cache, chunking and guides

Acts on three deferred items, and records a measurement that did not survive.

**DEFER-002 — `PowerChunker` no longer defers chunks through a timer.**
`PowerChunking` is not a fallback path; it builds inline workers in every
environment, so the scheduler behind it runs on every batch. It still yields —
`setImmediate` is a macrotask, and a microtask would starve the event loop, which
is why the item was deferred in the first place. It drains FIFO, so chunk order
is preserved.

Node clamps a zero timer delay to 1 ms, which makes the choice look enormous in
isolation: `setTimeout(fn, 0)` costs 1057 µs per turn against `setImmediate`'s
1.74 µs. **That 608× does not survive contact with the real workload.**
`PowerChunker` posts every chunk as a batch, so the timers all expire together
and fire in one pass — the 1 ms floor is paid once per batch, not once per
chunk. End to end, 2000 items, median of three:

| `poolSize` | `setTimeout(fn, 0)` | `setImmediate(fn)` |
| ---------: | ------------------: | -----------------: |
|          1 |              1.5 ms |             0.8 ms |
|          4 |              0.8 ms |             0.9 ms |
|          8 |              0.7 ms |             0.8 ms |

Within noise. The change is kept for intent rather than speed: `setImmediate` is
the primitive that means "run this soon without waiting for a timer", and it drops
a Node timer dependency. **A timing assertion was written for it, passed, and was
deleted rather than loosened — because it also passed with the fix reverted.** A
timing test that cannot fail on the regression it names is decoration. The four
tests that remain pin what a faster scheduler is most likely to lose: the work is
deferred rather than synchronous, every item is processed once, order is
preserved, and `drain()`'s summary is unchanged.

**DEFER-003 — `hasEqual`'s prototype strictness is now documented.** A class
instance and a plain object with identical own properties compare `false`; two
instances of the same class compare `true`. Verified before writing it down.
`guides/powerCache.md` now shows the case with a worked example, says why it is
deliberate, and points at `compareFn`. The decision is unchanged — only the
documentation that was missing.

**DEFER-004 — `hasEqual` is now documented as not counting as a use.** The row
recorded the decision as "documented"; the _behaviour_ was not, which is what a
user meets. A scan of `hasEqual` calls evicts a working set under a small cache,
and the guide never said so. It now does, alongside `peek`, with the reason: an
equality check is usually not "recent use", and treating it as one would let a
lookup pattern reshape the eviction order.

**DEAD-003 is closed as will-not-do.** `docs/` must be tracked — the project
website links into it — so untracking it would take the site down with nothing to
replace it. A previous session reached the same conclusion by doing it and
reverting. The 1.7 MB of generated typedoc is the price of a working
documentation site, and any future proposal should carry the replacement host and
pipeline before it touches `.gitignore`.

Fixes an unreachable guard that let an async worker factory through.

`WorkerAgnostic`'s check for an `async` worker factory sat inside a
`typeof result === 'string'` branch — a branch a Promise can never satisfy,
since `typeof` reports a thenable as `'object'`. The guard never ran.

The visible symptom was a failure several frames from the mistake: an async
factory produced a Promise in place of a worker, and the error the caller saw
was `postMessage is not a function`, pointing at the wrapper rather than at the
factory that caused it.

```js
// Before: silently produced a Promise as its "worker".
new WorkerAgnostic(async () => new Worker('./w.js'));

// After:
new WorkerAgnostic(async () => new Worker('./w.js'));
// TypeError: WorkerAgnostic: an async worker factory was passed. Construct the
// worker synchronously, or await the factory yourself and pass the instance.
```

The check is now a thenable test at the top of the coercion, so it also covers
a hand-rolled thenable rather than only a real Promise.

Also adds `test/WorkerAgnostic.pureEsm.test.js`, which verifies the pure-ESM
`preloadNode()` contract for the first time. Those code paths run only when
`require` is genuinely absent, which vitest never produces — so the behaviour is
tested by importing the real module in a real `node --input-type=module`
subprocess and asserting the documented error, post-preload success, and
idempotency. The troubleshooting guide described that failure on the strength
of reasoning alone; it is now evidence.

Adds an injectable clock to `PowerCache`, completing the family.

`PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerRateLimit` and
`PowerTTLMap` have taken a `now` option since 2.0. `PowerCache` was the last
one without it, and it is the helper where it mattered most: TTL expiry is the
only behaviour it has that cannot be observed synchronously, so testing it
meant a sleep — a guess in both directions, since too short asserts on a live
entry and too long taxes every run.

```js
let clock = 0;
const cache = new PowerCache({ defaultTTL: 100, now: () => clock });
cache.set('k', 'v');
clock = 100;
cache.get('k'); // 'v'  — alive AT its TTL
clock = 102;
cache.get('k'); // undefined
```

`now` is declared in `PowerCacheOptions`, so a typo is a type error. Existing
callers are unaffected: the default is `nowMs()` exactly as before.

The change is one binding in the constructor and `nowMs()` → `this._now()` at
seven read sites. One of those is on the read path and is conditional
(`!ignoreExpiry && node.expiresAt ? this._now() : 0`), so an entry with no TTL
still reads the clock zero times — a property the cache had before this and
still has.

The two sleeps in `test/powerCache.getorset.test.js` that let a 1 ms TTL lapse
are now exact, which is the point: they asserted "not yet", a condition
`vi.waitFor` cannot poll for, so a sleep was the only tool available and a
guess was the only option it offered.

Ten constructors now publish a real options type instead of a bare `Object`.

`PowerDeadline`, `PowerPermitGate`, `PowerBackpressure`, `PowerHistogram`,
`PowerScheduler`, `PowerSubscriberSet`, `PowerTTLMap`, `PowerRateLimit`,
`PowerMemoizer`/`PowerTimedCache` and `WorkerAgnostic` were typed as
`@param {Object} [options]`, so the published `.d.ts` checked nothing about what
you passed. They now accept named options types, and two errors surface:

- `PowerScheduler`'s options type omitted `scheduling: 'yield'`, which the
  constructor has always accepted. It is now declared.
- `PowerRateLimit`'s limiter parameter was emitted as a structural blob with
  every member and its comment repeated twice; it is now the named
  `RateLimiterLike`, and that type gained the optional `reset()` member the
  composer's `reset()` calls.

If you were passing an option these helpers do not read — `timeout` on
`PowerDeadline`, for instance, which bounds with `attemptTimeout` and
`totalTimeout` — that call is now a compile error. Nothing that worked
correctly changes: the new types only reject options that were being silently
ignored.

#### Fixes and smaller work

Fixes `new PowerPool(Worker, null)` throwing an error about an internal field.

The constructor's options guard explicitly exempts `null`
(`arguments[1] != null`), but the option destructuring runs before it, and a
default parameter only covers `undefined`. Passing `null` therefore reached the
destructuring and threw:

```
TypeError: Cannot read properties of null (reading 'size')
```

which names an internal field rather than the argument the caller got wrong,
and the guard written to allow the case never got the chance to run. `null` is
now normalised to `{}` before the destructuring, so the guard means what it
says. Omitting the argument, or passing an object, is unchanged.

Fixes every link in the documentation site's navigation, and adds two design
decision records.

`assets/navigation.md` is the VuePress navigation page, and every one of its
links was written relative to the repository root while the file itself lives
in `assets/` — so none of them resolved. The review had recorded exactly one of
them as broken on the assumption that only that one was wrong; there were
eleven.

The tell was that the neighbouring pages got it right: `assets/1_Caching.md`
links with `../guides/powerCache.md`. One directory, two conventions.

All links are fixed, and `test/docsLinks.test.js` now checks every relative
markdown link in the repository (53 files) against the file that contains it,
failing with the offending path rather than a count. It reports the specific
mistake:

```
"LICENSE.md (resolves from the repo root, not from assets/navigation.md)"
```

The existing assertion in `test/index.test.js` that navigation reaches each
index had to change: it matched the _literal string_ `assets/1_Caching.md`,
which is the broken form. A working link from inside `assets/` reads
`1_Caching.md`, so the test was passing on the exact bug it appeared to guard.

Also adds `adr/`, two architecture decision records:

- **0001** — why every pool message crosses the wire in a
  `[version][codec][length][payload]` envelope rather than NDJSON or bare
  structured clone.
- **0002** — why `PowerQueue` is a power-of-two ring buffer with bitmask
  indexing, including the measurement that killed the proposed
  `toArray()`-based "optimisation" in `PERF-006` (563 µs against 14.8 ns).

These live at the repository root rather than in `guides/` because a decision
record is the reasoning as it stood at a point in time, and reading one as
current guidance misleads. They are not in `package.json`'s `files`, so none of
it reaches an installing user.

Documentation only. No API change.

Corrects a documented `postMessage` call that does not work.

`guides/errors.md` showed the pool's Promise API as
`postMessage(msg, { awaitResponse: true })`. `options` is the **third**
parameter, after `transfer`, so the object landed in the transfer slot. With a
plain-object message the pool never inspects the transfer list, so
`awaitResponse` was silently dropped and the call returned `true` instead of a
Promise — a caller awaiting a worker response got a boolean and no diagnostic.
With a typed array the same mistake threw `TypeError: tr is not iterable`.

The guide now shows the three-argument form and explains why the shorthand
fails. No behaviour changes.

Documents what the `drop-oldest` queue policy actually does.

`guides/powerPool.md` said the policy "evicts one and admits one, so the queue
holds a steady number" without saying which number. It is one: the pool evicts
whenever the queue is non-empty, not only when the queue is at the cap, so
`maxQueueLength` does not raise it. A reader who set `maxQueueLength: 100` with
`queuePolicy: 'drop-oldest'` and observed a queue of length 1 had no way to tell
whether that was intended.

The behaviour is unchanged and was already deliberate — BUG-016 found the
self-bounding and accepted it, and it is what keeps this policy from refusing
work the way `'enqueue'` does at the cap. The guide now states the number, and
says what to use instead if you want a bounded backlog that fills before it
starts dropping.

Documents W3C trace propagation through `PowerPool`, and why it needs nothing
from the library.

`guides/traceContext.md` gives the recipe — a `traceparent` in the payload, the
worker echoes it, `als.run` per message on the worker side so nothing has to be
threaded through your own signatures — and the test that proves it
(`test/traceContext.test.js`).

The row this came from asked for trace propagation _in_ `PowerPool`. The reframe
is the finding: the pool already round-trips a field the caller names —
`correlationId` — and touches nothing else in a payload. A trace rides that same
path with no pool change, no option and no version.

The obvious alternative, a metadata channel in the frame, would break every
hand-written worker. The frame is a 6-byte header at protocol version 1, and
workers read those bytes directly; `examples/lib/worker.mjs` and every user's
worker included. Growing a per-message metadata concept into the pool also
moves toward the failure [adr/0001](../adr/0001-versioned-envelope-protocol.md)
was written to prevent: the 1.x decoder guessed at message content and misparsed
a payload that was valid as two different things.

Documentation only. No API change.

Adds a performance-regression guard that is not a timing gate.

The plan called for a ±20 % wall-clock check on `PowerCache.get` and
`PowerThrottle.tryConsume`. That is not implementable here, and the reason is
measured: BENCH-001 recorded a **28.71 % median min/max spread** across 22
timed variants (p95 113 %) on this machine. A ±20 % gate against that fails on
a clean tree and passes on a real regression about as often as not, and a gate
that cries wolf gets deleted after its first false alarm. More repeats do not
help — the spread is dominated by sub-millisecond variants, where timer
resolution is a large fraction of the measurement.

`test/invariants.test.js` therefore guards the thing the item was aimed at —
accidental _algorithmic_ regressions — using the library's own operation
counters, which are integers and do not move with machine speed:

- `PowerCache` reads are pure: a miss evicts nothing, a set on a full cache
  evicts exactly one, a cap is exact, and the evictions account for the
  difference. An oversized value is rejected _without_ evicting on its behalf.
- `PowerThrottle` admits exactly `capacity`, and refills proportionally with a
  fractional carry rather than crediting whole intervals.
- `PowerGCRA` admits `burst + 1` — `burst` is additional tolerance, not a
  total.
- `PowerBatch` splits on exactly `maxSize`, delivers every item exactly once,
  and preserves order within and across batches.
- `PowerQueue` preserves FIFO under interleaved push and shift, and grows by
  doubling.
- `PowerPool` holds its queue cap, accepts exactly `maxQueueLength` under the
  `enqueue` policy, and its task accounting returns to zero.

Verified to have teeth by mutating the source twice: replacing
`newCap = oldCap << 1` with `oldCap + 2` fails the growth progression, and
making a cache miss bump `_evictions` fails both read-purity tests.

**What this does not catch: a constant-factor slowdown.** If `cache.get` became
30 % slower per call, every assertion here still passes. That needs a timing
gate with a per-machine baseline and a threshold set from a measured p95, which
is the remaining part of the item.

Tests only. No behaviour change.

Adds runnable examples, one per helper family.

`examples/` contains nine short scripts — cache, ratelimit, resilience, pool,
batch, backpressure, observability, realtime, codec — plus a runner:

```sh
npm run example              # list them
npm run example cache        # run one
npm run example -- --all     # run every one
```

They are executed by `test/examples.test.js` on every `npm test`, so they
cannot drift from the API. This is the point: every example in the directory
was wrong the first time it ran, and none of the mistakes were visible by
reading the code. Three library traps are now documented where a reader meets
them:

- A Node ESM worker silently ignores `self.onmessage` — and
  `globalThis.onmessage`. Nothing throws; the handler is simply never called
  and every reply times out. Use `parentPort`.
- `PowerPool` accepts a worker factory or a string, not a `URL` object, while
  Node's `Worker` rejects a `file://` string. Only an absolute path satisfies
  both.
- With `batch: true` (the default) `PowerRealtimeHub` delivers **an array** of
  messages per frame. A client expecting one message per frame reads
  `undefined` from every field, which looks like a slow-consumer problem and
  is not one.

One deliberate behaviour worth knowing, which the examples show rather than
hide: the library `unref()`s its timers, so neither `PowerBackpressure`'s
refill nor `PowerRealtimeHub`'s flush will hold a Node process open. That is
right for a library — a rate limiter should not keep a finished CLI alive — but
it means a script whose only remaining work is a pending refill will exit
instead of waiting.

Documentation only. No API change.

De-flakes the two test files with the most fixed sleeps, and fixes a
`review.md` structural problem.

**`test/powerPool.test.js`** — 9 fixed sleeps → `vi.waitFor`, 0 remaining.
**`test/powerScheduler.yield.test.js`** — 7 → 4.

`vi.useFakeTimers()` is the wrong tool for most of these. `vi.waitFor` is
correct for "wait until X happened": it polls the condition and returns the
moment it holds, where a fixed sleep guesses in both directions. Fake timers
are correct only for "assert nothing fires within N ms".

The 4 that remain in the yield file are not convertible, and the reason is
specific: `scheduler.yield()` returns a promise with **no handle to detach**,
so there is nothing for `advanceTimersByTime` to reach. Those tests assert the
flush _never_ runs, which `vi.waitFor` cannot express — its condition is
already true before it starts, so it would pass **vacuously**. The file header
now says so, to stop the conversion being made and the evidence deleted.

Suite-wide fixed waits: 62 → 52.

**`examples/observability.mjs` was flaky** — it blocked the event loop for
40 ms and asserted the monitor saw a 35 ms stall, failing about one run in five.
A 5 ms sampler can only observe the gap between two of its own ticks, so it
under-reports. Now blocks for 100 ms and asserts 40. `test/examples.test.js`,
the CI check added in 2.0.0, caught it.

**`review.md`**: seven rows had a notes column split by a literal `|`, which
silently drops a column while the row still renders. `test/reviewTable.test.js`
now checks the column count and the trailing pipe, with teeth verified by
deliberately adding one. A second, unfixed problem is recorded in the file
itself: the rows disagree with the table's own header about what a column
holds, which needs a human pass rather than a script.

Adds an injectable clock to `PowerTTLMap`, completing the set.

`PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow` and `PowerRateLimit` have
accepted a `now` option since 2.0 (PERF-007). `PowerTTLMap` did not, and it is
the one helper where that matters most: expiry is the only behaviour it has
that cannot be observed synchronously, so testing it meant either sleeping and
racing the clock, or dropping the test.

```js
let clock = 0;
const m = new PowerTTLMap({ defaultTTL: 100, now: () => clock });
m.set('k', 1);
clock = 100;
m.get('k'); // 1  — alive AT its TTL
clock = 102;
m.get('k'); // undefined
```

That second boundary is the useful part, and it is a deliberate off-by-one: an
entry is stored as `expiresAt = now + ttl + 1` and read back as
`now > expiresAt`, so it survives exactly at its TTL and lapses immediately
after. `test/invariants.test.js` now pins all three positions, so a later
"simplification" of that `+ 1` fails loudly instead of quietly shortening every
entry by a millisecond.

Five invariants are restored that had to be dropped earlier precisely because
the helper had no clock — they would have needed a wall clock, which is the
flake TEST-008 exists to remove. That is now recorded as done in the plan.

Documentation only beyond the new option; no behaviour changes for existing
callers.

#### The four regression tests the plan named, and two of them were decoration

TEST-003 listed nine missing tests. One already existed, two were written
earlier in this release, and the remaining four are added here — each in the file
that owns the unit, and each a counter or a shape rather than a duration.

**The round-trip item named the wrong function.** `prepareBuffers` deliberately
returns an **unframed** body with `deferred: true`; framing is
`_dispatchToWorker`'s job, per POOL-001. So
`decodeMessage(prepareBuffers(…).message)` cannot work by design — the first
version did exactly that, and the codec correctly rejected a plain object with
"expected a Uint8Array, ArrayBuffer or DataView".

The round trip is therefore measured on what reaches the **worker**, and it
asserts the decoded **value**, which is the property the existing framing test
did not have:

```js
const decoded = decodeMessage(bytesOf(entry), { codec: 'framed' });
expect(decoded.value).toEqual(values[i]); // not just "it decoded"
```

The existing test only checked that the frame _decodes_, so a framing change
could ship a perfectly valid envelope carrying the wrong payload and every
assertion would pass. Primitives are not framed at all, so the values are objects
and arrays, plus an 8 KB payload that crosses the length-prefix path.

**Three of the four are characterisations of still-open rows** — PERF-003,
CACHE-006, RT-007 — and that distinction matters, because they are not passing
tests for those optimisations. They are the instruments those rows need, and each
pins the number as measured so that the fix landing is a visible flip:

| counter                                                 | measured | the row's target |
| ------------------------------------------------------- | -------: | ---------------- |
| `getOrSet` `nowMs()` reads per call                     |        2 | 1 (PERF-003)     |
| `_windowOldest()` on a main-space `get()` under tinylfu |        1 | 0 (CACHE-006)    |
| `_windowOldest()` per evicting insert                   |     ~2.2 | 0 (CACHE-006)    |
| per-subscriber `inFlight` maximum                       | observed | 1 (RT-007)       |

**Two of them were decoration, and mutation said so.** The `_windowOldest` counter
asserted `toBeGreaterThanOrEqual(0)` and the `getOrSet` counter
`toBeGreaterThanOrEqual(1)`; both accept every value, which is decoration by this
repository's own rule rather than a measurement. Pinning them to the measured
numbers is what makes them tests — `getOrSet` reads the clock twice per call,
exactly as PERF-003 states.

The window counter also measured the wrong thing twice over. It first pinned 0 on
a main-space `get()` and appeared to clear CACHE-006's premise — but the
measurement omitted `admission: 'tinylfu'`, and the walk on that path comes from
`_arbitrateWindow`, which only runs when the filter is enabled. Under tinylfu the
count is 1, so the row's premise holds. Both configurations are now pinned,
because the difference between them is the finding.

One mutation remains uncaught and is stated rather than hidden: replacing the
insert-path walk with `this._tail` leaves enough other walks to satisfy the "at
least one walk per evicting insert" bound, so that bound is deliberately loose.

The `inFlight` test cost three guessed shapes before it was right. `subscribe`
returns an **unsubscribe function, not the subscriber**, so the counter is only
reachable from inside the `send` adapter, which is handed it. It also learned that
`flush()` does **not** await in-flight sends, so reading `inFlight` immediately
after it gives 1 and not 0 — the counter being live, not a bug.

Closes TEST-003.

#### A timing assertion that could not fail, replaced with one that measures work

`test/powerCache.hasEqual.budget.test.js` asserted `expect(ms).toBeLessThan(200)`
on a 50 000-wide deep comparison. It was decoration: the file's own comment
records the unbudgeted cost as "tens of milliseconds", well inside 200, so the
bound held whether or not the width budget existed. **Mutation confirmed it** —
reinstating the clock bound alongside the fix leaves every test green.

Deleted rather than widened, and replaced with a **node count**, which is what
the budget actually is. `hasEqual` accepts a `compareFn` that is consulted per
node compared, so counting its calls measures the work directly:

```js
const r = cache.hasEqual(key, value, {
  compareFn: () => {
    compared += 1;
  },
});
expect(compared).toBeLessThan(2 * WIDE); // unbudgeted this is 2 × WIDE
```

The number is exact on any machine — no spread, no threshold, nothing to flake —
and it fails when the budget is removed. A second test pins the knob: `maxNodes`
_is_ the budget, so a larger one compares strictly more and neither exceeds its
own ceiling.

Three mutations caught: the node budget removed, the `maxNodes` option ignored,
and `compareFn` never consulted.

Getting there took three attempts, each of which passed while measuring nothing.
The first used the test's original **scalar** array and counted **1** — a flat
array of scalars takes a fast path that never reaches `compareFn` (measured: 1
call for a 2 000-wide scalar array, against 2 001 for the same width of objects).
The second used `wide.slice()`, which reuses the same object references, so every
element hit reference equality and both budgets counted 1. A counter that counts
nothing is worse than no counter, because it looks like coverage.

Closes TEST-001.

#### A batched post that failed was a `false` in an array and nothing else

`postMessageBatch` answers with a per-item boolean. Three sites can set one to
`false`, and **two of them caught the error and discarded it** — no log, no
`pool:error` event, no counter. The third already logged and emitted, which is
what made the omission visible rather than a matter of opinion.

The consequence is a caller who cannot tell a dispatch failure from a busy
worker, and an operator with no signal that a batch silently lost items. A batch
is where this matters most: one `postMessage` failing is a `false` the caller can
check, but a batch of a thousand returns an array with a handful of quietly-wrong
entries.

All three sites now route through one helper that counts, logs and emits:

```js
this._bus.emit('pool:error', { phase: 'postMessageBatch', error: err, scope });
this._logger.error(err, `${scope}: failed to post`);
// and getStats().postFailures
```

The per-item boolean contract is unchanged. The count is what makes a drop
_countable_ rather than only visible in a log.

Every step is individually guarded, and that is not defensiveness for its own
sake: this runs **inside a `catch`**, so a logger or bus that throws would replace
the original failure with its own and the item would be neither sent nor
reported. A mutation that removes a guard fails the test that pins it.

`test/powerPool.postFailures.test.js`, 6 tests, four mutations caught. They
assert a count, an event carrying the `Error` rather than a bare flag, a log
call, that only the _failed_ items are counted rather than the whole batch, that a
clean batch reports and counts nothing, and that a throwing logger does not
swallow the report.

Closes POOL-005.

#### A batched dispatch read the clock once per item

`_dispatchToWorker` takes `startTime` as a **default parameter**:

```js
const { correlationId, startTime = nowMs() } = options;
```

Every call that omits it pays a clock read — and `postMessageBatch`'s loops call
it per item, so a batch of N cost **N** syscalls to stamp N tasks that all
dispatch at the same moment.

`postMessage` and `broadcast` already hoisted their reads, and both say why in a
comment ("capture a single timestamp for this dispatch to avoid multiple
syscalls"). The batch was the one path not given the same treatment, so this is a
consistency fix rather than a new idea: one read at the top of the method, passed
to all four dispatch sites. `startTime` feeds `_startTimes` and `lastActive`,
which is what `getStats().performance.timePerTask` reads, and a batch dispatches
its items at the same moment — so one read is accurate to within the batch's own
duration rather than wrong.

**Asserted with a count, not a clock** — the instrument TEST-001 established.
Timing a `nowMs()` call would be measuring the thing being removed, and at the
harness's ~28% median spread a duration could not separate one read from N:

```js
pool.postMessageBatch(Array.from({ length: 50 }, (_, i) => ({ message: { i } })));
expect(reads()).toBe(1); // was 50
expect(worker.posted).toHaveLength(50); // and nothing was skipped
```

**The runtime test only reached the single-worker fast path.** Dropping
`startTime` from the _fallback_ site left every test green, because that branch is
never taken under `size: 1` with `maxTasksPerWorker: Infinity` — so three of the
four sites I changed were unverified. Reaching the multi-worker branches needs a
saturated pool, a grow and a fallback, which is a lot of arrangement to assert
one argument. So the file has a second instrument: a **static** check over the
method body that every dispatch passes the hoisted stamp and that the hoist
precedes the first loop. That is the same trap as a test that cannot fail,
reached a different way.

Closes POOL-006.

#### A circuit breaker went `open → closed` for every observer, with nothing in between

`PowerCircuit`'s `state` getter computes `'half-open'` **logically**: when
`_state` is `'open'` and the drawn window has elapsed, the getter returns
`'half-open'` without mutating anything. That lazy design is right — an eager
transition needs a timer, which is a wakeup and a handle to leak.

But `_setState` was the _only_ thing that notified `onStateChange` or emitted
`stateChange`, and the getter does not go through it. So the transition was
reported to anyone who read `state` while telling nobody, and a breaker whose
trial then succeeded went `open → closed` for every observer with nothing in
between. Any dashboard built on the bus was wrong.

The announcement is now made from the getter, once per outage:

```js
if (nowMs() - this._openedAt >= this._openWindowMs) {
  if (!this._halfOpenAnnounced) {
    this._halfOpenAnnounced = true;
    this._notifyState('half-open', 'timeoutElapsed');
  }
  return 'half-open';
}
```

Reading `state` is what a dashboard does to notice, so the observer that polls is
the one that gets told, and a reader that only ever looks at `_state` — as the
request path does — never pays for it. The once-flag matters: without it, a
dashboard polling every second would report a state change every second.

**The bus emit is now guarded where `_setState` did not guard it.** This runs
inside a getter, so a throwing event bus would make reading `state` throw — a far
worse failure than a missed notification. The old code only got away with it
because nothing ran during a read.

`test/powerCircuit.halfOpen.test.js`, 7 tests, four mutations caught. The
instructive one: replacing the announcement with `_setState('half-open', …)` —
i.e. making the fix eager — passes every announcement assertion and would have
quietly changed the trial path's timing. It is pinned by asserting `_state` is
still `'open'` and `_consecutiveOpens` is untouched after the logical half-open is
read.

Closes RES-025.

#### `PowerBatch` silently rewrote the scheduling strategy it was asked for

The constructor read:

```js
scheduling: scheduling === 'macrotask' ? 'macrotask' : 'microtask';
```

Two failures, both quiet. **A typo became the fastest strategy** — `'typo'`,
`'macro'`, `'MACROTASK'` all landed on `'microtask'`, defeating the explicit throw
`PowerScheduler` performs for exactly that case, whose own comment reads "a typo
would otherwise silently pick the _fastest_ strategy for a scheduler that was asked
for something else". And **`'yield'` was lost entirely**, in runtime _and_ in
types: the JSDoc typedef listed only `'microtask'|'macrotask'`, so the strategy
`PowerScheduler` supports and prioritises was unreachable through this class.

`scheduling` is now passed straight through. The default is applied in
`PowerBatch`'s own destructuring, so the no-option path is unchanged, and a caller
who asked for something specific now gets it — or a `TypeError` naming what is
valid. The typedef, the guide's option table and the tests all carry all three
strategies.

`onError` is forwarded too, as a pass-through rather than something handled here:
`PowerScheduler._run` already normalises the flush result to a promise and funnels
both a synchronous throw and an async rejection into `_notifyError`.

`test/powerBatch.scheduling.test.js`, 7 tests, three mutations caught — including
a _partial_ coercion that keeps `'yield'` but still drops typos, which only the
typo assertion catches. The tests observe the argument a real `PowerScheduler`
subclass receives, so nothing about scheduling's behaviour is faked.

**The `onError` half is a safety net rather than a fix for an observed failure,
and that was measured.** `_runBatch`'s `else throw err` needs `_pending` to be
null while the queue is non-empty, and every `add()` creates a pending, so that
branch looks unreachable through the public API. My first end-to-end test asserted
`onError` was called, failed with 0 calls and an unhandled rejection, and was wrong
about the premise rather than about the fix. What is reachable — and now asserted —
is that a handler rejection always reaches a caller and is never lost.

Closes RES-033.

#### `eagerCleanupOnRead` documented a behaviour the code always had

**Removed.** The option promised that `peek()` and `has()` would "remove expired
nodes when observed", and did nothing — because `_fetchValidNode` already
removes them, unconditionally, on every read path. It unlinks, frees, counts
`_expirations` and fires `onExpire`, with no flag consulted.

Measured with an injected clock and both option values:

```
eagerCleanupOnRead=false | has: false | size 1->0 | expirations 0->1 | onExpire fired
eagerCleanupOnRead=true  | has: false | size 1->0 | expirations 0->1 | onExpire fired
```

Identical. So the option was removed rather than left inert, and **the guide was
the actual defect**: it claimed "the library currently defaults to non-mutating
read behavior (expired entries remain until cleanup)", which was false. A reader
who believed it would be surprised to find `onExpire` firing from a `has()`.

The alternative was implementing the option by _inverting_ the current behaviour
to match the docs — reads becoming non-mutating by default, on a hot path, and
`onExpire` no longer firing from reads. That is a real behaviour change, and the
code's behaviour is the one with a helper written to produce it, so the code is
right and the prose was not.

The guide is corrected in five places: the options table, two method
descriptions, a worked example, and the note about the default. The historical
paragraph naming the removed option is kept on purpose — this project records
withdrawn claims.

**Breaking:** a caller already passing `eagerCleanupOnRead: true` now has the
option ignored, which is a no-op because the behaviour was unconditional. The
property is gone from the published `types/`.

`test/powerCache.eagerExpiry.test.js`, 6 tests on an injected clock, so nothing
sleeps: each read path removes the node and fires `onExpire`, the option is absent
from the instance, a live entry is still not removed, and `ignoreExpiry` still
reports an expired entry as present. Three mutations caught — and the first is
worth noting: making `_fetchValidNode` stop removing on expiry, **which is what
the guide described**, fails 2 of 6. The wrong documentation was itself pinned by
these tests before this commit.

Closes CACHE-008.

#### A hub could send two frames to one subscriber at once

`PowerRealtimeHub`'s `_drain` and `_flushAll` iterated every subscriber and sent
whenever the queue was non-empty, **without consulting `sub.inFlight`**. A
subscriber with a send still awaiting the transport therefore received a _second_
frame, and the two could reach it in either order — while `stats().list` reported
an `inFlight` number that gated nothing.

Measured before, with a transport that settles on a timer:

```
max inFlight: 2+      send trace: start start …
max inFlight: 1       send trace: start end start end …
```

The two drain paths needed **different** fixes, and that is the substance:

- `_drain` can skip a busy subscriber outright, because `_flushSubscriber`'s own
  completion already re-drains when work arrived meanwhile.
- `_flushAll` **cannot**. `flush()` promises "resolves once all subscribers have
  been drained", and the guide says `batch: false` is for "transports that cannot
  take several frames at once" — so skipping a busy subscriber would resolve with
  that subscriber's queue undelivered, precisely the case the option exists to
  serve. So `flush()` now _waits the outstanding send out_ instead.

That required the in-flight chain to be **returned** from the completion rather
than fired and forgotten, so a single await covers the send _and_ the follow-up
flush that send chained.

`test/powerRealtimeHub.inFlight.test.js`, 8 tests. Worth recording: **the first
version of that file proved nothing and mutation said so** — all three mutations
survived. Every test used `batch: false`, where automatic flushing is disabled and
the caller drives everything through `flush()`, so `_drain` — one of the two paths
the row names — was never executed, and deleting its gate entirely left 6 of 6
green. Two arrangement errors followed, each found by a mutation rather than by
reading: the flag was inverted (`batch: !auto` turned batching _on_ for the tests
that meant it off, because `this._batch = batch !== false`), and publishing five
messages in one turn schedules only **one** drain, so nothing was ever in flight
when the gate was consulted. The tests now publish, let the drain run, and publish
again.

The TEST-003 characterisation written for this row as instrumentation was
**tightened from `toBeGreaterThanOrEqual(1)` to `toBe(1)`** — it is now the
assertion.

One mutation is not caught and is left recorded: reverting the chain to
fire-and-forget passes, because the drain loop's own `inFlight` check tolerates a
stale chain. The only difference is a busy-wait rather than a proper await, which no
public assertion can distinguish.

Closes RT-007.

#### Four documented options that were not doing what they said

RES-017 grouped four as "inert or contradictory". Measured, they are **three
different defects** — and only two of them were dead options.

**`PowerThrottle.refillInterval` — removed.** Destructured, validated, typed,
published, never read. It is also unimplementable as documented: the bucket
refills lazily and _proportionally_ to elapsed time on every read, so a token is
earned every `1000 / refillRate` ms whether or not anything observes it. There is
no interval in the design to configure, and honouring one would mean a timer and
a strictly worse model to express the same arithmetic. Removed rather than left
inert, since an inert field lets a caller set it and believe it did something.

**`PowerGCRA.onError` — now called.** Documented for a backwards clock and never
invoked. But the clamp it describes was already there — `Math.max(now, this._tat)`
— so the _safety_ half of the promise held while the _observable_ half did not: a
limiter running on a clock that jumped clamped silently. It is now called with the
offending reading, and the clamp is what keeps it non-throwing as documented. The
call is individually guarded, because it runs inside `tryConsume` and a throwing
handler would replace a rate-limit decision with an exception.

**`PowerRetryOptions.attemptTimeout` — the documentation was wrong.** The
published type said a timed-out attempt is "**not** retried … retrying would
multiply it by `maxAttempts`". Measured with `attemptTimeout: 40` and
`maxAttempts: 3`: **three attempts**, ~328 ms. The doc promised a guarantee the
code does not make, in the direction that misleads a caller choosing a bound. It
now says a timeout is retried like any other failure, and points at `totalTimeout`
for a hard per-call bound.

**`PowerCron._fireCount` — also mis-documented.** The counter is real and read by
two getters; its _doc_ claimed it counts catch-up replays of periods missed while
stopped, which `start()` cannot produce — it sets `_nextAt = now + intervalMs`, so
a restart begins a fresh cadence. That is the right behaviour for a cron, since
replaying a backlog after a deploy would stamp a dozen tasks at once.

Two rows were dead options; two were documentation promising behaviour the code
never had. Same class as `eagerCleanupOnRead`, in the other direction.

`test/deadOptions.family.test.js`, 9 tests, three mutations caught. **One is not**:
removing the pre-existing `Math.max(now, this._tat)` clamp passes 9 of 9. That
clamp is the safety half of the `onError` promise and this change did not touch
it; pinning it needs a test of the _forward_ idle path that was not written, so it
is not claimed to be verified.

Closes RES-017.

#### `maxConcurrency` measured: it is a per-partition ceiling, and nothing is missing

GATE-018 recorded an observation with no conclusion — `maxConcurrency: 2` with
several concurrent `tryRun`s reported `active: 4` — and said explicitly that
whether that was a defect or whether the option meant something other than the
name said was not established.

Measured, per partition, with `tryRun`:

| partitions | maxConcurrency | submitted | accepted | `active` |
| ---------: | -------------: | --------: | -------: | -------: |
|          1 |              2 |         6 |        2 |        2 |
|          2 |              2 |         8 |        4 |        4 |
|          4 |              2 |        12 |        8 |        8 |

So the global ceiling is `maxConcurrency × partitions` and `active` counts
in-flight tasks across the whole bulkhead. The original observation was two or
three concurrent `tryRun`s spread across partitions — correct behaviour read as a
missing comparison. `guides/powerBulkhead.md` already says "Maximum concurrent
tasks allowed **per partition**" in both the option table and the bullet list, so
code, type and documentation agree.

The `run()` direction, which does queue, is `maxConcurrency + queueCapacity` per
partition:

| partitions | queueCapacity | submitted | ran | refused | `pending` |
| ---------: | ------------: | --------: | --: | ------: | --------: |
|          1 |             2 |         6 |   4 |       2 |         2 |
|          1 |             9 |        12 |  11 |       1 |         9 |
|          2 |             2 |        10 |   8 |       2 |         4 |

And `isFull` is `true` once the **queues** fill, not at the concurrency ceiling —
at the ceiling with an empty queue it reads `false`. That is the other half of
why the original observation looked wrong.

`test/powerBulkhead.concurrency.test.js`, 4 tests, all counts and refusal
numbers with no durations; the tasks are released in explicit waves.

**One mutation survives, and it is a finding rather than a gap.** Disabling the
bulkhead's own queue-admission check passes 4 of 4, because each partition's
`PowerPermitGate` now carries the same `queueCapacity` and refuses first. That
became true earlier in this release, when the hard-coded
`queueCapacity: Infinity` was replaced with the real value — so the bulkhead's
check no longer makes the decision, it labels it with the error message callers
expect. A redundant guard, not dead code, and left in place deliberately.

A first mutation run reported all three as uncaught, and two had **not actually
applied**. Each was re-run with the mutation count printed: `maxConcurrency`
ignored fails 4 of 4, and partitions collapsed fails 3 of 4. A mutation that does
not take is not a test — the same lesson as the first `CACHE-010` attempt.

Closes GATE-018.

#### One orphan heartbeat timer per tick

The heartbeat armed a deadline for every ping, and the handle was cleared only
when a **pong** arrived. A socket that never answers therefore re-armed on every
tick and _overwrote_ the handle: one orphan timer per tick, none of them
clearable, and each firing later to increment `heartbeatTimeouts`, call
`_clearTimers()` and close the socket.

Measured before the fix — a socket whose `ping()` is never answered, three ticks:

```
deadlines armed: 3    cleared: 0
```

After:

```
deadlines armed: 1    live: 1
```

**The plan row's prescription was only half right, and the other half is the more
dangerous one.** "Clear the handle before re-arming" does remove the orphan, but
it also _resets the window_. The deadline measures from the ping, so clearing and
re-arming every tick means a socket that never answers **never times out at all**
whenever `heartbeatTimeoutMs` exceeds `heartbeatIntervalMs` — trading a spurious
close for a dead socket that reports itself alive. Two existing tests caught that
when the first version of the fix did exactly what the row said.

The deadline is now armed **once per live window** and left alone while one is
outstanding. The guard is on the _arm_ rather than being a clear-and-re-arm,
because a pong closes the window: the next tick must be able to start a fresh
one, and a healthy socket must still be timed out after its first pong.

Fixed in **both** transport files — the bug was duplicated, and so is the fix.

`test/heartbeat.deadline.test.js`, 5 tests, three mutations caught with anchor
counts printed: the adapter guard removed, the client guard removed, and the
row's literal prescription. The instrument is a **count of timer allocations
against releases**, the same one PERF-001 and POOL-006 use — counting is exact,
and a duration would be measuring the thing being removed.

Closes RT-008.

#### An abandoned `scheduler.yield()` continuation flushed the _next_ schedule early

The yield strategy has no cancellable handle — `scheduler.yield()` returns a
promise that resolves when the continuation is resumed, and it is already queued
by the time anyone could detach it. A continuation left over from a previous
`schedule()` therefore needs to be able to tell that it has been superseded.

The code carried a comment saying it could not, and it was wrong in one clause.
It read: _"`_run()` opens with `if (!this._scheduled) return`, and both `flush()`
and `cancel()` clear `_scheduled` before returning, so an abandoned continuation
finds the schedule already closed and does nothing"_ — and it called a generation
counter an **equivalent mutant**, because removing it left all seven yield-path
tests green.

**`flush()` does not clear `_scheduled` — `_run()` does, as a side effect of
_running_.** `cancel()` does clear it, so the reasoning was half right and reached
the wrong conclusion. After `schedule(); flush(); schedule()` the flag is true
again, and the abandoned continuation finds a _live_ schedule and runs it:

```
schedule(); flush(); schedule()     ->  1 flush, 2 continuations queued
resume the ABANDONED continuation  ->  2 flushes, _timer null
```

The newer schedule was flushed a whole window early, and its timer handle was
clobbered on the way past. The seven tests stayed green throughout because none of
them resumed an abandoned continuation.

The fix is one integer: a generation captured at the arm and compared on
resumption. The check has to be on the generation rather than the flag, precisely
because the later `schedule()` re-set the flag.

`test/powerScheduler.yieldGeneration.test.js`, 5 tests on flush counts and handle
shapes — the ordering is driven by resolving promises by hand, so no duration is
involved. Three mutations caught. It also pins that the _current_ continuation
still runs, since a guard that skipped every continuation would pass both the
no-early-flush and the no-clobber tests and break the scheduler.

Closes RES-006.

#### A batch the limiter could admit, and one it could never admit

`PowerGCRA` admitted a batch whose own span did not fit inside the delay
tolerance. `rate: 1, burst: 0`, `tryConsume(5)`:

```
before:  tryConsume(5)  ->  true    // 5 ops at 1/s, admitted at one instant
          retryAfter(1)  ->  5000   // ... and 5 s of debt
after:   tryConsume(5)  ->  false
          available()    ->  1      // the first op is free, burst 0 beyond it
          tryConsume()   ->  true
```

A batch of `n` spans `(n - 1)` emission intervals — the first operation is free,
each subsequent one is spaced a full interval — so the requirement is
`n <= burst + 1`, which is what `golang.org/x/time/rate` states as `n <= burst`.
It was nowhere in the condition.

**The sharper half is not about batches, and the row's premise was wrong in my
favour.** The plan said `available()` "already has the correct predicate". It did
not. Composed, the same batch was _already_ refused, because `PowerRateLimit`
pre-checks `available() < want` — so the direct call and the composition disagreed
about the same limiter, which is a better description of the defect than "a batch
bypasses burst". Chasing that down found the actual cause:

```js
Math.floor(delayTolerance / emissionInterval) + 1;
```

**That division does not round-trip.** At `rate: 3, burst: 7` the quotient reads
`6.999999999999999`, so a limiter covering 8 operations reported **7**. It is
pre-existing and has nothing to do with `n > 1`. Swept over `rate` 1-40 ×
`burst` 0-12 × `n` 1-16 with varied history: **255 configurations** where
`tryConsume(n)` admitted a batch that `available()` had just refused, because
`floor(remaining / emission) + 1` and `remaining >= (n - 1) * emission` are equal
in exact arithmetic and not in floating point. A composition holding a saturated
GCRA limiter turned down batches the limiter itself accepted.

So there is one computation now — `_covers` — reached by both `tryConsume` and
`available`, because as separate expressions the two cannot be kept bit-identical.
And the saturated case is answered from `burst` directly rather than by dividing
the tolerance back by the emission interval. Post-fix: 0, 0, 0.

**`retryAfter` was inexact from the same cause**, being a third spelling of "how
much tolerance is left". Swept, it reported `0` while the next `tryConsume` was
refused in **69** cases — which turns a retry loop into a spin at full speed,
because the caller reads `0` as "no wait needed" and is refused immediately — and
under-waited by ~1e-11 ms in others. It derives from the same `_remainingAt` now.

**And a claim of mine that measurement killed.** I assumed waiting always
eventually admits a batch, so `retryAfter` had only to be accurate. It does not.
A batch above `burst + 1` can _never_ be admitted at any wait, because the ceiling
comes from `burst` and not from the state of the TAT: **200 000 tries across four
configurations, one past the ceiling, zero admissions**. `retryAfter(5)` on
`burst: 3` was reporting a finite `100`, so a retry loop would wait, be refused,
and wait again forever.

Settled deliberately as a `RangeError`, against the two alternatives. Returning
the finite wait is the existing bug. Returning `Infinity` is honest about the
arithmetic and useless in practice — `setTimeout(retry, Infinity)` fires
immediately, so the loop spins instead of stalling, and a caller that clamps
`Infinity` to its own maximum wait turns a permanent refusal into a slow poll.
Throwing names the ceiling in the message and lands on the line the caller has to
edit. It is the advisory half of the pair, and advising a wait that cannot succeed
is a bug in the advice rather than a rate-limit decision to report; `take(n)`
propagates rather than inventing a wait.

**This is a new throw on a previously-returning path**, in the same release as
the `assertCount` `TypeError` below and the `EDISPOSED` rejection code. Callers
who pass a batch larger than `burst + 1` need to split it or raise `burst`; that
is the migration, and it is one line.

The `Math.max(now, this._tat)` clamp is de-duplicated to `_tatAt` as the row
asked, because inlining it three times is exactly how the batch check came to omit
its span: the clamping was shared and the predicate was not.

Six new tests plus two fast-check properties — admission ⟺ `available() >= n`, and
`retryAfter` exactness — 16 mutants, all caught. **One is caught by a single test
and is not claimed as well covered**: deleting the saturation branch fails 1,
which is a thin pin for a 255-configuration defect. The property test carries the
weight; the two together are the honest description.

Closes RES-012.

#### A request count the limiter could not price was admitted as zero work

Eight call sites across all four limiters coerced their count through
`Math.max(0, Math.floor(n) || 0)`. `Math.floor(NaN)` is `NaN`, `NaN || 0` is `0`,
and **`0` is the admit case** — so `throttle.tryConsume(NaN)` returned `true`
having consumed nothing, and `throttle.tokens` never moved.

Worse in the composition: `PowerRateLimit.tryConsume` ran its coercion _after_ a
`want === 0` early return, so `tryConsume(NaN)` returned `true` while **no
limiter in the composition was consulted at all**. A caller with three limiters
behind one composition would have believed it had admitted a request nothing saw.
The assertion now runs before the early return, and that ordering is the
load-bearing part rather than a detail.

`assertCount(value, { name, className, method })` in `utils/options.js`, used by
`PowerGCRA.tryConsume`/`retryAfter`, `PowerThrottle.tryConsume`/`reserve`/
`addTokens`, `PowerSlidingWindow.tryConsume` and
`PowerRateLimit.tryConsume`/`reserve`.

**It is deliberately not `assertLimit`, and the reason is the whole design.** The
two take opposite positions on a fractional value, because a fractional _limit_
and a fractional _count_ fail in opposite directions:

|                 | a fractional **limit**                    | a fractional **count**            |
| --------------- | ----------------------------------------- | --------------------------------- |
| `capacity: 2.5` | each consumer rounds **up** → over-issues | rounding **down** → under-charges |
| so              | must throw (RES-010)                      | floors safely, no throw           |

`capacity: 2.5` granted **three** concurrent permit holders and reported
`available: -0.5`; that is why `assertLimit` has an `integer` flag rather than a
blanket floor. A request count has no such hazard, so throwing there would be
strictness with no defect behind it. `0` and negative counts likewise stay the
documented no-op — refusing to admit nothing would be a behaviour change with no
defect behind it either.

**`addTokens` is in, `release()` is deliberately out**, and that asymmetry is the
one judgement call here. `addTokens(NaN)` was a silently empty refill — the same
defect on the capacity-_return_ path, and a caller using it to hand capacity back
gets a bucket that stayed empty. `release()` returns nothing for a count it cannot
read, and that is the **safe** direction: over-charging the caller costs one wait,
whereas admitting a request you cannot price removes the limit. Both are
documented at the helper and in each guide.

The `method` tag exists because a failure inside a composition otherwise reports
only "invalid", which is no more use than not having validated.

`test/limiterCounts.test.js`, 14 tests. They pin the **accepted** half as
deliberately as the throwing half — zero, negatives, `3.9`, `'3'` — because a
suite that only checked that `NaN` throws would pass against an implementation
rejecting everything it did not already understand. Mutation-checked: dropping
`assertCount` from `retryAfter` fails 1, from `tryConsume` 2, from
`PowerThrottle` 2, from `PowerSlidingWindow` 2, reverting it to the old coercion
8, and returning a constant `0` 19.

One existing test had to change with the fix, and it is the third this project
has found that **pinned a defect while explaining it**: `retryAfter reflects the
full cost of a multi-operation ask` asserted the old single-operation wait for
every `n`, with a comment justifying it — "a batch is admitted behind a _single_
admission check, so the wait is driven by the current TAT and does not grow with
`n`". That sentence was the bug, written down. The guide repeated it twice.

Closes RES-011.

#### The generated reference: a suspected 404 that was not, and a half-covered hook

Two carry-overs from the 2.0 sweep, one of which dissolved when it was measured.

**The suspected 404 was not a defect.** `typedoc.json` excludes
`src/helpers/jsdoc-types.js`, so no `docs/helpers/jsdoc-types/` page is generated,
and the concern was that external links into it would 404. Checked rather than
assumed: **179 generated markdown files, 878 relative links, zero dangling, and
zero mentions of `jsdoc-types` anywhere in `docs/`.** Typedoc omits the excluded
types rather than linking to a page that is not there, which is the correct
behaviour. No change made, because there is nothing to change. The 62 typedoc
warnings that mention those types are a different thing and are pre-existing: they
report that a _referenced_ type is not _included_, not that a link is broken.

**The hook gap was real.** `.husky/pre-commit` regenerated `types/` but not
`docs/`, so a JSDoc-only commit passed the hook and then failed step 9 of
`npm run verify` in CI — three steps to discover on the machine instead of one, on
the commit that caused it. `docs:drift` is the one gate that **rewrites the
committed tree before asking whether the commit matched** (`typedoc.json` sets
`cleanOutputDir: true`, so there is no incremental mode to diff against, and a
bare `git diff -- docs` would pass forever once regenerated in the working copy).
That is why `docs/` has to be _committed_, not merely generated. The hook now runs
`npm run docs` and stages the result, matching what it already did for `types/`.

Verified by probe rather than by reading: a JSDoc-only comment change was detected
by **both** steps, and the probe was reverted with `verify` green afterwards. The
hook still does not run the test suite, for the reason its header gives — a
minutes-long hook gets `--no-verify`'d, and a bypassed hook protects nothing while
looking like a safeguard.

#### The metrics test titled "all nine or none" that tested four

`test/metrics.test.js` ran its helper-registration check over a four-entry list
of the nine helpers that attach. Five were untested: `PowerEventLoopMonitor`,
`PowerSocketAdapter`, `PowerRealtimeHub`, `PowerWebSocketClient`, `PowerPool`.
Three of the five need a real constructor argument rather than an empty options
bag — `PowerSocketAdapter({})` throws because it refuses a socket it cannot
classify, `PowerRealtimeHub` requires a `send(subscriber, frame)` adapter, and
`PowerWebSocketClient` requires a `url` — which is most of why they were
skipped. All nine probed before being written down: each registers, each
produces prefixed series, each detaches on teardown.

**Nothing was broken.** That is the finding, and it is worth saying plainly:
extending the list was coverage for its own sake. The bugs the row hoped this
would catch (OBS-001, OBS-002) were found and fixed without it. The latent
order dependency it claimed to remove was not there either — every helper in the
list already detaches on `dispose()`, which each case calls, so the singleton
was clean between tests. Removing the new `afterEach` leaves the suite green.

**What was real is that the list could drift again silently, and the obvious
guard for that is decoration.** An `it.each` over a list cannot detect its own
list being wrong: deleting five entries runs five fewer cases and nothing else
fails. My first attempt asserted `prefixes.size === HELPERS.length` plus that
nothing was left registered — trivially true, and still true with five entries
deleted, so removing five helpers _and_ removing just the pool both left the
suite green. The test reproduced the exact defect it was written to fix, inside
itself. That is a shape worth naming: the previous version of this file was
titled "all nine or none" and tested four, and a test guarding that fact was
just as unchecked.

The working guard reads `src/helpers/*.js` and compares the extracted
`attach(this, '<prefix>')` sites against the list, so it fails in both
directions — dropping five helpers fails 1, and adding a tenth attaching helper
to the source without listing it fails 1. A second test pins the teardown
direction per helper, which is the half that is silent when wrong: a
registration that outliving its helper is a series that looks live and is not,
and `terminate()` on a pool still answers `getStats()`. Caught 9 ways.

Also corrected `guides/metrics.md`, which claimed the feature landed "Since
2.1.0" while 2.0 is unreleased and FEAT-007 ships in it. The only other `2.1.0`
in the repo is a dependency version in `package-lock.json`.

Closes TEST-002.

#### A cache eviction policy that was measured and not adopted

`PowerCache`'s eviction cursor is already a SIEVE "hand" — it needs only a
`visited` bit to become the policy SIEVE describes, which claims a lower miss
ratio than nine state-of-the-art algorithms on more than 45 % of 1559 traces,
no lock on a hit, and roughly ten lines on top of a structure this cache already
has. `node bench/claims.js sieve` measures it against what ships, and the answer
is that **it does not pay here**, so the library is unchanged.

SIEVE is implemented _in the bench file_, beside a hand-rolled plain-LRU control
that differs from it in exactly one respect — three pointer writes per hit
instead of one bit store. The control reproduces shipped `PowerCache` exactly on
both traces (27.0 % / 51.0 %, identical survivor counts), so the SIEVE row is a
difference in policy rather than a difference in data structure.

| workload    | shipped LRU | LRU + tinylfu | control LRU | SIEVE      |
| ----------- | ----------- | ------------- | ----------- | ---------- |
| zipf + scan | 27.0 %      | 26.8 %        | 27.0 %      | **26.4 %** |
| scan-heavy  | 51.0 %      | 49.2 %        | 51.0 %      | **51.1 %** |

A tie where it matters, a loss where it does not. The paper's cost claim does not
reproduce in JS either: the hit genuinely is cheaper in principle and it is
**slower** here — 137 ns/op against the control's 105 on scan-heavy. The only
margin anywhere in the table is +1.9 points over the shipped `lru + tinylfu
w=4`, which is smaller than the gap between two shipped configurations.

**Read the row, not the verdict: the benchmark is silent on the paper's headline
claim.** "No lock on a hit, 2× a 16-thread LRU" is about _concurrent_ caches, and
a single-threaded Node run cannot measure lock contention. What this measures is
the portable half — miss ratio — and the finding is narrow: that half does not
transfer to these traces. It is not evidence against SIEVE for a lock-contended
multicore cache, and adopting it on this number would be the wrong inference in
either direction.

Two trace-design notes are kept in `bench/README.md` because both produced wrong
numbers before the right one. The working set must **exceed** capacity: the first
scan-heavy run used 300 against 500, every policy survived 300/300, the scan fit
in the slack, and nothing was ever evicted — the comparison proved nothing. And
SIEVE's hand is **persistent and one-way**; resetting it per eviction is a CLOCK
sweep, a weaker policy that is not SIEVE, and it reported a five-point loss. Hit
rates are deterministic here — same seed, identical survivors across runs — so
only the ns/op column moves between runs.

Closes ALGO-001.

#### A cache structure whose win turned out to be memory

`node bench/claims.js sieve` also benches the **generational two-`Map`** structure (`quick-lru` / `hashlru`), proposed as the better eviction structure for this codebase: _"avoids expensive delete operations"_ by dropping the whole old Map on eviction, with no cursor and no node pool. Measured, and **not adopted**.

At the configured `maxEntries` of 500 it posts the largest number in the table — **64.0 % against plain LRU's 51.0 %, +13.0 points** on a scan-heavy trace — and it gets there by **peaking at 1003 entries, 101 % over**. That is the proposal's own "up to 2× over-fill" bound, reproduced exactly. Sized so its peak lands at 502 instead, the same variant scores **35.5 %**: **−15.4 points against LRU at matched memory.** The entire margin was the memory.

For this library the bound is not only a memory bound. `PowerCache`'s `maxEntries` is a contract, not a hint — `_evictIfNeeded` loops while `_map.size > this.maxEntries`, `stats().size` is public, and `maxWeight` is enforced by the same loop — so holding 2× `maxEntries` breaks a published guarantee rather than exceeding a soft one, and the remedy would be an API change rather than a policy tuning.

The bench therefore carries a `peak` column and a deliberately-sized `generational @ half cap` row. The first version of the mode had neither, and the full-capacity number read as a straightforward 13-point win; recording the bound as a measured number instead of accepting the proposal's characterisation of it is the entire difference between "adopt" and "reject".

What survives is the structural claim, and it is the genuinely new part: no cursor and no node pool makes a stale-eviction-cursor bug _structurally_ impossible rather than merely unreachable by inspection — a stronger guarantee than SIEVE's design could give, since its hand still dangles. It is also a guarantee against a bug that does not exist, because that cursor defect is closed as not reproducible across 2.4 M operations.

Honest limit on the conclusion: a single synthetic trace family, with `PowerCache`'s **weight** accounting not modelled at all. A weight-aware variant could plausibly reorder this, because discarding a whole Map is far coarser than a weight-driven `unlink` — so closing the question properly needs a weight-aware trace, not this one.

Closes GAP-004.

#### Documenting a trap the API does not warn about

Every rate limiter in this library holds its state in **this process's heap**.
There is no shared store, and there will not be one — a shared limiter needs a
runtime dependency, which `REJ-008` rejects. So **N processes behind a load
balancer enforce N × the configured limit**: three instances of
`new PowerGCRA({ rate: 100 })` admit 300 requests per second across the service,
not 100.

What makes it a trap rather than a bug is that nothing fails and no instance is
individually wrong. The moment two instances of a service disagree about how much
traffic has happened, the ceiling you believe in is not the ceiling in force.
`guides/metaGuide.md` now says so in those terms, points at the two in-process
families where the caution does _not_ apply — a permit gate each process counts
separately bounds its own concurrency, not a global rate — and says how to size
around it: `rate` is the per-instance share, and the global ceiling goes in front
of it.

**There is no per-key limiting here either, and the obvious way to add it is a
bypass.** The premise was confirmed (`src/` has no `keyFn`, `perKey` or `Group`
surface), then reproduced. The row proposed bounding a map of per-key limiters
with "an LRU or weak map". A `WeakMap` is unavailable — keys are strings, not
objects — and the LRU is **worse than no bound at all**, because evicting a
limiter discards the tenant's consumed budget with it. A `PowerCache` of
limiters, the obvious tool in this repo, evicts a tenant that has been quiet and
the tenant returns to a **brand-new limiter with a full fresh allowance**. That is
a rate-limit bypass, not a cache miss, and it penalises precisely the tenants
that behaved.

So the two obvious implementations are wrong in opposite directions, and both are
reachable with attacker-controlled input: an unbounded `Map` measured 50 000
resident limiters for 50 000 distinct tenants, and the bounded one resets
budgets. No `keyFn` ships until that trade is settled, because an API that looks
supported makes the bypass easier to reach, not harder.

Closes ALGO-004. The per-key row stays open with the reproduction recorded, and
its next step is a decision — exact per key with unbounded memory, or bounded and
approximate per key — rather than an implementation.

#### Per-key rate limiting, and why the map of limiters is not a map

Limiting per tenant, per IP or per user is how real services limit, and this
library had none — `bottleneck`'s equivalent is a `Group`, and the advice there is
to "create one limiter for each origin IP". One limiter was one limit, and every
caller had to keep a map of limiters themselves.

`PowerRateLimit` now takes a `keyFn`:

```js
const limiter = new PowerRateLimit([() => new PowerGCRA({ rate: 10, per: 1000 })], {
  keyFn: (ctx) => ctx.tenant,
  buckets: 1024,
});

limiter.tryConsume(1, { context: { tenant: 'acme' } });
```

Two shape changes come with it. Each entry becomes a **factory**
`(slotIndex) => limiter`, because a shared instance cannot hold per-key budgets —
one limiter with an unbounded key space is the thing being fixed. And the key
arrives as a per-call `context` that `keyFn` reads.

**The design decision is the interesting part, and it was not the obvious one.**
Keys are hashed into a **fixed array of slots** and **nothing is ever evicted**.
Both obvious alternatives were measured first, and they are wrong in _opposite_
directions, both reachable with attacker-controlled input:

- A `Map` of per-key limiters grows with the key space — 50 000 distinct tenants
  produced 50 000 resident limiters, a memory-exhaustion surface reachable from a
  header.
- **An LRU of per-key limiters is worse than no bound at all**, because evicting a
  limiter discards that key's consumed budget with it. A tenant evicted while quiet
  returns to a brand-new limiter with a full fresh allowance. That is a rate-limit
  **bypass**, not a cache miss, and it penalises precisely the tenants that
  behaved. `PowerCache` is the obvious tool in this repo, which is precisely why it
  is the wrong one — and it is the same finding as GAP-004, where the generational
  two-`Map` flip won the miss-ratio comparison and would still be wrong here,
  because a whole-`Map` drop discards exactly the per-key history the map exists to
  keep.

Hashing bounds memory **without an eviction path**, so no request can have its
budget reset: the bypass is structurally impossible rather than unlikely. Measured,
1 000 000 distinct keys allocate exactly 1024 limiter sets.

**The cost is real and the caller is choosing it: two keys that hash to the same
slot share a budget.** That is nginx's `limit_req` model, and the trade is
deliberate — for a limiter whose input is untrusted, a bounded approximation beats
an exact answer you cannot afford to keep — but it is a weakening of "per key", so
`buckets` is configurable and the guide says so plainly. Over 100 000 keys into
1024 slots every slot was used, max/mean 1.39x, no hot spot. A **missing `context`
degrades to one shared limit rather than no limit**, so forgetting it throttles
instead of unlimiting.

**Three new throws**, all `TypeError` and all caught by the validation tests: a
`keyFn` that is not a function (which would otherwise fall back to the _unkeyed_
path, silently turning a per-key limit into a global one), a non-positive or
fractional `buckets`, and an instance where `keyFn` requires a factory.

`reset()` clears the budgets of every built slot but **keeps the slots** —
discarding them would hand every key a fresh allowance, which is the same bypass
reached deliberately.

`test/powerRateLimit.keyed.test.js`, 18 tests, nine mutations all caught. The
consume path is split into `_consumeIn(legs, …)` so keyed and unkeyed calls share
**one** implementation — duplicating the atomic pre-check, commit loop and rollback
bookkeeping is the likeliest way to end up with per-key consumption that does not
roll back when a leg fails, which is the exact defect the unkeyed path was fixed
for.

Closes GAP-005.

#### Stale-while-revalidate gained a bound, because it had none

`PowerCache` already had `staleWhileRevalidate` on `getOrSet` and
`getOrSetAsync`, so the review's premise — "`PowerCache` has `getOrSetAsync`
and **no notion of stale**" — was wrong. The feature was not absent, it was
**unbounded**, which is worse.

Measured with the flag on, before any code changed:

```
+500ms    served: old    refreshes: 0
+1 hour   served: old    refreshes: 1
+30 days  served: old    refreshes: 1
+5 years  served: old    refreshes: 1
```

A value **five years** past `expiresAt` was returned as "stale", with the
background refresh failing silently each time. That is
serve-forever-while-refreshing, and it is the one failure mode
stale-while-revalidate must not have — a caller asking for
freshness-while-not-blocking is asking for it for a bounded time.

`staleTtl` is the bound: how long past `expiresAt` a stale value may still be
served. `0` turns the feature off, `Infinity` leaves it unbounded, and one
predicate serves both the sync and async paths so they cannot drift.

**`Infinity` is the default, and that is a compatibility decision with a
reasoning worth stating.** The per-call `staleWhileRevalidate: true` flag
already existed and already served stale with no upper bound, so defaulting to
`0` would have silently switched that off for every existing caller — the flag
would still be passed, nothing would be stale, and nothing would say so. Two
existing tests caught exactly that before it shipped.

So the **new** surface is the part that is safe by construction: `allowStale`
without a `staleTtl` **throws**, so the unbounded window cannot be deployed by
omission. `staleTtl: Infinity` remains available for a caller who wants it on
purpose — the difference between a decision and an oversight. An unreadable
`staleTtl` (`'soon'`, `-1`, `NaN`) also throws rather than being coerced: an
unparsed duration compares false against every entry and would silently
disable the feature, the opposite of what a typo asks for.

`allowStale` moves the flag off every call site, and `getOrFetch(key, factory?)`
uses a new instance-level `fetchMethod` for the same reason — a function literal
at every call site is most of the cost of the async API in a hot path. A
per-call factory still overrides it.

**Two corrections to the row's framing, both measured.** The implied _stampede
risk does not exist_: 20 concurrent `getOrSetAsync` callers on one expired key
run the factory **once**, now pinned by a test because the stale path is where
such a regression would hide. And `allowStale`/`staleTtl` were **silently
ignored** options — accepted without complaint, readable back as `undefined`.

`test/powerCache.stale.test.js`, 14 tests, seven mutants all caught. One mutant
earned its keep: reverting an `if (!(this.staleTtl > 0)) return false` guard
changed nothing, which proved the guard **dead** — with `staleTtl: 0` the
comparison alone is already false for any expired entry. It restated the
arithmetic, so it was deleted rather than kept as reassurance. Two more mutants
found errors in my own tests: the second call joined the in-flight refresh
instead of making a fresh decision (dedup working, masking the assertion), and a
preceding `get()` had removed the expired entry the second half was measuring.

Closes GAP-002.

#### `stats().staleServes` — because a stale serve looked like a fresh hit

A stale-while-revalidate serve counted only `hits`, so `stats()` could not tell
"served fresh" from "served expired". For a feature whose entire purpose is
silently returning old data, that is the one number worth having: an upstream
that starts failing does not make requests _fail_, it makes them serve old
data, and the hit rate goes **up**, not down.

```js
cache.stats().hits; //         every serve that succeeded
cache.stats().staleServes; //  the subset that was expired
```

`staleServes` is a subset of `hits`, not an addition to it — from the caller's
side a stale serve was a hit — so `hits - staleServes` is the count of genuine
fresh hits. Neither is a miss.

Found by reading rather than by any failing test, which is the part worth
recording: nothing was broken, and no test failed. Four surfaces landed on
`powerCache.js` in one release cycle (`staleTtl`, `allowStale`, `getOrFetch`,
`fetchMethod`) and the observability of the feature they added was never
revisited. It now reports zero on a cache that never serves stale, is pinned on
both the sync and async paths — separate implementations sharing one predicate,
so a counter checked on only one of them would be the same one-sided bound that
started this — and does not count a serve past the stale window, which would
make the number meaningless.

While there, `stats()`'s declared return type was missing `expirations`, which
the implementation has always returned. That was a standing type error in the
generated declarations; the type now lists it.

#### `simpleArgsKey` aliased distinct arguments onto one cache entry

The memoizer's default key resolver handed the **whole argument list** to
`JSON.stringify` the moment it met a non-scalar. That one decision caused four
defects, all measured before any code changed:

| Input                                        | Old key                     | Problem                                                        |
| -------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| `({a:1}, undefined)` vs `({a:1}, null)`      | `'[{"a":1},null]'` for both | a memoizer served one call's value to the other                |
| `({a:1}, fn)`                                | `'[{"a":1},null]'`          | aliased onto `null`                                            |
| `new Map([[1,2]])` vs `new Map([['a','b']])` | `'[{}]'` for **both**       | every `Map`, `Set`, `RegExp` and `Error` was indistinguishable |
| `{n: 1n}`                                    | threw                       | while a top-level `1n` was supported — one value, two answers  |
| a circular object                            | threw                       | `Converting circular structure to JSON`                        |

The `Map`/`Set`/`RegExp`/`Error` collision was the worst: nothing about those
inputs suggests they are unencodable, and a memoizer keyed on one returned the
first one's value for every subsequent one. Confirmed end to end — two distinct
calls, **one** underlying invocation.

Each argument is now encoded on its own, type-tagged by prefix: scalars, arrays,
plain objects, `Date`, `RegExp`, `Error`, `Map`, `Set`, `BigInt` and cycles all
get a distinct encoding, so two different arguments cannot produce one key.
`Map` order is preserved (it is significant) and a repeated sibling value is
shared rather than mistaken for a cycle.

**A function argument now throws a `TypeError`.** Two closures have no comparable
identity and `String(fn)` is identical text for both, so any encoding would
either collide or be useless; refusing is the only answer that cannot be wrong,
and the message says what to do instead.

**Behaviour change worth stating:** memoizing a function _argument_ previously
"worked" by colliding with `null`. It now throws. Pass a key, or supply a
`keyResolver`.

The key format for **scalar-only** calls is byte-identical to before, so the
35 % scalar-path measurement the original optimisation was built on still
describes the common case.

`test/powerCache.memoKey.test.js`, 18 tests, 10 of 12 mutants caught. The two
that were not are recorded rather than papered over:

- The old `String(v === 0 ? 0 : v)` **`-0` normalisation is dead code** —
  `String(-0)` is already `'0'`, so it could not change the result, and a test
  asserted the two were equal and passed whichever way it was written. Re-adding
  it is not caught, which is the proof. Deleted, and the test now says why the
  behaviour is still worth pinning.
- The cycle marker cannot be made to collide by mutation, and that is a
  structural argument rather than a test: every encoding is non-empty and
  type-tagged, so no marker can be confused with a value's encoding. Recorded as
  an argument, not dressed up as coverage.

One existing test **asserted the defect** — it required the key to equal
`JSON.stringify([{ a: 1 }])`, i.e. it pinned the broken fallback, in a file whose
name has nothing to do with the code under test. Re-pinned to the property that
matters: structurally equal arguments share a key, different ones do not.

Closes CACHE-009.

#### Event-loop utilisation is now readable over an interval

`PowerEventLoopMonitor` already resolved Node's `eventLoopUtilization()` lazily
and exposed it as `utilization()` — that half of the proposal was already in
place, which the review row does not record. What was missing is the half its
whole argument rests on.

`utilization()` hands back the **cumulative** reading, so `active` and `idle`
grow for the life of the process and the method answers _"how busy has this
process been since it started"_. A lifetime average barely moves. The property
that makes the built-in worth reaching for is that it is **defined over a
measured interval**, and getting there meant subtracting two readings by hand.

`utilizationSince(previous)` returns `{ active, idle, utilization, ratio,
elapsed }` for the interval between two readings. Measured:

| What happened                  | delta                                          |
| ------------------------------ | ---------------------------------------------- |
| 1 s of synchronous blocking    | `active` +1000 ms, `idle` +20 ms → ratio 0.98  |
| 200 ms awaiting a timer        | `active` +0.3 ms, `idle` +200 ms → ratio 0.001 |
| 300 ms of synchronous blocking | `active` +300 ms, `idle` +20 ms → ratio 0.94   |

A cumulative reading reports the same lifetime average for all three.

**The sensitivity is not academic.** The _same_ 500 ms block, read at a different
moment in the process's life, reported **+0.2 ms** of active time — ELU's counters
are refreshed by the loop, so a reading taken at the wrong moment misses the
interval entirely. That is precisely why the interval has to be explicit rather
than left to a caller's polling discipline.

`null` is returned, rather than a number, when there is no previous reading, the
runtime cannot measure, or the counters went backwards — a negative interval
would read as a large stall in the other direction. `ratio` is `0` rather than
`NaN` for an empty interval, so polling faster than the loop ticks does not
poison every comparison.

`utilization()` is unchanged and still cumulative. That is a pin rather than a
preference: had it been changed to a delta, every caller reading it as a lifetime
figure would silently start reporting an interval.

`test/powerEventLoopMonitor.utilization.test.js`, 9 tests, 6 mutants all caught.

**The review row's premise was out of date, and the part that was missing is the
part worth having.** It is closed as written rather than as described.

Closes GAP-001.

#### An in-flight fetch is now signalled when its key stops being wanted

`getOrSetAsync` called its factory with no arguments, so a factory had no way to
know the result was no longer wanted. `AbortController` appeared nowhere in
`powerCache.js`: an evicted key's factory ran to completion and then wrote its
result into a cache that no longer wanted it.

The factory is now called as `asyncFactory(signal)` — the `fetch` shape, so a
factory written for `fetch` or `lru-cache` works unchanged — and the signal fires
when the key is **evicted** by a later write, **deleted** or **cleared**, and when
the caller's **timeout** elapses.

**Aborting is a request, not a kill.** A factory written before this takes no
argument, cannot be stopped, and still has its value cached. Refusing to store it
would lose work a caller wanted. The signal is for a factory that can cooperate.

**The in-flight slot is still released at the timeout, and that is a deliberate
trade rather than an oversight.** Holding it until the factory settled stopped a
duplicate factory from starting — and leaked: a factory that never settles
(`() => new Promise(() => {})`, which the timeout tests use twice) would hold its
slot forever, so the key could never fetch again and every entry accumulated one
Map row per hanging factory. A duplicate costs compute; a permanent slot is a
memory leak _and_ a permanently broken key.

So the residual F-09 named is reduced, not eliminated, and it is stated rather than
buried:

- a caller arriving **before** the timeout joins the running factory and receives
  its value — the common case, and the one the retry path wants;
- a caller arriving **after** it starts a new fetch, which for a factory that
  ignores the signal means the work is done twice.

**A `try`/`catch` around the aborting call does not contain a throwing listener**,
which the implementation's own comment originally claimed it did. `runAbort`
re-reports a listener exception on `process.nextTick`, so it surfaces as an
uncaught exception rather than something the cache can catch. The cache does not
throw from `delete()` — the node stays linked and the map consistent — but it
cannot rescue a caller whose own handler throws. That is the platform's contract,
the same as for any `abort()`.

The controllers live in a **parallel Map** rather than by widening the in-flight
entry to a `{promise, controller}` record. That was the first attempt and it was
the wrong call: 13 assertions across 4 files read the in-flight map and expect a
bare promise, and every one would have had to change for no gain. A test pins the
shape so a later tidy-up does not re-introduce the migration.

`test/powerCache.inflightAbort.test.js`, 14 tests, 8 mutants all caught.

**The review row's cost and its blocker were both wrong.** It rated the work "S"
and, when I first took it, I recorded "31 tests across 8 files" as the blast
radius — that number was a failure count from a half-applied edit, not a call-site
count. The real figure is 13 references in 4 files, and the design above needs
none of them changed. The row also said the work "must land as two changes" — the
record-shape migration first, then the signal — and the parallel map removes the
first one entirely.

Closes GAP-003.

#### The TinyLFU sketch hashed the key once per row, four times over

`SmallLfuSketch` derived each row's column from `_index(key, row)`, and
`hashKey` did `String(key)` **plus a full FNV pass over the key's characters**.
At `depth: 4` that is four string coercions and four FNV loops to do what is one
of each, so the cost scaled with key length rather than staying fixed.

Measured before and after, median of five runs over 200 000 operations:

| quantity                 | before |      after |
| ------------------------ | -----: | ---------: |
| `increment` (depth 4)    |  75 ns |  **17 ns** |
| `estimate` (depth 4)     |  76 ns |  **14 ns** |
| both, short key          | 152 ns |  **31 ns** |
| hashing work, key len 24 | 229 ns | **118 ns** |
| hashing work, key len 64 | 411 ns | **240 ns** |

The key is now hashed once per `increment` and once per `estimate`, and the four
row indices are derived from that one hash — the same thing Caffeine's `spread()`
does. `mix32` still runs per row, so the rows stay independent; collapsing them
would leave a 4-row sketch behaving like a 1-row one.

**No behaviour changes and no test needed changing**: the bucket assignment
shifts, and every existing test still passes. That is worth stating rather than
assuming, because a hash change is exactly the kind of edit that quietly
degrades an admission filter while every test stays green — which is why the new
tests assert the properties that would detect it, below.

`test/smallLfu.hashOnce.test.js`, 10 tests, **every assertion a counter rather
than a duration** — this project's timing harness has a ~29 % median min/max
spread, so a wall-clock assertion would be decoration. The primary one gives the
key a counting `toString` and asserts one coercion per call at depths 1, 2, 4 and
8; before the change that number was `depth`.

**The mutation check found an uncaught mutant here, and the first two tests I
wrote to catch it were both wrong.** Dropping the per-row seed
(`row * 0x9e3779b1`) leaves every row using the same column — and was NOT caught,
because:

- the index is `row * width + column`, so even with one shared column the four
  rows still land on four _different_ counters. The sketch keeps working, and a
  test counting distinct touched bytes sees four either way;
- counting _distinct estimate values_ and assuming more spread means more variety
  measured the opposite: 5 distinct with the spread, **7** without. A collapsed
  sketch groups all four rows identically, so the minimum across rows is one
  consistent count — more uniform, and therefore more varied across keys.

The property that does separate them is the one count-min exists for:
independent rows make the minimum **lower**. Summed over 200 keys into 64
columns, **481 with the spread against 808 without**. The first two attempts
reasoned about the wrong statistic, and would have shipped an unprotected
invariant on the strength of an assertion that could not fail.

Closes CACHE-007.

#### Measured: the admission window walks the list on every main-space `get()`

Not a fix — a measurement, added because the gap is real and the number was not
recorded anywhere durable.

`PowerCache`'s TinyLFU admission window is the contiguous suffix of the list, so
`_windowOldest()` walks back from the tail. That is O(windowSize), and it runs on
**every main-space `get()`**, because moving a main-space node to the tail has to
re-establish where the window starts.

`node bench/claims.js window`, maxEntries 4000, 3000 entries resident:

| `windowSize` | window walks per `get()` | walk steps |    ns/get |
| -----------: | -----------------------: | ---------: | --------: |
|            0 |                     0.00 |          0 |       133 |
|           10 |                     1.00 |          9 |       279 |
|          100 |                     0.98 |         97 |       670 |
|         1000 |                     0.80 |        799 | **2 236** |

**16.8× per `get()`**, and `windowSize: null` — the documented recommended default — is
`ceil(maxEntries * 0.01)`, so the cost scales with the cache. The walks-per-get ratio is
the fraction of reads landing in main space rather than the window, which is why it
falls below 1 as the window grows.

**Two things worth knowing before anyone tries to close this.** The window only exists
under `admission: 'tinylfu'`; `_windowSize` is forced to 0 otherwise, so the first
version of this mode measured nothing at all and reported a flat ~200 ns — concluding the
row was stale when in fact it had measured a disabled feature. And `powerCache.js:514`
already records that a previous attempt at a maintained window pointer "got it wrong"
and was reverted, leaving behind a `_windowStart` field that is assigned `null` in two
places and never read. This is therefore a **second attempt at a design that has already
failed once**, and the walk counts the mode prints are the check that would say whether
the retry worked.

The row stays open.

#### A cross-realm `Error` was silently replaced by an `AbortError`

`abortReason()` — the rejection value every `signal`-taking helper in this
library produces — tested `signal.reason instanceof Error`. `instanceof` compares
against _this realm's_ `Error.prototype`, so it is `false` for an `Error`
constructed in another `vm` context, another realm or an iframe. A caller who
aborted with their own error therefore got a **different object** back: a
generic `AbortError` reading `The operation was aborted`, discarding both the
message they wrote and the `name`/`code` that identified the condition.

```javascript
// in a separate vm context
controller.abort(new TypeError('shutting down the tenant'));
// before: rejects with AbortError / "The operation was aborted"
// after:  rejects with that exact TypeError
```

The check is now `isError()` from `src/utils/errors.js` — `Error.isError()`
where the runtime has it, and the previous `instanceof` behaviour where it does
not. Two differences are worth knowing because both change an answer, and both
are the correct one: an error from another realm now matches, and
`Object.create(Error.prototype)` now does not.

**`Error.isError()` does not exist on this library's floor, and the premise was
checked before the change rather than after.** `engines.node` is `>=22.12.0`
(V8 12.4) and CI runs 22.12; installed and run against 22.12.0, where
`typeof Error.isError === 'function'` is `false` and the call throws
`TypeError: Error.isError is not a function`. It arrived in V8 13.6 / Node 24.
So the capability is probed once at module load rather than assumed, and the
`instanceof` fallback preserves today's behaviour exactly where the platform
cannot answer — a strict improvement, not a raised floor. **The cross-realm fix
is therefore available on Node 24+ and browsers shipping ES2026, and the old
blind spot remains on 22.12.**

Two of the row's supporting claims did not survive checking, and the code
follows what survived:

- **A `Worker` is not a separate realm for this purpose.** A `worker_threads`
  error reaches the parent through the structured clone algorithm, which
  reconstructs it against the parent's intrinsics. Measured: `m instanceof Error`
  is `true` for an error posted from a worker. There was nothing to fix there,
  and the row's framing — that this library "routes errors across a worker
  boundary", so cross-realm matters most here — does not hold for workers.
- **`powerLogger.error()` was never realm-fragile.** Its clause read
  `a instanceof Error || (a && typeof a === 'object')`, and the second half
  already caught a cross-realm error, after which `normalizeError` reads only
  `.code`/`.message`/`.stack` — all of which it has. Logging a `vm`-created
  `TypeError` and a local one produced byte-identical payloads _before_ any
  edit. It now uses `isError()` anyway, because one `instanceof` left behind
  invites the reading that the logger is realm-fragile when it never was, and
  `guides/powerLogger.md` now documents the formatting rules the test pins.

Four `instanceof Error` sites remain, and each is a **degradation rather than a
substitution**, so none of them loses a caller-supplied object: `powerCron._report`
and `metrics`/`powerPool` wrap or stringify (the message gains an `Error: ` prefix),
and `powerBulkhead.reset` wraps — which drops the caller's `code` before stamping
`ERR_BULKHEAD_RESET`. They are the same one-line change and should be taken
together. `powerCache`'s `encodeArg` is deliberately left alone: it turns an
`Error` into a cache key, so the encoding has to agree with itself across the
key-building and key-reading paths, and that is a change to a shipped key format
rather than an error-narrowing fix.

`test/powerLogger.isError.test.js`, 14 tests, **mutation-checked**: reverting the
feature detect fails 5, reverting `abortReason` fails 2, removing the logger's
`typeof a === 'object'` fallback fails 1, a duck-typed `isError` fails 1, an
`isError` that always returns `true` fails 4, and reverting the whole change
fails 9.

Closes GAP-012.

## `createFrameDecoder()` — an incremental frame decoder (`PowerMessageCodec`)

`decodeMessage` reads **one whole frame** and throws on anything less, so it
cannot be pointed at a socket, a `ReadableStream` or a `node:stream` chunk. Its
JSDoc has always said that `byteLength` "lets a stream reader know how much to
consume", and no such reader existed anywhere in the repository. `guides/powerMessageCodec.md` documented one you had to write yourself.

```javascript
const decoder = createFrameDecoder({ maxFrameBytes: 1 << 20 });
for await (const chunk of stream) {
  for (const { value } of decoder.push(chunk)) handle(value);
}
const tail = decoder.flush(); // zero-length if the stream ended on a boundary
```

**The gap, reproduced before the change.** A frame split across two reads throws
`RangeError: … truncated frame` — and `decodeInbound` throws the same, so there
is no second entry point to use instead. That is the _normal_ state of a stream
roughly once per frame, so the error arrives at a rate that trains a caller to
swallow `RangeError`s, including the one that means the peer is genuinely
corrupt. The second failure is quieter: two frames in one chunk return the first
and stop, reporting a `byteLength` smaller than the input. Nothing throws and
the remaining bytes are never looked at.

**`maxFrameBytes` is required, and that is the design.** A frame declares its
own payload length, so a peer that sends a 6-byte header and then nothing holds
the buffer open at whatever size it named — no bound, no counter, no error. A
default would be RT-009's defect in new form: a limit that sounds like one and
is not. The ceiling is checked **when the header arrives**, so an oversized
frame is refused before its payload is buffered rather than after; `Infinity` is
the documented opt-out, and it is greppable where a default is not.

**The row's 1.6× did not reproduce, and the guide says so.** The row recorded
offset-based decoding against a naive re-concatenate-per-chunk decoder as
0.306 ms against 0.503 ms per 500-frame stream, 1.6×. Re-measured at that exact
shape — 500 frames of ~422 bytes in 157 chunks of 1400, arms interleaved so JIT
warm-up hits both equally — the two are **1.00× and 1.19× on two runs, with a
55–60 % min/max spread against this repository's 28 % noise floor**. At 422 bytes
a frame the copy is L1-resident and free. They separate only when a frame is
large enough for the copy to matter (1.9× at 32 KB frames), which is an
asymptotic property rather than a number. The design is still right, for the two
failures above and because re-concatenating per `push` is O(n²) in the chunk
count — but it is adopted for correctness and bounded memory, and no performance
claim is made.

**Mutation is what settled that, in both directions.** `test/powerMessageCodec.frameDecoder.test.js`, 34 tests. Of 21 mutants, **16 caught**:
the ceiling removed (2), the ceiling checked only on a complete frame (2), the
ceiling measured against the chunk rather than the frame (2), the multi-frame
loop stopping after one frame (14), throwing on a short chunk (8), the drained
cursor rewind removed (1), `maxFrameBytes` not required (1), and each of the
three validation flags (1 each), `pendingBytes` not excluding consumed frames
(2), `flush()` returning a view instead of a copy (1), `flush({ strict: true })`
not reporting (2), `reset()` rewinding only the write cursor (1), and the
`_readLength` offset ignored (9).

**Three of those tests did not exist until the mutants said so.** The first pass
had no case where a chunk carries whole frames _and_ the start of the next —
which is the ordinary socket shape, and the only state in which the read cursor
is non-zero while bytes are still buffered. `pendingBytes` counting the write
cursor, `flush()` handing back a window onto the live buffer, and `reset()`
leaving the read cursor ahead of the write one all passed 31 of 31 until that
case was added; the last of the three makes the decoder silently decode nothing
forever, with no error. The fourth survivor is a real redundancy rather than a
gap: dropping the `end` from the `subarray(start, end)` frame view is caught by
nothing, because the `end - start` completeness check runs first and
`decodeMessage` is never reached with an incomplete frame. Both the source and
the test now say which of the two is the guard.

The five surviving mutants are the compaction (two separate reverts of it), the
growth factor, the buffer release in `dispose()`, and that redundant bound — all
allocation or memory policy with no effect on a decoded byte, which is the
mechanism behind the null result above. The drained-cursor rewind is the
interesting contrast: it **is** caught, by one test, and only because it changes
buffer reuse and so changes what a `rawAsBytes` view sees next, not what any
frame decodes to.

`dispose()` is a state reset, not a cancellation: the decoder owns no timer, no
listener and no handle, only bytes, so it stays usable afterwards and a `using`
block that disposes early does not leave a dead object behind. Writing that test
is what found the one real defect in the implementation — `dispose()` left a
zero-length buffer and the growth loop doubled from zero, so the next `push`
never terminated.

The hand-rolled reader is removed from `guides/powerMessageCodec.md` — it named
an undefined `concat()` and had no ceiling. Closes CODEC-001.

---

## Cache iteration, the window memo, retry cancellation and the queue ring

**Added in the session that closed the cache, retry and queue review rows.**
Eight changesets were added alongside this file during that work and then folded
in here, because `CHANGELOG.md` records that consolidated notes are the decision
for this release and that "a changelog that is maintained separately from the
release notes is a changelog that goes stale". They were correct individually and
together they read as a list of edits, which is the thing consolidation exists to
prevent. Nothing was dropped in folding them in.

**Fixed**

- **Mutating a `PowerCache` while iterating it silently truncated the walk.**
  `for (const [key] of cache.entries()) cache.delete(key)` removed exactly one
  entry and reported `size: 0` afterwards, through `entries()`, `entries('LRU')`,
  `keys()` and `values()`. Measured n=2 left 1, n=3 left 2, n=4 left 3, n=10
  left 9. The walk advanced `node = node.prev` after each `yield` resumed, and
  `_remove` nulls both links on the node it removes. `cleanupExpired()` called
  from inside a loop was the worse trigger, because it is a public maintenance
  method rather than a mutation the caller chose: a bulk export that swept each
  turn visited the expired entry and **no live entries at all**. Fixed by reading
  the continuation before the yield. The contract is now stated rather than left
  to be discovered, and the one residual loss — two adjacent removals in a single
  step may end the walk early — is deliberate, because closing it means
  snapshotting the walk into an array on every call to a bulk-export API.

- **A recency mutation inside a `PowerCache` iteration loop was an infinite
  loop.** `for (const [k] of cache.entries()) cache.get(k)` never returned:
  `get()` relinks the entry to the MRU end, which is behind an MRU-first cursor,
  so the walk arrived back at the node it was standing on (60 yields on 6 keys).
  `touch()` and `set()` on a key already present reach the same state. The walk
  now visits at most as many entries as existed when it started, which ends the
  cycle without truncating a correct walk — measured 0.00 window walks per
  main-space read, and a maximum excess of 0 over 300 clean walks.

- **`PowerQueue` no longer retains its high-water mark forever.** The buffer only
  ever grew, so a queue that took 5 000 items once kept an 8 192-slot buffer for
  the rest of its life, and `clear()` emptied the slots without releasing them.
  This was a leak inside the library rather than only a sharp edge for callers:
  `PowerSlidingWindow` keeps its timestamps in a `PowerQueue`, so one large
  `tryConsume` window left every instance holding the memory of the worst burst it
  had ever seen. Now measured **8 192 → 16** once the window ages out, with
  steady traffic settling at 16 without reallocating.

- **The pre-commit hook could not commit changes to eight source files.** It
  mapped `src/helpers/x.js` to `docs/helpers/x` unconditionally, but the docs
  tree is not uniform — five helpers are documented at `docs/<name>`, and a
  typedef-only module has no page at all — and `git add` treats a missing
  pathspec as fatal under `sh -e`. Any commit touching `powerRetry.js`,
  `powerGCRA.js`, `powerMessageCodec.js`, `powerRealtimeHub.js`,
  `powerWebSocketClient.js`, `options.js`, `timers.js` or `jsdoc-types.js` was
  rejected by its own hook. Both layouts are now tried and only existing paths
  are staged.

- **Prettier was reformatting typedoc's own output.** `docs:drift` compares the
  committed tree against `npm run docs`, and typedoc writes
  `docs/docs-typedoc.json` with tabs. Prettier reformatted it to two spaces, so a
  verified commit failed step 10 of `verify` minutes later — 77 589 insertions
  across 2.6 MB. Fixed with a `.prettierignore`. The obvious fix, lint-staged's
  `"!docs/**"` negation, **does not work**: a later
  `"*.{json,md,yml,yaml}"` glob re-claims the file the negation dropped, which
  was tried, committed, and measured not to help.

**New**

- **`PowerRetry.run` takes a `signal`, and the backoff wait is interruptible.**
  It previously could not be cancelled at all: `attemptTimeout` bounded a slow
  _attempt_ and nothing bounded a slow _gap_, so the sleep ran to completion — up
  to `maxDelay`, 30 s at the default. Measured: an abort during a 5 000 ms
  backoff now rejects in **81 ms**. Rejections carry `code: 'EABORT'` and the
  signal's `reason`, the shape `PowerDeadline` already uses, so one `err.code`
  check covers both helpers.

- **`PowerQueue.shrink(minimum)` and `PowerQueue.fill(item, count)`.** The first
  gives back the memory a burst grew, explicitly rather than on every dequeue;
  the second removes a temporary `new Array(n)` and a second `pushMany` pass from
  every `tryConsume(n)` with `n > 1`.

**Docs**

- **What `PowerRateLimit`'s `atomic: true` actually guarantees.** The option is
  reached by two mechanisms and the documentation named neither: a limiter with
  `available()` is settled by a synchronous pre-flight, while a limiter without it
  is composed through `reserve` with best-effort rollback. The rollback path reads
  as _the_ implementation of `atomic`, and measuring it says otherwise — with two
  `PowerThrottle` legs and the second drained, `atomic: true` refused and the
  first leg still held all 5 tokens. The no-`await` invariant the pre-flight
  depends on is now pinned.

- **What `reset()` means on each of the 19 classes that have one**, which is six
  different things: refill to full; refill counting held permits and rejecting
  queued waiters; empty; zero the measurements; return to the initial machine
  state; and halve, which is `smallLfu`'s documented half-life reset. The
  sharpest pair points in opposite directions: after `queue.reset()` and
  `throttle.reset()` on equally drained instances, the queue has nothing and the
  throttle has everything. That is why there is no shared `refill()` primitive,
  and the divergences are now enforced rather than merely documented.

---

## Folded in from the remaining individual changesets

**Folded in from the remaining individual changesets.** `CHANGELOG.md` records
that the 22 accumulated changesets "are now one file", but these were still
separate and their content was **absent** from the consolidated file rather than
duplicated in it — 31 distinctive entries had no other route into the release
notes. They are appended here under their original filenames so the move is
auditable, and the originals deleted. Nothing was dropped.

### From `broadcast-channel-audit-defects.md` (minor)

Four defects found by probing the shipped surface rather than reading it. Two were
silent message loss, one was a feature that reported the wrong thing, and one was
a fix from an earlier release that had introduced a failure of its own.

**`PowerScheduler` — `dispose()` on one macrotask scheduler used to wedge every
other one, permanently**

The macrotask channel is module-level, so it is shared. `dispose()` closes it,
which was correct in isolation — a started `MessagePort` keeps a Node process
alive forever, and `unref()` alone does not stop that once the ports are open.
But "release the channel" meant "release it for the whole process", so disposing
one scheduler tore the listener off every _other_ scheduler's pending flush. The
message was discarded, `_run()` never ran, and `scheduled` stayed `true` — which
makes `schedule()` short-circuit on its first line forever after. Only `cancel()`
recovered it, and nothing documented that.

Measured before the fix: two macrotask schedulers, `a.schedule()`, `b.schedule()`,
`b.dispose()` before delivery — `a` flushed **0** times, and `a.scheduled` was
still `true` after three further `schedule()` calls. The trigger is the `using`
pattern the class advertises through `[Symbol.dispose]`.

Posts in flight are now counted, and `dispose()` drops the module reference but
**only closes the ports when nothing is pending**. The next scheduler builds a
fresh pair; the pending post is still delivered on the old, already-`unref()`ed
one, so nothing holds the process open. Disposing on an idle path closes the
ports exactly as before, and a subprocess that schedules and disposes still exits
cleanly.

Worth naming: this was introduced by RES-005 / F-53, the fix for a real and
separate process-hang bug. Both were real; the second only showed once two
schedulers shared a process.

**`PowerTTLMap` — a `ttl` that was not a number made an entry immortal**

`PowerCache` was repaired for this (CACHE-003) by extracting its check into
`powerCache.js` — which **exports nothing**, so `PowerTTLMap` could not reach it
and kept `Number(ttl) || 0`. The defect survived the fix, in the class next door.

```js
new PowerCache().set('k', 1, { ttl: 'abc' }); // TypeError, naming the value
new PowerTTLMap().set('k', 1, 'abc'); // stored expiresAt === 0
```

`0` is this class's "no expiry" sentinel, so a typo produced an entry that never
expires — silent, unbounded, and indistinguishable from correct behaviour. `[]`,
`true` and `NaN` did the same, and a **negative** TTL granted the same immortality.

The validator now lives in `utils/options.js` as one shared `normalizeTtl`, used
by both classes, so the next change to it lands on both. `PowerTTLMap` accepts a
number, a numeric string (still legitimate — `process.env.TTL` is a string) and
the `{ ttl }` object form; `Infinity`, `null`/`undefined` and `0` still mean no
expiry; everything else throws a `TypeError`, and a negative TTL a `RangeError`.
`{}` still means "use `defaultTTL`".

**This is a behaviour change.** Callers who were passing a computed TTL that can
be `NaN` will now get a `TypeError` where they previously got an entry that never
expired. That is the same trade `PowerCache` already makes, and the alternative —
silently keeping an immortal entry — is worse, but it is a throw at a call site
that used to succeed.

**`PowerGCRA.onError` fired on every ordinary refusal**

The predicate was `now < this._tat`, and a TAT ahead of `now` is not a clock
fault: it is the limiter's **normal saturated state**, and exactly what a
rate-limiting limiter looks like while it is working. Measured at
`rate: 1, capacity: 1`, **19 refusals produced 19 `onError` calls**, each carrying
a raw number rather than an `Error`, on a clock that never moved. So a correctly
rate-limiting limiter looked broken to anything watching, and a genuine backwards
clock step was indistinguishable from the noise.

The option is documented as reporting a misbehaving clock, so it now compares
against the last reading taken rather than against the TAT: a real backwards step
reports once, ordinary refusals report nothing, and the first reading after
construction reports nothing (there is no previous one to compare against). Still
never throws, and still guarded so a throwing handler cannot break admission.

**`PowerLatch.reset(count)` accepted what its own constructor rejects**

The constructor runs `assertLimitRequired(count, { integer: true })` and throws on
`2.5`; `reset()` ran `Math.max(0, Number(count) || 0)`. A fraction is not a smaller
latch, it is a latch that **cannot finish**: `reset(2.5)` then one `countDown()`
leaves `1.5` and `wait()` never settles. In the other direction `NaN` and `-5` both
collapsed to `0`, which _resolved_ every pending waiter — a bad argument
fabricating completion out of a latch nobody had counted down. `reset()` now uses
the same validator, and a rejected count leaves the latch untouched.

### From `cache-observability.md` (patch)

fix(cache): `observability` was read by the constructor and missing from `PowerCacheOptions`

`PowerCache`'s constructor calls `attach(this, 'cache', options)`, and
`attach()` in `src/helpers/metrics.js` reads `options.observability` to decide
whether to register the helper with the shared `MetricsCollector`. The option
worked; `PowerCacheOptions` did not declare it, so a TypeScript caller could not
pass it.

Seven of the eight constructors that call `attach()` declared the field. This was
the one that did not, which is the harder half of the bug to see — nothing fails,
the option is documented in `guides/metrics.md`, and seven sibling classes accept
it, so the gap reads as an oversight in the type rather than a missing feature.

Same defect class as `PowerPool`'s `encodeCacheLimit` / `encodeCacheByteLimit`,
fixed in 3d54d29. Both were found by a pass built to reject options a class does
_not_ accept, which flagged them as the exception.

Pinned in `test/types.test-d.ts` across all eight `attach()` callers, so a future
removal is caught by this repository's compiler rather than a consumer's.

One limit stated rather than left to be found: the _value_ type is not enforced —
`new PowerCache({ observability: 'yes' })` still compiles, so the declared
boolean-or-collector union is not checked at the constructor. Only acceptance is
asserted here. Tightening the value type is separate work.

### From `constructor-forms.md` (patch)

fix: a leading numeric argument is now accepted positionally _or_ as an option

Six helpers took a positional number while about twenty took an options object,
and the split had no rule a reader could infer. `PowerTTLMap` already normalised
both forms — the right answer, applied to one class out of seven. The other five
did not, in two distinct ways, both bad:

```js
new PowerLogger({ level: 2 }); // silently came up at level 0
new PowerObserver({ value: 5 }); // stored the *object* as the observed value
new PowerSemaphore({ limit: 3 }); // threw, naming a number you just passed an object for
```

`PowerLogger` is the worse of the two silent cases: a logger asked to be verbose
was quiet, with nothing to indicate why. `PowerObserver` was worse still — it
appeared to work while observing `{ value: 5 }` rather than `5`.

All five now accept both forms. **Positional calls are untouched**, so this is
additive; nothing that compiles today stops compiling.

Two rules keep it honest rather than a second way to be wrong:

- **An object is read as options only when it carries a known option key.** A
  bare `{}` still falls through to the numeric path and is rejected, which
  `test/powerLatch.reset.test.js` already pins as a property — "whatever the
  constructor rejects, `reset()` must reject too". A looser normalisation broke
  that on the first attempt and the existing test caught it.
- **The whole object is validated, not just the key being read.** Otherwise
  `{ limit: 3, nonsense: 1 }` would pass, and arriving in the options-object form
  would be a way to _bypass_ the strict-options check in 8f83c07 rather than a
  second way to satisfy it.

Pinned in `test/constructorForms.test.js`, including that the object form is not
a validation bypass. Mutation-checked: dropping the `assertKnownOptions` call
from the `PowerSemaphore` branch fails the test.

### From `ergonomics-audit.md` (patch)

An ergonomics audit of the helpers, found by probing the built surface rather than
by reading it: an error that named the wrong class, a method that silently dropped
its arguments, a guide documenting an option that no longer exists, and a `stats()`
split that had reached the documentation as a false claim.

**Behaviour**

- **`PowerSemaphore.run(fn, options)` honours `options`.** It took no second
  parameter, so the `{ signal }` a caller writes by mirroring `acquire(options)` —
  which this class does accept — was silently discarded. It was discarded
  _quietly_: the promise stayed pending until a permit happened to be released, so
  an uncancellable request was indistinguishable from a slow one. With an
  already-aborted signal against a saturated semaphore, it never settled at all.
  `run` is the form people reach for first, so cancellation matters more here than
  on `acquire`, and `PowerBulkhead.run`, `PowerDeadline.run` and `PowerRetry.run`
  all accepted options already.

- **`PowerSemaphore`'s validation errors name itself and its own option.** It
  delegates its whole body to `new PowerPermitGate({ capacity: limit })`, and the
  gate's `className` was hardcoded, so every error told a caller who had written
  `new PowerSemaphore(...)` to look at a class they never constructed and an
  option they never typed:

  ```text
  before: PowerPermitGate: `capacity` must be a finite number
  after:  PowerSemaphore:   `limit` must be a finite number
  ```

  `PowerPermitGate` reports itself unchanged, and `queueCapacity` / `initialTokens`
  keep the gate's names on purpose — `PowerSemaphore` exposes neither, so pointing
  a caller at them would invent options. **If you match on the error text of a
  `PowerSemaphore` construction failure, update the pattern.**

**Additive**

- **`getStats()` on every helper that reports through `stats()`.** Nine helpers
  spelled it `stats()` and one — `PowerPool` — spelled it `getStats()`, with no
  stated rule and nothing pinning it. A user who learned one reached for the other
  name everywhere else and got `TypeError: x.getStats is not a function` from
  whichever class they had not learned the exception to. `getStats()` now
  delegates to `stats()` on all ten. `PowerPool` is unchanged — it is the older
  and far larger surface, and renaming it would be breaking.

  Two reversals are worth recording, because both shipped green first.

  **The first implementation was a dynamic prototype patch.** A
  `src/utils/statsAlias.js` applied `Object.defineProperty` at module scope. It
  worked at runtime and passed every runtime test, and was **absent from the
  published `types/`** — `tsc` cannot see a prototype patch — so a TypeScript
  caller would have got `Property 'getStats' does not exist` on a method that ran
  fine. That file no longer exists. The alias is now an ordinary method on each
  class, so `tsc` emits it like any other.

  **The second carried a hand-written copy of each `stats()` return shape.** The
  reasoning was that an explicit type was safer. It is not: a concurrent change
  added `staleServes` and `expirations` to `PowerCache.stats()` and the copies
  were stale within the same session. Omitting `@returns` lets `tsc` infer a
  byte-identical published type, and with nothing written twice there is nothing
  to keep in sync. The copies are gone.

  The type guarantee is now asserted where it belongs — `test/types.test-d.ts`
  compiles bidirectional assignments between `stats()` and `getStats()`, which is
  the property a consumer relies on. An earlier test compared the two _declaration
  strings_ and reported a false mismatch (`PowerRetryBudgetStats` versus
  `import("./jsdoc-types.js").PowerRetryBudgetStats` — the same type), which was
  itself arguing for putting the hand-written copies back.

  The alias is deliberately **not** added to classes with no `stats()` at all
  (`PowerTTLMap`, `PowerLogger`): it would hand a caller a `TypeError` from a name
  this change is teaching them to expect.

**Documentation**

- `guides/powerThrottle.md` documented `refillInterval` as a real option with a
  default of `1000`. The option was removed in 9a1d9d5 precisely because it was
  inert, and `types/` correctly omitted it — **only the guide still carried it**,
  so a user reading the guide set it, got silence in return, and landed on a
  limiter that behaved correctly by accident. Fixed there; the same stale name was
  in two of this repository's own tests, which passed only because unknown options
  are ignored and so were teaching an option name the API does not have.
- `guides/metrics.md` and `llm.txt` claimed that every helper reporting anything
  does it through its own `stats()`. Both were false about `PowerPool`, and
  `metrics.md` contradicted itself seven lines later by writing
  `metrics.register('pool', () => pool.getStats())`.

Closes QUAL-011.

**Known limits of this change, stated rather than left to be discovered:**

- Nothing here makes an **unknown option** an error. Every helper still ignores
  unrecognized keys, and `test/deadOptions.family.test.js` pins that as correct —
  sound reasoning for an option that was _removed_, since no caller could have been
  depending on behaviour that did not exist. It does not extend to a _misspelled_
  option, which is the common case: `new PowerThrottle({ refillRat: 5 })` yields a
  bucket that never refills. An opt-in `strictOptions` is the intended answer and
  is deliberately **not** in this release; the default is unchanged.
- Six constructors still take a positional primitive and throw on an options object
  (`PowerSemaphore`, `PowerQueue`, `PowerLatch`, `PowerLogger`, `PowerObserver`,
  and `PowerPermitGate` in its options-object form only), while about twenty take
  an options object. `PowerTTLMap` accepts both. Unifying the six is a 2.0 API
  decision rather than a patch, and is not attempted here.

**Per-call options are now typed.** Twelve methods used to publish
`options?: {}` — an empty object type-checks _anything_, so a TypeScript caller
passing `{ now: 1234 }` got no completion, no error, and no pointer to
`LimiterNowOptions`. The runtime has always forwarded and honoured these; only
the declaration was missing. They are now declared:

```ts
throttle.tryConsume(1, options?: LimiterNowOptions): boolean;
gate.acquire(options?: { signal?: AbortSignal }): Promise<PowerReleaseFn>;
timed.set(key, value, options?: { ttl?: number; weight?: number }): ...
```

This is worth spelling out because it **narrows** those twelve signatures in a
patch release: an options bag that used to accept anything now rejects unknown
keys. Code that was passing a misspelled key type-checked before and will not
now. That is the intended direction — a `PowerThrottle` whose `{ refillRat: 5 }`
was silently dropped is the bug — but it is a type-level tightening and is the
one part of this changeset that can break a compile that passed before.

Three things were needed to get there, none obvious:

- Each limiter needs an explicit
  `@typedef {import('../utils/limiterClock.js').LimiterNowOptions}` line. Without
  it `tsc` emits `.d.ts` files referencing an undefined name — the emitted
  declarations were wrong while the source looked correct.
- `test/types.test-d.ts` now carries `@ts-expect-error` directives proving an
  unknown key is _rejected_. Under `options?: {}` those directives would have
  compiled and then failed as unused, which is the only way to tell this fix from
  a decorative one.
- A runtime test pins that per-call `now` is honoured on a limiter constructed
  **with no injected clock**, which no existing test covered: every prior case went
  through an injected `now` or through the `PowerRateLimit` composition. Declaring
  an option is a promise it works, so it is pinned rather than assumed.

**Two options are now declared rather than left as `{}`.** `PowerPermitGate`'s
`className` and `limitName` are on `PowerPermitGateOptions`, which is what makes
the corrected error messages type-check at all — an undeclared property read
inside the constructor was 10 of the 14 type errors this change initially
introduced, and `npm run typecheck:ratchet` caught them at exactly the ceiling.
The ratchet did its job.
**A new gate step: `docs:claims` (step 9 of 10)**

Written because two defects in this repository shipped undetected, and neither
was caught by `docs:drift` — `docsCodeAgreement.test.js` and `docsLinks.test.js`
both check code _referenced from_ the docs, while these were a doc asserting
something about the code.

It found real drift immediately. Seven entries in `llm.txt` had prose sliced off
mid-sentence and a code fragment spliced onto the end — including
`import { PowerLatch } from '../src/helpers/powerLatch.js';` appended to a
summary. That is a generation bug in the one file whose entire purpose is
machine consumption, and it shipped. All seven are fixed.

Two corrections to documents that were actively wrong rather than merely stale:

- `llm.txt` claimed every line was "a title and that guide's own opening sentence
  … so the two can only disagree if the guide changes". Ten of its 49 entries are
  deliberate paraphrases, so the guarantee never held. It now describes what is
  actually true and what is actually checked.
- `guides/powerThrottle.md` documented `refillInterval` as a real option, removed
  in 9a1d9d5 because it was inert. `types/` correctly omitted it; only the guide
  carried it.

The check reads the **generated** declarations, so it runs after `types:generate`
and `types:drift`. Both halves are mutation-checked: re-injecting the
`refillInterval` row fails it, and re-injecting a code fragment into `llm.txt`
fails it.

Two limits stated rather than left to be found. It does not check option
_defaults_ — a default is not recorded in the published `.d.ts` at all, and
`refillInterval`'s wrong default was the more misleading half of that row. And
ten guides report "option names not checked" because they have no options typedef
in the declaration; that is reported honestly rather than counted as a pass.

**`docs:claims` now covers 26 guides rather than 10.** The six it skipped were not
skipped because they have no options — two of them were skipped by a regex that
missed the inline-import spelling the emitted declarations use for a type that
lives outside `jsdoc-types.js`:

    options?: PowerThrottleOptions                              // matched
    options?: import("./jsdoc-types.js").PowerBatchOptions      // was not

and the rest because the table was found by looking for a `## Constructor`
heading, when the guides variously use `## Constructor`, `## Options` and
`### API`. Both were silent: the script reported "not checked" and exited 0. It
now locates an options table by its _header row_ — first column named `option` —
which is the actual intent, and drops the heading match that had also produced a
false positive on `powerSocketAdapter.md`, whose `## Constructor` section is a
transport-detection table, not an options table.

Six guides remain unchecked and all six are correct: `powerQueue` and
`powerSemaphore` take a positional primitive, `powerDefer` has no constructor,
`WorkerAgnostic`, `metrics` and `powerRealtimeHub` document their options as prose
rather than a table. The report says so rather than claiming a pass.

Mutation-checked against four of the newly-covered guides — injecting a bogus
option row into `powerGCRA`, `powerCache`, `powerPool` and `powerRetry` fails the
guard on all four, including the two whose typedef spelling it previously missed.

### From `hub-constructor-docs.md` (patch)

docs(realtime): document `PowerRealtimeHub`'s constructor options, and fix a guard that was not checking them

The hub's guide documented the per-call `subscribe()` options but never its
constructor options — eight of them, including `send`, which is required. There
was nothing to check against, so `npm run docs:claims` reported the guide as
"no options table; option names not checked" and passed.

Two fixes, and the second is the one that matters:

- The guide now carries a constructor options table, so seven names are checked.
- **`docs:claims` was not resolving options for this class at all**, and said
  nothing. Its parser matched `options?: SomeOptions` — the _optional_ form —
  while `PowerRealtimeHub`'s constructor is `constructor(options: HubOptions)`,
  required. No match meant no options resolved, which the script reported as a
  benign "no options typedef found" note rather than a gap.

A required options parameter lists exactly the same accepted names as an optional
one, so the pattern now accepts both. This is the fourth time a guard in this
project has passed while checking nothing, and the reason is recorded in the
script: a miss that reports itself as "nothing to see" is indistinguishable from a
guide that genuinely has no options.

Mutation-checked: renaming `batchDelayMs` to `batchDelay` in the new table fails
the guard, naming that option alone rather than all seven.

### From `observability-validated.md` (patch)

fix(metrics): a wrong `observability` value registered nothing and reported nothing

`attach()` in `src/helpers/metrics.js` read `options.observability`, treated any
truthy value as a request to be measured, then discarded anything that was not
`true` or a collector — silently.

    new PowerCache({ observability: 'yes' })

`'yes'` is truthy, is not `true`, and has no `register`, so it registered nothing
and raised nothing. A caller who asked to be measured was silently not measured,
and would find out from a dashboard that looked plausible. The option's type was
declared as `boolean | MetricsCollector` and never checked.

A bad value now throws, naming the class and what was passed. Falsy stays inert,
because "off" is a legitimate answer and `observability: false` is how you say it.

`test/metrics.test.js` had a test pinning the lenient behaviour — _"ignores a
value that is not a collector … A typo must be inert rather than fatal"_ — which
was the bug rather than the virtue. It is rewritten to assert the new contract,
with the reasoning kept, because the old reasoning is worth recording as the thing
that was wrong.

### From `pool-encode-cache-options.md` (patch)

fix(pool): `encodeCacheLimit` and `encodeCacheByteLimit` were read but never declared

Both were read by the `PowerPool` constructor and absent from `PowerPoolOptions`,
so a TypeScript caller could not pass either — the options existed at runtime and
in the implementation, and nowhere a consumer could see them.

    this._encodeCacheLimit = Math.max(
      16,
      options?.encodeCacheLimit ? options.encodeCacheLimit : 64
    );

Found by a pass that was checking for the opposite problem: it rejected options a
class does _not_ accept, and these two came back as the exception — read by the
constructor, missing from the published type. That is worth recording separately,
because a check built to find one class of defect turned up the other, and the
fix is a typedef rather than any change to behaviour.

`encodeCacheLimit` bounds the entry count of the LRU that caches serialized
messages so an identical message is not re-encoded every time (floor of 16,
default 64). `encodeCacheByteLimit` bounds the total bytes it holds, evicting
oldest entries to fit; it defaults to `Infinity`, which leaves the count-only
behaviour unchanged.

### From `realtime-hub-silent-loss.md` (minor)

Three defects in `PowerRealtimeHub`, all with the same signature: a message that
never arrived, and no counter that said so.

**`flush()` permanently wedged a hub configured with `batchDelayMs > 0`**

`flush()` cleared `_flushTimer` but not `_flushScheduled`, and the timer callback
was the only other place that reset that flag — so clearing the timer removed the
one thing that would have. Every later `publish` then short-circuited at
`_scheduleFlush`, and the hub stopped flushing for the life of the object.

Measured: publish, `flush()`, publish again, wait 100 ms — **0 frames sent**, 1
still queued. What made it worth a P0 rather than a missed frame is the counters:
`published` kept climbing, so a dashboard showed a live publisher, `delivered`
froze, and **`dropped` never moved** — because the slow-consumer policy only runs
in `_enqueue` and the message never reached a full queue. It reached a dead
scheduler. Both counters this library's own guide tells you to alert on reported
nothing wrong.

The trigger is any `flush()` before a later `publish`, so tests and any
timer-driven caller hit it. `batchDelayMs: 0` was never affected — it takes the
`queueMicrotask` branch, whose callback _does_ reset the flag — and neither was
`batch: false`, which never sets it. All three are now pinned.

**`codec: 'raw'` silently discarded every message in a batch of two or more**

`_flushSubscriber` splices the batch off the subscriber's queue _before_
`_encodeBatch` runs, and `raw` cannot frame a batch boundary, so the throw
discarded everything it had taken. Two `publish` calls in one microtask is the
**default** `batch: true` path, so this was the normal case: measured
`published: 2, delivered: 0, dropped: 0` — no counter moved, for two messages the
caller published and the transport never saw.

A subscriber that could coalesce more than one is now rejected at `subscribe()`,
naming the option to change. The check is there rather than in the constructor
because `maxBatch` is a per-subscriber option and the hub's default is 32:
`raw` is legal, `maxBatch: 1` is the configuration the hub can honour, and
`subscribe()` is the only place both facts are visible. Note that `batch: false`
does **not** rescue the default, since the splice is unconditional.

A payload that cannot be framed at all is now counted in `dropped` and reported
through `onError`. Re-queuing it instead was the obvious fix and is wrong — an
encode failure is permanent, so the retry spins and `flush()` never resolves.

**`retain` never replayed, and publishing to an empty topic retained nothing**

`publish(topic, msg, { retain: true })` wrote to an internal map that nothing ever
read: it was consulted in exactly two places, its own write path and the detach
path. A subscriber arriving after a retained publish got `[]`, while the option is
documented as "keep the message for a subscriber that subscribes later". The
existing test could not catch it — it asserts `seen.length <= 32` on a value that
is structurally always `0`.

Worse, `_retain` sat _below_ the `if (no subscribers) return 0` early return, so
publishing into a topic nobody was listening to retained nothing at all — which is
precisely the case the option exists for. Both are fixed; a replay goes through
the same queue and the same slow-consumer policy as a live delivery, and does not
increment `published`, because it is not a publication.

Separately, detaching one subscriber emptied the retained log for the **whole
topic**, so one subscriber leaving destroyed history every other live subscriber
on that topic still depended on. The log is per topic and the detach is per
subscriber; it is now released only when the last subscriber on that topic leaves,
with `close()` clearing the rest.

### From `remaining-findings.md` (patch)

Three small gaps the ergonomics audit left open, all of them cases where the
library accepted something it should have made reachable or refused.

**`PowerSemaphore` exposes its gate's queue bound.** It built a `PowerPermitGate`
that could queue without limit and proxied neither the bound nor whether it had
been reached, so a caller using the class most people reach for could neither cap
the queue nor observe it filling. `queueCapacity` is now an accepted option, with
`get queueCapacity()` and `get isFull()` on the instance:

    const sem = new PowerSemaphore({ limit: 1, queueCapacity: 1 });
    // A third caller is refused with ERR_QUEUE_FULL and `queueCapacity: 1`
    // rather than queued forever behind a bound it cannot see.

**`PowerThrottle` and `PowerSlidingWindow` can be disposed.** These held clock
state and no teardown, so — unlike every other long-lived helper here — they
could not take part in `using` / `await using` or DI teardown. `PowerGCRA` already
had it.

Their `dispose()` is a **state reset, not a cancellation**: none of the three owns
a timer, each refilling lazily from a stored timestamp. A spent bucket is dropped
and recorded history cleared. The rule is now written into `AGENTS.md`, because the
split is not self-evident — for a stateless value type the absence of `dispose()`
is obviously right, so it reads as deliberate everywhere, including where it was
not.

**`Cache.startCleanup` accepts `{intervalMs}`.** It read only `.interval`, so
`intervalMs` — the spelling about fifteen other options in this library use, and
the one a caller reaching for the obvious name would write — was accepted and
silently dropped, in a method whose entire job is reading its options. The cleanup
then ran on the default interval the caller believed they had overridden. `interval`
wins when both are given.

Pinned in `test/powerSemaphore.test.js`, `test/limiterDispose.test.js` and
`test/powerCache.extra.test.js`. The limiter dispose is mutation-checked, and the
`using` test is a parse-time assertion — without the symbol that call site does
not compile, which is the gap being closed.

### From `strict-options.md` (major)

BREAKING: an unknown constructor option now throws instead of being ignored

Every helper silently ignored unrecognised option keys. This change makes that an
error, naming the option, the class, and — where there is an obvious near miss —
what was probably meant:

    new PowerThrottle({ capacity: 10, refillRat: 5 })
    // TypeError: PowerThrottle: unknown option `refillRat`.
    //   Did you mean `refillRate`? Accepted options: capacity, now, refillRate, tokens.

The error carries `code: 'ERR_UNKNOWN_OPTION'` and `option: '<key>'`, so a caller
need not parse the message.

Why this is the right trade

The old tolerance was introduced in 9a1f9d5, when four inert options were removed,
with sound reasoning: a caller already passing a removed option could not have
been depending on behaviour that never existed, so ignoring the key cost nothing.
That reasoning is correct for a **removed** option and does not cover a
**misspelled** one, which is the common case and the one that reaches production:

    new PowerThrottle({ capacity: 10, refillRat: 5 })

builds a bucket that never refills. Nothing is thrown, nothing is warned, and the
limiter is indistinguishable from a correct one until a request is refused in
production.

What it cost, measured

Turning the check on for a commit found **nine tests across six classes** passing
options that do not exist. Every one of those tests passed, and every one was
asserting nothing — the helper behaved exactly as it would have with the option
absent. Three passed _both_ the real option and a misspelling of it:

    new PowerThrottle({ capacity: 10, windowMs: 1000, capacity: 10 })

where `windowMs` is a `PowerSlidingWindow` option. Read as intent that is
ambiguous — was the test exercising a window, or a throttle with a redundant
capacity? — and that ambiguity, not the typo, is the real damage.

The same defect had reached a guide: `guides/powerThrottle.md` documented
`refillInterval`, removed in `9a1d9d5` because it was inert, as a live option with
a default, while the generated types correctly omitted it. And two shipped
examples set options that never existed — `maxWaitMs` on `PowerBatch` and
`refillInterval` on `PowerThrottle`.

## Migrating

If you pass an option that no longer exists, the error names the class and the
key. Either remove it, or — if it genuinely crosses a version boundary — strip it
before constructing:

    new PowerThrottle({ capacity: 10, ...pickKnown(opts, 'refillRate') })

Falsy values are unaffected: `observability: false` still means "off", and a
class with no options object still constructs as before.

## Scope

30 classes. The accepted set is derived from each class's published typedef, so a
constructor and its `types/` declaration now agree by construction rather than by
inspection — which is the property whose absence let the drifted spellings above
through in the first place.

Two of them accept keys that belong to a collaborator rather than to them:
`PowerCache` also takes `keyResolver`, `cacheOptions`, `ttl` and `weight`, because
`PowerMemoizer` forwards its own options straight into the cache it owns.

### From `test-option-names.md` (patch)

test: four classes' tests were passing option names that do not exist

`PowerHistogram`, `PowerThrottle`, `PowerBulkhead` and `PowerCircuit` tests each
passed an option the constructor does not have — `buckets`, `limit`, `size` and
`resetTimeoutMs` respectively. Every one of those assertions passed, and every one
of them was asserting nothing: unknown options were ignored, so the helper
behaved exactly as it would with the option absent.

Some were worse than inert. Three calls passed **both** the real option and a
misspelling of it —

    new PowerThrottle({ capacity: 10, windowMs: 1000, capacity: 10 })

— where `windowMs` is a `PowerSlidingWindow` option. Reading that, the intent looks
unclear: was the test exercising a window, or a throttle with a redundant
capacity? The duplicate `capacity` is now gone and the cross-class `windowMs` with
it, and the assertions around it are unchanged.

This is the same defect class as the `refillInterval` row that shipped in
`guides/powerThrottle.md`, found from the other end: a guide documenting an option
the code does not have, and tests exercising options the code does not have. Both
were invisible because unknown keys were silently ignored.

Three more, in `test/disposal.test.js`, `test/invariants.test.js` and
`test/powerPool.uncovered.test.js`:

- `new PowerBackpressure({ highWaterMark: 2, lowWaterMark: 1, refillRate: 1 })` —
  two invalid names in one call. The source reads `lowWaterMark` and
  `refillAmount` (`powerBackpressure.js:77`); `highWaterMark` is a
  `PowerWebSocketClient` option and `refillRate` a `PowerThrottle` one. Since the
  test only needs a constructed resource-owner, the faithful translation is
  `capacity: 2` with the two real options.
- `{ maxSize: 10, maxWaitMs: 0 }` on `PowerBatch` — `maxWaitMs` is not an option
  at all, and the tests call `flush()` explicitly, so the key was doing nothing.
- `taskQueueEnabled: true` passed to `new PowerPool(...)` — the option is
  `taskQueue`; `taskQueueEnabled` is the public property it sets
  (`powerPool.js:478`). Assigning the property directly, which the same file does
  elsewhere, remains correct.

Found while attempting the corresponding strict-options change, which is not
included here. Every case found is now fixed; the strict-options change itself is
still to land, and is mechanical once these are.

## Benchmarks: the numbers that were not numbers

**Added two benchmark modes, because two recorded numbers were not numbers.**

- **`bench/claims.js hubencode`** — §12.4 recorded a 26 ms hub fan-out flush at
  5 000 subscribers, a re-measure of 15.27 ms, and 3.00 ms with `_encodeBatch`
  memoised: a 5.1× ratio on a 10.89–19.43 ms spread, which is wider than the
  effect. RT-006 proposes to encode once per `(topic, batch)` instead of once per
  subscriber, and the row says it needs this mode before a number is claimed.

  The mode's durable output is a **count, not a timing**: the plain hub runs
  **5 000 encodes for one publish of one payload** and the memoised hub runs **1**.
  That reduction is 5 000-to-1, it is a count, and it is identical on every
  machine. Timing it gives 2.3–2.8× against §12.4's 5.1×, on a 76–90 % spread —
  a direction, and the mode says so.

  **§12.4's isolated cost — 13.91 ms of a 15.27 ms flush, 91 % — could not be
  reproduced as a number, and is no longer reported.** Three runs of the mode gave
  91 %, 93 % and **106 %**, and an arm cannot cost more than the whole that
  contains it. The cause is the allocator rather than the encode: the flush holds
  every frame alive to the end of its timed region while a standalone loop makes
  the frames garbage and pays for them inside the same region. Making the loop
  retain narrowed the range — 14.49 ms discarded against 12.82 ms retained at
  5 000 encodes — but did not close it, because the hub's own per-subscriber
  bookkeeping allocates too. The direction holds in every run; the fraction does
  not.

- **`bench/claims.js framedecode`** — §12.3 claimed 1.6× for
  `createFrameDecoder` over a reader that re-concatenates per chunk, re-measured
  at 1.00× and 1.19× with a 55–60 % spread, and never with a reproducible harness.
  The mode sweeps frame size because the arms are expected to separate only where
  the copy stops being L1-resident. At **32 KB frames the decoder is 2.9–4.1× on
  a 4–14 % spread** — a real signal, where §12.3 recorded 1.9× — and at 281 B the
  arms are indistinguishable, so the claimed 1.6× does not reproduce at the size
  that matters least. Every row is judged against that run's own spread, and a
  noisy row is labelled as noise **in both directions**: the 4 KB row reads 0.73–0.97×
  on a 55–145 % spread, and without that note a reader would conclude the decoder
  is slower there.

  The naive arm is additionally handicapped and says so: `decodeMessage` throws
  on a partial frame, so a reader written without a cursor must check the declared
  length itself. The first version of the arm did not, and crashed with
  `frame is 5 bytes, shorter than the 6-byte header` — the very defect the decoder
  exists to fix, arriving through the benchmark. Any speed shown is understated.

**Instrument bugs the modes found in themselves, which is why they are worth
landing before the work they gate.** The memo counter first counted `_encodeBatch`
_calls_ and labelled them encodes, so the memoised arm reported 5 000 encodes while
doing one and the saving looked like it had done nothing — the same counter RT-006
says it must add. The isolated arm was a cold single shot compared against arms
warmed by nine rounds, which included JIT compilation in one arm and not the other.
And three presentation bugs would each have printed a wrong number: broken column
padding, frame sizes derived from the body rather than the frame (281 B and 32 KB
printed as 548 B and 500 B), and a fixed prose claim about the small row that
ignored what the run had actually measured.
**Added `bench/claims.js correlation`, the gate for optimising the awaited
reply path.** POOL-008 records 2 423 -> 4 450 and 3 198 -> 4 537 ns/op across two
runs — the two runs disagree by ~30 % on the plain arm — and says the mode is the
deliverable rather than the number. It now exists, and its first run is what
qualified that instruction rather than merely repeating it.

The mode replays one payload through `postMessage` and
`postMessage(..., { awaitResponse: true })` from a single interleaved loop, with
the reply produced by a `queueMicrotask` in a fake worker modelled on the one in
`test/powerPool.negotiation.test.js`. Two things it found about itself:

- **min/max is the wrong estimator here.** The first version reported a
  **21 244 %** spread on the plain arm, which is not noise but a broken statistic:
  min/max over 16 000 samples is whichever GC pause landed in the window. It now
  warms up explicitly and reports a p10–p90 band, and still prints `min` because
  that is the robust lower bound a regression test would use.
- **Even p10–p90 is unstable run to run** — 73 %, then 249 %, then 73 % for the
  same arm — while the median moves only a few percent. The mode says so and
  nominates the median as the only figure worth comparing, which is the honest
  version of the row's instruction.

**Measured 4 027 ns plain against 12 082 ns awaited, a 3.06x ratio on medians**,
against a recorded 1.84x and 1.42x. The mode explains why the ratio is larger
rather than leaving it as another disagreement: the two arms do different amounts
of waiting. The plain arm only enqueues — 20 000 messages posted, none awaited —
so it measures dispatch. The awaited arm is necessarily serialised, one round trip
at a time, so it measures dispatch _plus_ a message turn and a settle. A ratio
between those is a statement about the semantics of fire-and-forget rather than a
defect in either path, and it will not reproduce a figure recorded from a setup
where the plain arm also waited for something.

So the mode claims no cost for `awaitResponse`. What it does establish is that a
regression _is_ detectable even though the cost is not: a change that made the
awaited path allocate per task, or scan the pending set linearly, would move the
median by more than its run-to-run movement.

**`PowerRealtimeHub` now encodes the fan-out frame once per `(topic, batch)`
instead of once per subscriber.** Every subscriber on a topic receives the same
bytes, so the encode was repeated N times for one payload. Measured on 5 000
subscribers: the encode was **92 % of the flush**, and the plain hub ran **5 000
encodes for one publish**.

The saving is a count, not a duration: **5 000 encodes become 1**, which is why
the memo is keyed on identity rather than on contents. Keying on the batch's
contents would mean paying `JSON.stringify` per subscriber in order to save the
`frameEncodedJson` per subscriber, and the stringify is the larger half — which
is also why the 91 % "encode is the flush" figure could not be reproduced as a
number and was retired rather than confirmed.

The key is `(length, first, last)` compared **by reference**, which is sound
because of two properties of how a queue is filled: the same message object is
pushed into every subscriber of a topic, and a slow-consumer drop removes only
from the front. So two batches agreeing on length and both ends are the same
batch. It is an identity check, not a value comparison, so publishing the same
value twice encodes twice and nothing has to assume the contents were compared.

**The frame is now shared, and that is the one new contract.** The `send` adapter
is documented as receiving a **read-only** buffer, because a transport that
writes into it corrupts every other subscriber on the topic. `stats().encoded` was
added for exactly that reason: it counts real encodes, so it stays at one per
flush however many subscribers the topic has, and a transport mutating frames
shows up as a count that does not behave.

The memo is a **single slot**, which is the right shape for the fan-out loop — the
drain walks a topic's subscribers consecutively, so consecutive calls carry the
same batch. Subscribers whose `maxBatch` differs interleave _different_ batch
shapes and the slot is overwritten between them, so it misses and pays an extra
`JSON.stringify`. The consequence is extra encodes, never a wrong frame, and that
is pinned as a known miss rather than presented as a win.

## WebTransport feature detection

**Added `detectWebTransportSupport()`.** Pure feature detection returning
`{ available, reliableOnly, datagrams, createWritable, sendGroups, stats, byob }`.

**Three of those surfaces are not Baseline, and the point of the function is that
nothing may be gated on them.** `reliability` and `getStats()` are Limited
availability; `WebTransportSendGroup` is Experimental. Each defaults to `false`
on absence and never to an optimistic `true`, because a detector that guessed
optimistically would be the more dangerous kind of wrong — the caller branches,
reaches a surface that is not there, and discovers it as a `TypeError` several
frames from the mistake.

`reliableOnly` is the flag for callers who want a promise rather than a fact: it
is `false` whenever a non-Baseline surface is **present in the build**, computed
rather than read from a table so a field added later cannot leave it stale. That
distinction is load-bearing for a `getStats` that is exposed but throws — Limited
availability means a build can do exactly that — so it reports `stats: false`
(the call cannot be used) while `reliableOnly` stays `false` too (the surface is
still there).

`createWritable` detects `transport.datagrams.writable`, which is **deprecated
and non-standard** per MDN and which most examples in circulation still use. Its
absence is reported because a build without it cannot write datagrams at all; its
presence is reported without endorsement, and the documentation says so.

The function is pure and opens no connection, which is why the instance-level
fields are `false` without a transport: `datagrams`, `createWritable`, `stats`
and `byob` are attributes of a live `WebTransport`, and the only other way to
learn them is to construct one. Pass a transport to read them — it is used
read-only, and `getStats` is called once to prove it works rather than for its
value. `byob` is a capability rather than a constructor, so it is detected from
both an `incomingHighWaterMark` on the transport and a readable datagram stream.

15 tests, 5 mutants, all caught — including the two that matter most to the row's
prohibition: making `sendGroups` optimistic fails 4 tests, and treating an
exposed-but-throwing `getStats` as usable fails the case that separates presence
from usability.

Zero new type debt, so the ratchet ceiling is unchanged. The probe takes an
optional argument rather than reading globals directly, which is both why it is
testable on Node — where there is no `WebTransport` to probe — and why the
absence cases above are meaningful rather than merely unreachable.

## Payload size: detection at the transport, safety already in the codec

**Added `maxPayloadSizeBytes` to `PowerWebSocketClient`, documented as detection
rather than prevention.** The row's requirement is not a guard but an honest
label, and the distinction is the deliverable: by the time a `message` event
fires the platform has already received and materialised the whole frame, so
nothing at this layer can stop that allocation. The option therefore counts the
oversized frame (`stats().oversizeFrames`), emits an `error` saying what arrived,
and lets the frame through. A number that reads like a limit and is not one is
worse than no number at all, so it is described that way in the option, in the
error message, and in the guide.

The prevention belongs at the peer that produces the frame.

**The codec was already safe, and that is now pinned rather than asserted.**
Verified before writing anything: a frame declaring 4 294 967 295 bytes while
carrying 2 throws a `RangeError` in ~120 µs with **0.0 MB** of heap movement,
because `decodeMessage` validates a declared payload length against the bytes
actually present _before_ slicing, and the payload is a `subarray` view rather
than a copy. That is why a codec-side limit would be redundant — it would check a
number the codec already enforces. The incremental decoder's equivalent bound,
`createFrameDecoder`'s `maxFrameBytes`, is **required** rather than defaulted,
with an error message that names the hazard exactly: a peer that sends a header
and then stops would otherwise pin the buffer at whatever size it named.

The streaming path behaves differently _on purpose_ and the tests say so. Given a
frame declaring 4 GB after two bytes, `decodeMessage` can say "truncated" and the
decoder cannot, because more bytes may still be arriving — so it buffers and
waits, and the safety comes from `maxFrameBytes` refusing to be omitted rather
than from a default.

**The row's "both helpers" does not match the tree, and there is one boundary,
not two.** `PowerWebSocketClient._handleMessage` is the only transport inbound
path: `PowerRealtimeHub` is outbound-only and decodes nothing, and the
`decodeMessage` references in `powerPool` and `powerChunking` are in JSDoc
examples and comments. The detection is implemented where the boundary is.

Two `docs:claims`-relevant details the option carries: the length is read from
whichever shape the platform hands over — a `message` event carries a `Blob` for
binary frames by default, and all three shapes expose a length synchronously, so
the check never forces an awaited `arrayBuffer()`. And `0` **disables** the check
rather than reporting every frame, which is this class's existing convention for
`highWaterMarkBytes: 0`; the first draft documented `0` as "no check" while the
code reported every non-empty frame, and the test caught the contradiction.

10 tests for the option, 8 for the codec, 9 mutants, all caught — including the
two that carry the distinction: removing the detection fails 5, and making the
limit exclusive fails the at-the-limit case. Every oversized-frame test asserts
that the message is **still delivered**, because that assertion is what fails if
a later change "fixes" the report into a rejection.

## The bufferedAmount-after-close trap

**Documented the `bufferedAmount`-after-close trap in the WebSocket client's
guide.** MDN, on `WebSocket.bufferedAmount`: _"This value does not reset to zero
when the connection is closed; if you keep calling `send()`, this will continue to
climb."_ The number meant to say "the socket is full" therefore keeps growing on a
socket that is not open and never comes back down.

That makes a naive wait loop a hang rather than back-pressure, and worse than an
ordinary one: the loop is usually written _before_ the close, so it is correct in
testing and hangs in production, and because the number is climbing every check
keeps passing, so nothing throws and no timeout fires. The guide shows the loop
that spins, the `readyState === WebSocket.OPEN` gate that fixes it, and what to do
in the branch where the socket is not open — stop sending, rather than wait for
room that will never come.

**This client already had both halves**, which the row did not record: the
`bufferedAmount` getter returns `0` unless `readyState === OPEN`, so a closed or
not-yet-open socket reads as _empty_ rather than _full_, and the poll runs on the
backing-off timer rather than in a tight loop. Reading the raw socket instead
would reintroduce the hang.

The row says to land this **with RT-017**, and it did not, because RT-017 is P2,
Medium, and blocked on RT-001 through RT-005 — while this row's own instruction is
_"Ship day one, never after"_. Deferring a trap that costs someone a day of
debugging behind five blocked rows is the exact failure the note warns about, so
the urgency won and the two land separately. MDN's wording was checked against the
page rather than taken from the row, because a guide entry documenting a trap
that does not exist would be worse than no entry.

The property is now pinned rather than left as a consequence of the getter's
implementation: `test/powerWebSocketClient.bufferedAfterClose.test.js` asserts a
socket whose raw `bufferedAmount` has climbed to 64 KiB while `readyState` is
CLOSING reports `0` here, that a genuinely-full open socket still reports its real
number, that a non-numeric value coerces to `0` rather than `NaN` (because
`NaN > limit` is false, so a `ws` socket reporting a string would be silently
treated as _empty_), and that a torn-down socket reports `0` rather than throwing
from a timer callback.

5 tests, 4 mutants, all caught. **One of those mutants initially survived and the
test that should have killed it was vacuous**: the draft set the state to CLOSED
alongside a null socket, so the state check short-circuited and the null guard was
never reached. The corrected case holds `readyState` at `OPEN` with no socket —
which is the real hazard, a poll timer firing between teardown and the state
update. A test written the comfortable way passed against code that would throw,
which is the same trap as the `PLAN_ROW` regex that matched nothing and the
`WebSocketImpl` fixture the client silently ignored.

## PowerChunker streaming: the hang is real, the memory claim is not

**RT-010's premise is half right, and the half that is wrong changes what the fix
is.** Streaming mode does drain the iterable inside the constructor, so **an
infinite or lazy generator hangs it forever** — measured as a 4 s child-process
timeout with the constructor still running, and no pool returned, so there is
nothing to `terminate()`. That is a real liveness defect.

But **"streaming mode fully materialises the iterable" is not true.** A lazy
generator of 400 000 objects left the heap at **5.2 MB during construction** —
the pre-construction baseline — reaching 48.7 MB only afterwards.
`streamIterableIntoPool` posts each chunk as it fills, and `powerChunking.js:128`
says it streams "to avoid materializing the entire iterable". So this is a
**liveness** defect, not a memory one.

**The fix is an API decision rather than a mechanical change, and that is the
useful finding.** Pumping on a macrotask needs something to stop the pump, and
**the constructor returns a pool, not a handle** — `terminate()` stops the workers
while the pump keeps pulling the generator, which trades a constructor that hangs
for a pump that runs forever. The same unbounded behaviour by a different route.
Either the return contract becomes a handle, or an async pump is only cancellable
by exhausting its own iterable, and that is a choice rather than a bug fix.

**The defect is written as a test and left skipped.** `PowerChunker` in
streaming mode draining inside the constructor is asserted by a child-process
probe with a timeout — a hang cannot be asserted in-process, because the test
would hang with it. It fails today and should pass once the pump lands. It is
**skipped** because a permanently red gate is not shippable and `npm run verify`
is the project's exit condition, and the skip says so and names the command to
enable it. The enabled cases pin what can be asserted without hanging: a finite
lazy generator constructs and returns its pool, and there is no pump-cancellation
surface yet — which is the constraint the fix has to satisfy.

**There is deliberately no heap-measurement test, and the reason is worth
recording** because the first attempt looked like it worked. The claim cannot be
tested by heap delta, because **the pool's queue retains the posted chunks
either way**: with `size: 2` and nothing draining it, the pool holds all 400 000
items regardless of how the chunker obtained them, and that ~40 MB baseline swamps
the difference. Measured, in order:

- An absolute threshold read **41.6 MB against correct code** — tuning a constant
  would have made it pass or fail depending on which way the guess went.
- Two **separate processes**: the comparison inverted under full-suite load and
  failed about 1 run in 4, because the arms saw different machine states.
- One process, in sequence: inverted the other way — `streaming used 42.1 MB,
materialising used 35.5 MB` — because the second arm starts on a heap the first
  has already grown.

So the memory claim is refuted by measurement and by the source comment, neither of
which is a test, and the file says exactly that rather than shipping a
near-decoration that passes for the wrong reason.
