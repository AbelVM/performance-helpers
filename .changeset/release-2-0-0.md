---
'performance-helpers': major
---

The wire protocol, the histogram, and the release process all changed: 23
commits of audit remediation, two new helper families, and a real release
pipeline.

**Breaking**

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
  and an *exact* `retryAfter()` instead of an estimate. `PowerThrottle` is
  unchanged.
- **`PowerCache` `{ policy: 'slru' }`** - probation/protected segments, opt-in.
  Under a 500-key one-off scan over a 40-key hot set, 40/40 keys survive with
  `slru` against 0/40 with `lru`.
- **`autoScale.policy`** gains `aimd`, `vegas` and `gradient2` alongside the
  existing `ewma` default.
- Every resource-owning class gained `dispose()` and `[Symbol.dispose]`, so
  `using` and `await using` work throughout.

**Fixed**

The ones that could bite an existing user:

- `PowerPool` resurrected itself after `shutdown()` and after
  `stopThePress({ recreateWorkers: false })`, orphaning worker threads that
  pinned the process forever. `recreateWorkers: false` was a no-op.
- A duplicate `correlationId` orphaned a pending promise forever and leaked its
  timer, reachable from `postMessageBatch` with a `correlationIdFactory`.
- `PowerScheduler` turned an async `flushFn` rejection into an unhandled
  rejection instead of calling `onError`.
- `PowerRateLimit.tryConsume` could throw *and* leave its limiters partially
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

**Added**

- **`PowerEventLoopMonitor`** — a latency number going up does not tell you
  whether *your* code got slower or the host was busy, and the two need
  different fixes. It measures timer drift (a probe scheduled `intervalMs` out;
  the gap when it actually runs is the loop having been unavailable) into a
  [`PowerHistogram`](./guides/powerEventLoopMonitor.md), and reports Node's
  `eventLoopUtilization()` where the runtime has it. `utilization()` returns
  `null` — never `0` — where it cannot be measured, and Node's `perf_hooks` is
  reached through an opaque dynamic import so a browser bundle never tries to
  resolve a Node builtin. Internal timer is `unref()`d, so a monitor you forget
  to dispose cannot hang a CLI.

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
- `PowerTimedCache.set`/`has`/`startCleanup` were declared with *required*
  parameters, so the two-argument `timed.set(k, v)` failed with "Expected 3
  arguments, but got 2".
- `PowerCache` accepted `defaultAsyncTimeout`, `onError` and `policy` at
  runtime but omitted all three from its options type — a duplicated JSDoc list
  had drifted from the `PowerCacheOptions` typedef it duplicated. There is now
  one source of truth.
- Every class with a disposal method was emitting `[x: number]: () => void;` —
  a numeric *index signature* — into the shipped declarations, which made
  `using cache = new PowerCache()` fail to type-check and left `dispose()`
  missing entirely.
- `o2u8`'s second parameter is now documented and optional.
- `PowerWebSocketClient.readyState` is typed `0 | 1 | 2 | 3` rather than
  depending on the `lib.dom` alias `WebSocketReadyState`.
