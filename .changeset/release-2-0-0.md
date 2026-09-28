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
  `maxEntries` and `clear()` are still honoured exactly.
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
