---
'performance-helpers': major
---

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
