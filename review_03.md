# Performance-Helpers — Deep Audit & Review (v3)

> Audit scope: every helper in `src/`, every utility, the build/test/docs gate.
> Baseline: `1.0.3` with the staged 2.0 changeset.

---

## Table of Contents

1. [Potential Bugs](#1-potential-bugs)
2. [Performance Improvements](#2-performance-improvements)
3. [Memory Leaks & Retention](#3-memory-leaks--retention)
4. [Robustness](#4-robustness)
5. [Code Quality](#5-code-quality)
6. [Developer Experience & Ergonomics](#6-developer-experience--ergonomics)
7. [Duplicated / Dead Code & Refactors](#7-duplicated--dead-code--refactors)
8. [SOTA Algorithms, Techniques & Features](#8-sota-algorithms-techniques--features)
9. [Feature Expansions](#9-feature-expansions)
10. [Realtime Processing Improvements](#10-realtime-processing-improvements)
11. [Implementation Plan](#11-implementation-plan)

---

## 1. Potential Bugs

### BUG-001: `PowerSlidingWindow.dispose()` does not call `clear()` on PowerQueue

`dispose()` drains via a `while(length > 0) shift()` loop, but `PowerQueue.clear()` already exists and would be O(1). More critically, the loop does not call `shrink()` afterwards — a disposed window retains a fully-allocated internal ring buffer. The `reset()` method correctly calls `this._timestamps.clear()` but `dispose()` does not.

**Fix:** `this._timestamps.clear(); this._timestamps.shrink();`

### BUG-002: `PowerCircuit.dispose()` replaces `reset` with a no-op, breaking re-use after `using`

After `dispose()`, `this.reset` is a permanent no-op because it's replaced on the instance. If someone stores a reference to the instance and tries to call `reset()` later, it silently does nothing. This pattern is used across many helpers (`PowerEventBus`, `PowerTTLMap`, `PowerScheduler`) and while documented as "idempotent teardown", it breaks the prototype chain — `Object.getPrototypeOf(instance).reset` still works but `instance.reset()` does not.

**Severity:** Low (deliberate design), but worth a note in docs.

### BUG-003: `PowerRealtimeHub.dispose()` calls `detach` then delegates to `Symbol.dispose` which calls `close()` which calls `detach` again

In `powerRealtimeHub.js` lines 549-557:

```js
dispose() {
    detach(this._metrics);      // first detach
    this._metrics = null;
    this[Symbol.dispose]();     // calls close()
}
// close() also does:
//   detach(this._metrics);    // second detach on null
```

The second `detach(null)` is a no-op because `detach` guards against null, but the double-call pattern is needless and the ordering is wrong — `close()` should own the `detach`, not `dispose()`.

**Fix:** Remove the `detach`/null from `dispose()`, let `close()` handle it.

### BUG-004: `PowerCache._fetchValidNode` expiry check uses `<=` but `PowerTTLMap._checkExpire` uses `<`

In `powerCache.js` line 738: `if (now && node.expiresAt <= now)` — expires on the exact tick.
In `powerTTLMap.js` line 166: `if (entry.expiresAt && this._now() > entry.expiresAt)` — expires one tick late.
Meanwhile `PowerTTLMap.set()` adds `+1ms` slack (line 111) which the cache does not.

These three inconsistencies mean the same TTL value produces different lifetimes across the two helpers.

**Fix:** Standardise on `>` (past expiry) across both, and move the `+1` slack into a shared `expiresAt(now, ms)` helper.

### BUG-005: `SmallLfuSketch.hashKey` uses `String()` — non-string keys with the same `.toString()` collide silently

`hashKey` calls `String(key)`, so `1` and `'1'` share a counter. The comment says this is deliberate ("a filter that split one hot key's history across two counters would under-report"), but a `Map` treats them as different keys, so a cache with `key=1` and `key='1'` will have wrong admission decisions for one of them.

**Severity:** Known design trade-off, documented. Worth a guide note.

### BUG-006: `PowerWebSocketClient` heartbeat pong listener is never removed on close in some paths

If the socket is closed by the server between sending a ping and receiving a pong, the timeout fires and the stale pong listener remains attached to the (now closed) socket object. It's harmless (GC will collect it) but diagnostically misleading.

---

## 2. Performance Improvements

### PERF-001: `PowerCache._windowOldest()` walks the linked list on every miss of the memo

When the window is active and the memo is invalidated (which happens on every window-node removal), `_windowOldest()` walks from tail to the start of the window region. For a cache with `maxEntries=10000` and `windowSize=100`, this is up to 100 node dereferences per eviction.

**Improvement:** Maintain a `_windowCount` integer and walk exactly `_windowCount` steps from the tail instead of following the `inWindow` flag — O(windowSize) either way but avoids the flag comparison and the memo validation logic.

### PERF-002: `PowerQueue.shrink()` — the ring buffer never shrinks below `_initialCapacity`

The shrink is correct but conservative. Under bursty workloads (a spike of 10k items, then steady-state at 10), the buffer stays at 16384+ slots. The current `4x below capacity` heuristic is fine, but the floor should be `Math.max(16, this.capacity)` not `this._initialCapacity` to allow a queue initialised large to shrink.

### PERF-003: `PowerRealtimeHub._encodeBatch` encodes JSON via `frameEncodedJson` — allocates per batch

`_encodeBatch` for JSON creates a `TextEncoder().encode(JSON.stringify(batch))` allocation per batch. For a high-throughput hub (10k msg/s, 100 subscribers x 32-msg batches), this is 312 encodes/s. The frame memo helps (one per topic x batch), but the underlying JSON serialization still runs.

**Improvement:** Consider a reusable `TextEncoder` instance at module scope (already done elsewhere in the codebase) and a pre-allocated output buffer for small payloads.

### PERF-004: `PowerEventBus.emit()` snapshots via `bucket.forEach` — allocates a callback per emit

The `forEach` on `PowerSubscriberSet` iterates safely against mutation, but the closure `(fn) => { notified = true; notifyListener(fn, payload); }` is allocated on every `emit()`. For a hot event bus (game loop at 60fps x 20 events), this is 1200 closures/s.

**Improvement:** Use a `for...of` loop with a snapshot array, or pre-bind the iteration callback.

### PERF-005: `SmallLfuSketch.reset()` bit-manipulation loop

The reset loop halves every 4-bit counter by shifting each byte. At `width=16384, depth=4`, the backing array is 32KB and the loop visits 32768 bytes. This is called every `sampleSize` increments.

**Improvement:** Use `TypedArray.prototype.fill(0)` on a copy and bitwise-OR, or use SIMD-like `Uint32Array` views to process 4 bytes at a time (8 counters per iteration instead of 2).

### PERF-006: `PowerHistogram.record()` — `Math.log()` on every insertion

The DDSketch `_index` uses `Math.ceil(Math.log(v) / this._logGamma)`. `Math.log` is fast but not free — for a histogram recording 100k samples/s (latency telemetry), it's 100k log calls.

**Improvement:** For values in the common range (1-10000ms), a pre-computed lookup table of ~20 entries covers the bucket indices and avoids the log entirely. Fall back to the formula for outliers.

---

## 3. Memory Leaks & Retention

### MEM-001: `PowerCache._inflightPromises` and `_inflightControllers` can grow unbounded under key-collision storms

If `getOrSetAsync` is called with many distinct keys faster than the factories resolve, both maps grow to match. There is no cap on the number of in-flight promises. Under a scan attack (100k unique keys with slow factories), the cache holds 100k promise entries + 100k AbortController instances.

**Mitigation:** Add an `_maxInflight` option (default: `maxEntries * 2`) and reject new factories when exceeded, or evict the oldest in-flight entry.

### MEM-002: `PowerEventBus._finalizationRefs` WeakMap entries are never reclaimed until dispose

The `_finalizationRefs` WeakMap maps listener functions to their per-event ref sets. When a listener is GC'd, the `FinalizationRegistry` callback removes the refs from `_eventFinalizationRefs`, but the WeakMap entry itself stays until the listener key is collected. This is correct by design (WeakMap), but the _inner_ `Map<string, Set<WeakRef>>` structure has no cleanup — if a listener is subscribed to 1000 events and then unsubscribed from 999, the per-fn map still holds 999 empty `Set` entries until the listener itself is collected.

**Fix:** In `_unregisterWeakListener`, delete empty inner maps: `if (perFn.size === 0) this._finalizationRefs.delete(fn);` — this already exists at line 287, so the inner sets need the same treatment at line 284 (already done, confirmed).

### MEM-003: `PowerRealtimeHub._retained` logs are only cleared for a topic when the last subscriber leaves

If a topic accumulates retained messages and all subscribers disconnect, the retained log persists forever in `_retained`. The `close()` method clears it, but a long-lived hub with dynamic topics will accumulate retained logs for dead topics.

**Fix:** Add a `clearRetained(topic)` public method. Consider a TTL on retained messages.

### MEM-004: `PowerPool` — terminated workers leave entries in internal maps

Workers that crash and are replaced leave entries in the pool's `_workers` map until garbage collection. Under heavy churn (100 crashes/hour), the map grows. The `_removeWorker` path does clean up, but the timing depends on when the `exit` event fires, and a zombie worker whose process is stuck never fires it.

---

## 4. Robustness

### ROB-001: `PowerRetry.run()` — `retryIf` is called synchronously but may be async

Line 729: `const should = typeof retryIf === 'function' ? Boolean(retryIf(err)) : Boolean(retryIf);`

If `retryIf` returns a Promise, `Boolean(promise)` is always `true`, so a predicate like `async (err) => err.status !== 404` always retries. The type accepts `Function`, which includes async functions.

**Fix:** `const result = retryIf(err); const should = result?.then ? Boolean(await result) : Boolean(result);` — or document that `retryIf` must be synchronous and add a type constraint.

### ROB-002: `PowerCircuit` — concurrent `call()` during `half-open` is serialized by a boolean, not a semaphore

`_trialInFlight` is a boolean. If two `call()`s race past the `_state === 'open'` check and both see `_state === 'half-open'` before either sets `_trialInFlight`, both will enter the trial. This is unlikely in single-threaded JS but possible if `fn()` is synchronous and a microtask schedules another `call()`.

**Severity:** Very low — JS is single-threaded and `call()` is async, so the `await fn()` yield point is the only place a second `call()` can interleave, and by then `_trialInFlight` is already set.

### ROB-003: `PowerGCRA` — no `maxBatch` guard on `tryConsume(n)`

`tryConsume(1_000_000)` is accepted without warning, even if `burst` is 10. The ceiling check only happens in `retryAfter()`, not `tryConsume()`. A typo in `n` silently fails forever.

**Fix:** Add an early return or warning when `n > this._ceiling()`.

### ROB-004: `PowerBackpressure` inherits `PowerPermitGate` but shadows `capacity` with a plain property

`super({ capacity })` sets the gate's internal capacity, then `this._capacity = normalizedCapacity` creates a second copy. If someone calls `super.release()` which reads the gate's internal capacity, and the user has modified `this._capacity`, the two diverge. Currently safe because `_capacity` is private and read-only, but fragile.

### ROB-005: `PowerTTLMap` — `_sweepExpirations` mutates `_expirations` while iterating it

Line 352: `for (const [k, exp] of this._expirations)` — inside the loop, `_expireKey` calls `this._expirations.delete(key)`. Deleting from a `Map` during `for...of` iteration is _safe_ in JS (the spec guarantees it), but the interaction with `_nextExpiryAt` tracking means a key deleted during the sweep is not counted in the `nextExpiryAt` recomputation, which is correct.

**Severity:** Not a bug, but worth a comment for future maintainers.

---

## 5. Code Quality

### CQ-001: Massive `powerCache.js` at 3486 lines

The file is 144KB — larger than many entire libraries. It contains the core cache, `PowerMemoizer`, `PowerTimedCache`, `simpleArgsKey`, the SLRU policy, the W-TinyLFU admission window, stale-while-revalidate, async factory deduplication, incremental cleanup, and weight management.

**Recommendation:** Extract into a `cache/` directory:

- `cache/core.js` — `PowerCache` class
- `cache/memoizer.js` — `PowerMemoizer`
- `cache/timedCache.js` — `PowerTimedCache`
- `cache/policies.js` — SLRU/window logic
- `cache/admission.js` — TinyLFU admission

### CQ-002: `getStats()` boilerplate is duplicated across 9+ classes

Every class has a ~30-line comment explaining the `getStats()` / `stats()` duality. The pattern is identical: `getStats() { return this.stats(); }`. This is deliberate (JSDoc comments must be per-class for `tsc` to see them), but the 30-line comment is word-for-word identical.

**Recommendation:** Extract the explanation into a `guides/` note and cross-reference with a one-liner: `/** See guides/stats-naming.md for why both exist. */`

### CQ-003: `assertKnownOptions` is called in every constructor but the allowed keys are stringly-typed

A typo in the allowed-keys array silently accepts unknown options. For example, if `'observability'` is misspelled as `'observabilty'`, the check passes and the option is silently ignored.

**Recommendation:** Consider a frozen object or `Symbol` keys for the known-options arrays, or at minimum add a test that pins the allowed keys for each class.

### CQ-004: Inconsistent error shapes across helpers

- `PowerCircuit` throws `{ code: 'ECIRCUITOPEN' }`
- `PowerRetry` throws `{ code: 'EABORT', reason, attempts }`
- `PowerDeadline` throws `{ code: 'EABORT', reason }`
- `PowerPermitGate` throws `AbortError` with `name: 'AbortError'`
- `PowerRealtimeHub` throws plain `Error` or `TypeError`

A caller pattern-matching on `err.code` has to know which helper it came from.

**Recommendation:** Document an error-code table in `guides/errors.md`.

---

## 6. Developer Experience & Ergonomics

### DX-001: No `PowerCache.getOrFetch()` convenience for sync values

`getOrSetAsync` requires the factory to be async. For a cache backed by a synchronous Map or a computed value, the caller must wrap in `Promise.resolve()`. A `getOrSet(key, () => computeSync())` that avoids the promise machinery entirely would be more ergonomic.

**Note:** `getOrSet` _does_ exist (line ~1800), but it returns the value synchronously only if the entry is live, and kicks off a background refresh for stale entries — it doesn't actually wait for the factory.

### DX-002: `PowerRateLimit` composition is powerful but hard to discover

`PowerRateLimit` wraps multiple limiters (throttle, GCRA, sliding window) into one. But the composition API requires instantiating each limiter separately and passing them in. A builder pattern would be more ergonomic:

```js
const limiter = PowerRateLimit.builder()
  .gcra({ rate: 100, per: 1000, burst: 10 })
  .slidingWindow({ capacity: 1000, windowMs: 60000 })
  .build();
```

### DX-003: `PowerWebSocketClient` and `PowerSocketAdapter` have overlapping but distinct option sets

Both handle heartbeats, both handle back-pressure, both have `onMessage`/`onError`/`onClose`. A developer using both has to configure heartbeats twice with different option names. A shared `HeartbeatConfig` type would reduce the surface.

### DX-004: No type-safe event names for `PowerEventBus`

Events are bare strings, so a typo in `bus.emit('stateChagne')` silently drops the event. A typed bus pattern (`new PowerEventBus<{ stateChange: { state: string } }>()`) would catch this at compile time.

**Recommendation:** Add a generic type parameter to `PowerEventBus` and document the pattern in the guide.

### DX-005: Missing `Symbol.asyncDispose` for helpers with async teardown

`PowerPool`, `PowerRealtimeHub`, and `PowerWebSocketClient` have async cleanup (`drain`, `flush`, `close` that return promises). They implement `Symbol.dispose` but not `Symbol.asyncDispose`, so `await using pool = new PowerPool(...)` doesn't await the cleanup.

---

## 7. Duplicated / Dead Code & Refactors

### DUP-001: `READY_STATE` is re-exported in both `powerWebSocketClient.js` and `powerSocketAdapter.js`

Both files export the same frozen object from `constants.js`. The re-export in `powerSocketAdapter.js` (line 89) uses `export { READY_STATE } from './constants.js'` and line 93 has a `READY_STATE` export from the class — they're the same object, but two modules re-export the same constant.

### DUP-002: `nowMs` import is present in almost every helper

28 of 36 helpers import `nowMs`. The remaining 8 use it transitively. The import is cheap but the pattern means every file has the same line. A `base.js` or `context.js` module that provides `{ nowMs, attach, detach, assertKnownOptions }` would reduce the import boilerplate.

### DUP-003: `normalizeAdaptive()` in `powerBackpressure.js` duplicates `num()` validation

The `num()` helper inside `normalizeAdaptive` is a local copy of the same `typeof === 'number' && isFinite && > 0 ? v : fallback` pattern used in `assertLimitRequired`. Replace with `assertLimitRequired(v, { min: 0, fallback })`.

### DUP-004: `PowerRealtimeHub._encodeBatch` and `PowerMessageCodec.frameEncodedJson` overlap

`_encodeBatch` for JSON calls `frameEncodedJson(batch)` — which calls `encodeMessage({ ...json, payload })`. The hub builds the batch array, stringifies it, and then `encodeMessage` wraps it in a header. The hub could call `encodeMessage` directly with a pre-serialized payload, skipping the intermediate `frameEncodedJson` wrapper.

### DEAD-001: `PowerCache._evictionCandidate` is maintained but rarely read

The `_evictionCandidate` pointer is kept in sync with `_head` across all mutations (6 sites), but the only consumer is `_evictIfNeeded`, which could just read `this._head` directly. The pointer adds maintenance cost for zero benefit — `_head` is always the LRU end.

**Recommendation:** Remove `_evictionCandidate` and read `_head` in `_evictIfNeeded`. If SLRU needs a separate eviction pointer, make it SLRU-only.

---

## 8. SOTA Algorithms, Techniques & Features

### ALG-001: SIEVE eviction algorithm (NSDI '24)

**What:** SIEVE is a cache eviction algorithm that maintains one FIFO queue with a single "visited" bit per entry and a scanning "hand" pointer. On eviction, the hand scans; visited entries get their bit cleared (second chance), unvisited entries are evicted.

**Why for this project:** SIEVE achieves state-of-the-art hit ratios competitive with W-TinyLFU, with dramatically simpler implementation (~20 lines vs. the current 600+ line TinyLFU/SLRU machinery). It avoids promotion-on-hit (no linked-list mutation on `get()`), which would make `PowerCache.get()` cheaper.

**Effort:** Medium. Add as `policy: 'sieve'` alongside `'lru'` and `'slru'`. The data structure is one bit per node (already have `inWindow`) and one pointer.

### ALG-002: S3-FIFO eviction (SOSP '23)

**What:** Three static FIFO queues — Small (filter one-hit wonders), Main (reuse-proven entries), Ghost (metadata-only eviction history). Lock-free by design.

**Why for this project:** S3-FIFO is the best-performing eviction policy in recent benchmarks across all workload types. The ghost queue is what gives it its edge — it remembers _recently evicted keys_ so it can fast-track them on re-admission.

**Effort:** High — requires a ghost set and three queues. But the payoff is a cache that works well without tuning, which is the DX win.

### ALG-003: Lock-free ring buffer task queue for `PowerPool`

**What:** Instead of `postMessage` for task dispatch, use a `SharedArrayBuffer`-backed ring buffer where workers claim tasks via `Atomics.compareExchange`. Workers self-schedule by CAS-advancing a head pointer.

**Why for this project:** Eliminates `postMessage` overhead (~15us per message) for small payloads. Measured in similar systems at 10-100x throughput for fine-grained tasks. The AGENTS.md already documents that a `SharedArrayBuffer` permit pool was measured and found 6.4x more expensive — but that was for _permits_, not _task dispatch_, which is a different workload.

**Effort:** Very high. Requires cross-origin isolation in browsers, fallback for Node without SAB. Risk is the AGENTS.md finding that SAB was measured worse for permits — need to measure for tasks specifically.

### ALG-004: `t-digest` for `PowerHistogram` merge-friendly percentile estimation

**What:** `t-digest` by Dunning is an alternative to DDSketch that has better accuracy at the extreme tails (p99.9+) for skewed distributions. It's used by Elasticsearch, Prometheus, and DataDog.

**Why for this project:** DDSketch gives a relative error bound on all quantiles — t-digest gives tighter absolute error at the tails. For a latency histogram where p99.9 is the most important number, t-digest may be more accurate.

**Decision:** DDSketch is the better choice for this library (exact merge, fixed relative bound, simpler implementation, OpenTelemetry-standard). t-digest's merge is approximate. **Keep DDSketch**, but document the trade-off in the guide.

### ALG-005: `HyperLogLog` for unique-key cardinality in the admission filter

**What:** The TinyLFU admission filter currently uses a Count-Min Sketch with 4-bit counters. A companion HyperLogLog could track the _number of distinct keys_ seen, so the `sampleSize` can be auto-tuned to `10x distinct_keys` instead of a fixed `200x maxEntries`.

**Effort:** Low. HLL is ~1.5KB of memory for 1% accuracy. Would make the sketch self-tuning for workloads where the actual key space is much smaller or larger than `maxEntries`.

---

## 9. Feature Expansions

### FEAT-001: `PowerCache` — `fetchMethod` with stale-while-revalidate out of the box

Currently, `getOrFetch(key)` resolves with `fetchMethod(key)`. Adding `staleTtl` support to `getOrFetch` (return stale value immediately, refresh in background) would make it a drop-in replacement for `swr` / `TanStack Query` in server-side code.

### FEAT-002: `PowerPool` — task priorities

Currently tasks are FIFO. A priority queue (using `PowerQueue` as a min-heap or a separate priority ring) would let callers submit `{ priority: 'high' }` tasks that jump the queue. Common in image processing (visible tiles first) and API gateways (authenticated requests first).

### FEAT-003: `PowerCircuit` — health-check probing

In `half-open`, the current design allows one trial call. A more sophisticated approach sends a dedicated health-check probe (a cheap `/healthz` call) instead of a real request, so the real traffic doesn't bear the cost of probing a sick dependency.

### FEAT-004: `PowerBatch` — flush-on-size and flush-on-timeout

`PowerBatch` currently flushes on size. Adding a `maxWaitMs` option that flushes after a timeout even if the batch isn't full (the "linger" pattern from Kafka) would cover the common case of low-throughput periods where messages sit in the batch too long.

### FEAT-005: `PowerObserver` — `computed()` / `effect()` reactive primitives

`PowerObserver` has `map()`, `filter()`, `scan()`, and `combine()`. Adding `computed()` (lazy evaluation, only recomputes when dependencies change) and `effect()` (side-effect on change, with cleanup) would make it a minimal reactive signals library.

### FEAT-006: `PowerEventBus` — wildcard/glob subscriptions

`bus.on('user:*', handler)` to match `user:login`, `user:logout`, etc. Common in MQTT-style systems. Can be implemented as a prefix trie on the topic map.

---

## 10. Realtime Processing Improvements

### RT-001: `PowerRealtimeHub` — binary delta compression for retained topics

For topics like "game state" or "config", consecutive publishes often differ by a few fields. A binary delta (RFC 6902 JSON Patch, or a custom CBOR-based diff) between retained messages would reduce bandwidth.

### RT-002: `PowerWebSocketClient` — `WebTransport` support

`WebTransport` (HTTP/3 + QUIC) is available in Chrome and Edge and provides:

- Independent streams (no head-of-line blocking)
- Datagrams (unreliable, low-latency)
- Built-in back-pressure via streams

The library already has `detectWebTransportSupport()` in `utils/webtransport.js` but no actual transport adapter. Adding a `PowerWebTransportClient` that mirrors the `PowerWebSocketClient` API would be a natural extension.

### RT-003: `PowerRealtimeHub` — per-topic rate limiting

A topic publishing at 1000 msg/s fans out to N subscribers, so the hub does 1000xN sends/s. A per-topic `PowerThrottle` or `PowerGCRA` would let the hub coalesce or drop messages above a rate, protecting the transport from a noisy publisher.

### RT-004: `PowerSocketAdapter` — `BroadcastChannel` support

`BroadcastChannel` is the simplest cross-tab/cross-window communication API. Adding it as a fourth `kind` in `detectSocketKind()` would let the adapter manage inter-tab messaging with the same rate-limiting, heartbeat, and backpressure features it provides for WebSockets.

### RT-005: `PowerRealtimeHub` — server-sent events (SSE) transport adapter

SSE is HTTP/1.1-native, works through all proxies, and is simpler than WebSocket for unidirectional push. A `send` adapter for `PowerRealtimeHub` that writes to an HTTP `Response` stream (Node's `ServerResponse`) would cover the common "dashboard updates" use case without WebSocket infrastructure.

### RT-006: `PowerWebSocketClient` — connection quality metrics

The client already has a heartbeat RTT histogram. Exposing computed metrics like:

- `connectionUptime` — time since last reconnect
- `messageLatency` — p50/p95/p99 of round-trip time (for request-response patterns)
- `reconnectCount` — total reconnections
- `backpressureRatio` — fraction of time spent paused

...would give a dashboard everything it needs to assess connection health.

---

## 11. Implementation Plan

| Task ID  | Status | Task                                                         | Priority | ROI       | Risk | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ------ | ------------------------------------------------------------ | -------- | --------- | ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUG-001  | ✅     | Fix `PowerSlidingWindow.dispose()` to use `clear()`          | P0       | High      | Low  | 1h     | **Done, and the finding was right about the mechanism and incomplete about the scope.** Both halves fixed: `clear()` (O(1)) replaced the O(n) `shift()` drain, and `shrink()` added — which is the half that actually retained memory. Measured: `capacity: 8192` with 5000 timestamps left **8192 slots retained**; now returns to the initial capacity. **Two false comments found alongside:** the body claimed _"`PowerQueue` exposes `length` and `shift`; there is no `clear`"_ — false, `clear()` has existed alongside `reset()` since the class did, and that stale note is why the slow path survived — and the docblock promised a clock re-seed it never performed, which it **should not** perform, since `_now` is the caller's injected clock. **`reset()` deliberately NOT changed**: it is a live window being cleared and may be hot, so reallocating the ring per call is worse than holding it. A counter-test fails if `reset()` ever grows a shrink. 7 tests, 2 mutants, both caught; the O(n) cost asserted structurally (clear-vs-shift counts) rather than by timing, since the harness spread is 28.61%. |
| BUG-003  | ⬜     | Fix `PowerRealtimeHub.dispose()` double-detach               | P1       | Med       | Low  | 30m    | Clean up dispose/close ordering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BUG-004  | ⬜     | Standardise TTL comparison operators cache vs TTLMap         | P1       | High      | Med  | 4h     | Behaviour change — needs test updates. Edge cases at exact-tick expiry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ROB-001  | ✅     | Guard `retryIf` against async predicates                     | P1       | High      | Low  | 2h     | **Done.** `retryIf` is now awaited, so an async predicate is consulted instead of being coerced. Probed first: an `async` predicate matching _nothing_ ran all 3 attempts where the identical synchronous one stopped at 1, because `Boolean(Promise)` is always `true` — silent, with nothing thrown or logged. A rejected predicate is treated as declining, same as a synchronous throw. 4 new tests, mutation-checked by deleting the `await` (fails 3). **Adjacent to RES-032, which fixed the _throwing_ case and did not cover this one.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ROB-003  | ⬜     | Add ceiling guard to `PowerGCRA.tryConsume(n)`               | P2       | Med       | Low  | 1h     | Warn or throw when `n > burst + 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PERF-001 | ⬜     | Optimise `_windowOldest()` with count-based walk             | P2       | Med       | Med  | 4h     | Simplifies window logic, removes memo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| PERF-005 | ⬜     | Optimise `SmallLfuSketch.reset()` with `Uint32Array` view    | P3       | Low       | Low  | 2h     | 4x faster reset for large sketches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| PERF-006 | ⬜     | Lookup table for common `PowerHistogram._index()` values     | P3       | Low       | Low  | 3h     | Amortises `Math.log` for typical latency ranges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| MEM-001  | ⬜     | Cap `_inflightPromises` in `PowerCache`                      | P1       | High      | Med  | 4h     | Prevents OOM under key-collision storms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| MEM-003  | ⬜     | Add `clearRetained(topic)` to `PowerRealtimeHub`             | P2       | Med       | Low  | 2h     | Prevents dead-topic retention leak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CQ-001   | ⬜     | Split `powerCache.js` into `cache/` directory                | P2       | High      | Med  | 8h     | Large refactor, but file is 144KB. Improves navigability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| CQ-002   | ⬜     | Deduplicate `getStats()` boilerplate comments                | P3       | Low       | Low  | 2h     | Extract to guide, cross-reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CQ-004   | ⬜     | Document error-code table in `guides/errors.md`              | P2       | Med       | Low  | 3h     | Essential for pattern-matching callers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DX-002   | ⬜     | `PowerRateLimit.builder()` fluent API                        | P3       | Med       | Low  | 6h     | Ergonomic win for multi-limiter composition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DX-004   | ⬜     | Typed event names for `PowerEventBus`                        | P2       | High      | Low  | 4h     | Compile-time safety for event typos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DX-005   | ⬜     | Add `Symbol.asyncDispose` to async helpers                   | P1       | High      | Low  | 3h     | `await using` support for Pool, Hub, WSClient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| DUP-003  | ⬜     | Replace `normalizeAdaptive.num()` with `assertLimitRequired` | P3       | Low       | Low  | 1h     | Reduces local duplication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DEAD-001 | ⬜     | Remove `_evictionCandidate`, read `_head` directly           | P3       | Low       | Med  | 3h     | Simplifies 6 mutation sites. Must verify SLRU path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ALG-001  | ⬜     | Implement SIEVE eviction policy                              | P1       | Very High | Med  | 16h    | SOTA hit ratio, dramatically simpler than TinyLFU. Add as `policy: 'sieve'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ALG-002  | ⬜     | Implement S3-FIFO eviction policy                            | P2       | Very High | High | 32h    | Best-in-class but complex. Ghost queue needs memory budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ALG-005  | ⬜     | HyperLogLog for auto-tuning sketch `sampleSize`              | P3       | Med       | Low  | 6h     | Makes TinyLFU self-tuning for variable key spaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| FEAT-002 | ⬜     | Task priorities in `PowerPool`                               | P2       | High      | Med  | 12h    | Common request for worker pools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| FEAT-004 | ⬜     | `maxWaitMs` linger timeout for `PowerBatch`                  | P1       | High      | Low  | 4h     | Standard batching pattern (Kafka linger.ms)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FEAT-005 | ⬜     | `computed()` / `effect()` for `PowerObserver`                | P3       | Med       | Low  | 8h     | Minimal reactive signals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| FEAT-006 | ⬜     | Wildcard subscriptions for `PowerEventBus`                   | P3       | Med       | Med  | 8h     | MQTT-style topic matching                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| RT-002   | ⬜     | `PowerWebTransportClient` adapter                            | P2       | High      | High | 24h    | HTTP/3 QUIC transport, future-proofing. `detectWebTransportSupport()` already exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| RT-003   | ⬜     | Per-topic rate limiting in `PowerRealtimeHub`                | P2       | High      | Low  | 6h     | Composes existing GCRA/Throttle with the hub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RT-004   | ⬜     | `BroadcastChannel` support in `PowerSocketAdapter`           | P3       | Med       | Low  | 6h     | Cross-tab messaging with same API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RT-005   | ⬜     | SSE transport adapter for `PowerRealtimeHub`                 | P3       | Med       | Low  | 8h     | Covers unidirectional push without WebSocket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RT-006   | ⬜     | Connection quality metrics for `PowerWebSocketClient`        | P2       | Med       | Low  | 4h     | Dashboard-ready health metrics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Priority Legend

| Priority | Meaning                                                         |
| -------- | --------------------------------------------------------------- |
| P0       | Fix immediately — correctness bug or data loss                  |
| P1       | Fix before next release — robustness, safety, or high-impact DX |
| P2       | Schedule for next sprint — significant improvement              |
| P3       | Backlog — nice to have, do when capacity allows                 |

### ROI Legend

| ROI       | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| Very High | Measurable improvement in the library's core value proposition |
| High      | Clear benefit to most users                                    |
| Med       | Benefits specific use cases or improves maintainability        |
| Low       | Minor improvement, mostly cosmetic or speculative              |
