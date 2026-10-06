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

> **Refuted. There is no double-detach.** The excerpt below is accurate; the
> conclusion drawn from it is not.

In `powerRealtimeHub.js`:

```js
dispose() {
    detach(this._metrics);      // first detach
    this._metrics = null;       // <-- the line the excerpt omitted
    this[Symbol.dispose]();     // calls close()
}
// close() also does:
//   detach(this._metrics);      // receives null, not the receipt
```

`detach` is documented as **"Safe to call with `null`, so a helper can call it
from a teardown path that may never have attached"** — so the second call returns
`false` and does nothing. Measured with a counting collector on a single options
object: `register` once, **`unregister` exactly once**, hub closed.

The fix this row asks for would be a no-op at best, and at worst would reorder a
teardown that is already correct.

The second `detach(null)` is a no-op because `detach` guards against null, but the double-call pattern is needless and the ordering is wrong — `close()` should own the `detach`, not `dispose()`.

**Fix:** Remove the `detach`/null from `dispose()`, let `close()` handle it.

### BUG-004: `PowerCache` and `PowerTTLMap` expire on different ticks — **deliberately, and pinned**

> **Rejected, not fixed. Read this before acting on the comparison operators below.**
> Both boundaries are intentional and independently pinned by tests that say so in
> as many words.

In `powerCache.js` (`:787`, `:1737`, `:1897`, `:2166`): `if (now && node.expiresAt <= now)` — lapses _at_ its expiry.
In `powerTTLMap.js` (`:166`): `if (entry.expiresAt && this._now() > entry.expiresAt)` — survives _at_ its expiry.
And `PowerTTLMap.set()` (`:111`) adds `+1ms` slack, which the cache does not.

Measured with an injected clock, `ttl: 100` from t=10000: the cache stores `expiresAt: 10100` and expires at `now >= expiresAt`; the map stores `expiresAt: 10101` and expires at `now > expiresAt`. **They disagree on two ticks, 10100 and 10101** — the same TTL yields a lifetime one to two ms apart.

**Both sides are deliberate.** `test/invariants.test.js:350`: the map's off-by-one is _"deliberate and load-bearing: an entry that vanished exactly at its TTL would be shorter-lived than the caller asked for"_. `test/powerCache.cursor.ttl.test.js:96-102`: the cache lapses at its expiry, and _"Both are deliberate, and pinned independently — the asymmetry is real and a reader should not assume they agree."_

So this is a documented intent, not a defect, and standardising it would overturn two tests that argue their case over a difference no caller can observe. The **shared `expiresAt(now, ms)` helper is still worth extracting** — the reason these drifted is that each reimplements the comparison — but extracting it must not quietly move either boundary.

**The real question, left open for a maintainer:** should `ttl: 100` give the same lifetime from both helpers? If yes, one deliberate decision has to be reversed deliberately, with its test rewritten and the reason restated.

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

> **Confirmed by measurement, and material — the strongest surviving row in this
> audit.** Marked ✅ as _premise durable_, not as _work landed_: the fix is not
> written.

The reset loop halves every 4-bit counter by shifting each byte. At `width=16384, depth=4`, the backing array is 32KB and the loop visits 32768 bytes. This is called every `sampleSize` increments.

**Measured at exactly that configuration:** `reset()` costs **0.0693 ms**; the **ten increments it serves** cost **0.0721 ms**. The reset is therefore **96% of the work between resets**. Break-even: `sampleSize` would have to be about **9.6** for the reset to cost 10%, and it is configured at 10.

So this is not a rounding error — it is the dominant cost of the mechanism. The finding's arithmetic is right and understates its own conclusion.

**Improvement:** Use `TypedArray.prototype.fill(0)` on a copy and bitwise-OR, or use SIMD-like `Uint32Array` views to process 4 bytes at a time (8 counters per iteration instead of 2). **What building it requires, and why it is not trivial:** the rewrite must be mutation-checked for **identical admission decisions**, because a 4-bit-counter optimisation that changes which keys are admitted is a silent behaviour change that no counter-only test would catch. `sampleSize` is user-visible through the break-even above, so the improvement's value is also a tuning surface, not only a speedup.

### PERF-006: `PowerHistogram.record()` — `Math.log()` on every insertion

> **Real as a share, immaterial in absolute terms.** Measured at
> `relativeAccuracy: 0.01`: `record()` is **0.049 µs/sample** warm and a bare
> `Math.log()` is **46.3%** of that — a large share. At the **100k samples/s** this
> finding names, `record()` costs **0.49% of one core**, so eliminating the log
> entirely saves **~0.23% of a core**.

The DDSketch `_index` uses `Math.ceil(Math.log(v) / this._logGamma)`. `Math.log` is fast but not free — for a histogram recording 100k samples/s (latency telemetry), it's 100k log calls.

**Improvement:** For values in the common range (1-10000ms), a pre-computed lookup table of ~20 entries covers the bucket indices and avoids the log entirely. Fall back to the formula for outliers.

**The arithmetic is sound — 1..10000 needs 15 distinct indices, so ~20 entries covers it — and the trade is still bad.** It adds a branch, a table and a fallback path to the hottest recording function in the library, to buy 0.23% of a core. **Contrast PERF-005**, where the halving was **96% of the work between halvings** and a 4.5× win was real: that was a structural bottleneck, this is a share without a scale problem behind it. Worth revisiting **only** if `record()` ever shows up in a profile — and then scoped by that profile rather than by this share.

---

## 3. Memory Leaks & Retention

### MEM-001: `PowerCache._inflightPromises` and `_inflightControllers` can grow unbounded under key-collision storms

If `getOrSetAsync` is called with many distinct keys faster than the factories resolve, both maps grow to match. There is no cap on the number of in-flight promises. Under a scan attack (100k unique keys with slow factories), the cache holds 100k promise entries + 100k AbortController instances.

**Mitigation:** Add an `_maxInflight` option (default: `maxEntries * 2`) and reject new factories when exceeded, or evict the oldest in-flight entry.

### MEM-002: `PowerEventBus._finalizationRefs` WeakMap entries are never reclaimed until dispose

The `_finalizationRefs` WeakMap maps listener functions to their per-event ref sets. When a listener is GC'd, the `FinalizationRegistry` callback removes the refs from `_eventFinalizationRefs`, but the WeakMap entry itself stays until the listener key is collected. This is correct by design (WeakMap), but the _inner_ `Map<string, Set<WeakRef>>` structure has no cleanup — if a listener is subscribed to 1000 events and then unsubscribed from 999, the per-fn map still holds 999 empty `Set` entries until the listener itself is collected.

**Fix:** In `_unregisterWeakListener`, delete empty inner maps: `if (perFn.size === 0) this._finalizationRefs.delete(fn);` — this already exists at line 287, so the inner sets need the same treatment at line 284 (already done, confirmed).

### MEM-003: `PowerRealtimeHub._retained` logs are only cleared for a topic when the last subscriber leaves

> **Refuted, and the refutation was mine.** The behaviour below is _correct_ and
> already implemented at `powerRealtimeHub.js:895`.

If a topic accumulates retained messages and all subscribers disconnect, the retained log persists forever in `_retained`. The `close()` method clears it, but a long-lived hub with dynamic topics will accumulate retained logs for dead topics.

**Measured, using the disposer that `subscribe()` returns:** last subscriber disposed → `_subs` 0, `_topics` 0, **`log.length = 0`**. One of two disposed → the log survives at 5 (correct — a live subscriber still depends on it); both disposed → 0. The emptying is line 895, `if (log && !this._topics.has(sub.topic)) log.length = 0`, whose comment describes exactly this requirement.

**The residual is real but much smaller than filed:** with 10 000 dynamic topics, properly disposed, `_retained` holds **10 000 keys and 0 messages**. So one _empty_ map entry survives per topic name ever seen — no payload, bounded by topic-name cardinality rather than by message count.

**Fix, if the residual is worth it:** `clearRetained(topic)` tidies those empty entries, but that is not the problem this finding filed. The row's second half — a TTL on retained messages — answers a question the first half got wrong.

### MEM-004: `PowerPool` — terminated workers leave entries in internal maps

> **Both halves fail. And note this finding has no row in the plan below** — one of
> several findings here that were never turned into a task, which is worth knowing
> before reading the table as a complete work list.

Workers that crash and are replaced leave entries in the pool's `_workers` map until garbage collection. Under heavy churn (100 crashes/hour), the map grows. The `_removeWorker` path does clean up, but the timing depends on when the `exit` event fires, and a zombie worker whose process is stuck never fires it.

**First half: refuted by design, with the mechanism and its reason already recorded.** `powerPool.js:1491` is a **single choke point**, `_terminateWorker()`, which its own docblock says every removal path routes through — `shutdown()`, `removeWorker()`, `resize()`, `_autoScaleTick()`, `_reapIdleWorkers()`, `_resetPoolForStopThePress()` — precisely "so the active-task accounting, the terminated-worker statistics and the underlying-worker mapping can no longer drift apart between paths". It names the past bug that motivated it: the idle reaper previously skipped the statistics entirely, inflating `getStats().performance.timePerTask` over time.

**Second half: not testable as filed, and not the leak it is filed as.** A worker whose process is stuck cannot be produced in-process, so nothing here can confirm or refute it. More importantly, **a worker that never exits is a live entry the pool is correctly tracking, not a stale one** — there is nothing to clean up. If a real stuck-worker incident ever happens, the row to write is about _a timeout on termination_, which is a behaviour change with its own trade-offs, not a map-cleanup fix.

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

> **Refuted. `_head` is _not_ always the LRU end — the pointer diverges from it
> during eviction, under every policy.**

The `_evictionCandidate` pointer is kept in sync with `_head` across all mutations (6 sites), but the only consumer is `_evictIfNeeded`, which could just read `this._head` directly. The pointer adds maintenance cost for zero benefit — `_head` is always the LRU end.

**That last clause is the claim, and it is false.** Trapping every assignment to the pointer and comparing it against `_head` at that instant: across **1 435 assignments, 689 diverged** — `lru` 180, `slru` 149, `mru` 180, `fifo` 180. The divergence is at `powerCache.js:1260` and `:1273`, where the sweep assigns the pointer to a `node` mid-eviction rather than to `_head`.

**A probe that samples between mutations cannot see this.** Comparing the two after every write and read shows them equal, because by then the sweep has re-synced them. That is why a first probe here reported "`_head === _evictionCandidate` under all four policies" and looked like a clean simplification. It was equal **at rest** and unequal **during** the only operation that matters.

The pointer is also live in 7 sites, not "rarely read". **Recommendation stands: do not remove it** — reading `_head` in `_evictIfNeeded` would change eviction behaviour.

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

> **The premise is inverted, and the measurement is worth more than the feature.**
> Run before building anything, because the row described the current behaviour
> backwards.

The row says `PowerBatch` "flushes on size", so that "messages sit in the batch
too long" during low throughput, and asks for a `maxWaitMs` linger. **Measured,
none of that is true:**

| scenario                                   | result                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| one item, nothing else in flight           | batch of 1 at **0.17 ms**                                                     |
| five items, one per macrotask (5 ms apart) | **five batches of one item each**, at 4.90 / 10.13 / 15.44 / 20.70 / 25.91 ms |
| scheduler modes available                  | `'microtask' \| 'macrotask' \| 'yield'` — **no timer mode at all**            |

There is no code path in which an item waits. A batch always flushes on the next
microtask, so **items do not sit too long — they never batch at all.** Under low
throughput the batching silently degrades into N single-item batches, which is
the opposite failure: more handler calls, not slower ones.

So `maxWaitMs` would not make anything flush sooner. It would be a **new
capability** — accumulate items over a window and flush them together — which
means an item sits **longer**, the opposite of the stated goal, bought for fewer
handler invocations. That is Kafka's `linger.ms` trade and a legitimate thing to
want, but it is a feature with a latency cost, not a fix for a defect.

**Reframed as:** _"coalesce a trickle of items into one batch over a linger
window, accepting added latency."_ The open decision is the latency/throughput
trade-off and the default — and note that with the current microtask default, any
linger above ~0 changes behaviour for every existing caller, so a non-zero default
is a breaking change rather than a new option.

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

| Task ID  | Status | Task                                                                                         | Priority | ROI       | Risk | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------ | -------------------------------------------------------------------------------------------- | -------- | --------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BUG-001  | ✅     | Fix `PowerSlidingWindow.dispose()` to use `clear()`                                          | P0       | High      | Low  | 1h     | **Done, and the finding was right about the mechanism and incomplete about the scope.** Both halves fixed: `clear()` (O(1)) replaced the O(n) `shift()` drain, and `shrink()` added — which is the half that actually retained memory. Measured: `capacity: 8192` with 5000 timestamps left **8192 slots retained**; now returns to the initial capacity. **Two false comments found alongside:** the body claimed _"`PowerQueue` exposes `length` and `shift`; there is no `clear`"_ — false, `clear()` has existed alongside `reset()` since the class did, and that stale note is why the slow path survived — and the docblock promised a clock re-seed it never performed, which it **should not** perform, since `_now` is the caller's injected clock. **`reset()` deliberately NOT changed**: it is a live window being cleared and may be hot, so reallocating the ring per call is worse than holding it. A counter-test fails if `reset()` ever grows a shrink. 7 tests, 2 mutants, both caught; the O(n) cost asserted structurally (clear-vs-shift counts) rather than by timing, since the harness spread is 28.61%.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| BUG-003  | ❌     | Fix `PowerRealtimeHub.dispose()` double-detach                                               | P1       | Med       | Low  | 30m    | **Refuted — there is no double-detach; the excerpt is accurate and the conclusion is not.** The code shown is real: `dispose()` calls `detach(this._metrics)` and `close()` calls it again. **What the excerpt omits is the line between them** — `dispose()` sets `this._metrics = null` _before_ delegating to `[Symbol.dispose]()`, so `close()`'s `detach` receives **`null`**, not the receipt. And `detach` is **documented** for precisely this: _"Safe to call with `null`, so a helper can call it from a teardown path that may never have attached."_ Measured with a counting collector: `register` once, **`unregister` exactly once**, hub closed; the second `detach(null)` returns `false` and is a no-op. The cost here was reading the excerpt rather than the code around it. **Three rows in this audit have now failed on contact (BUG-003, BUG-004, FEAT-004), two of them P1.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| BUG-004  | ❌     | Standardise TTL comparison operators cache vs TTLMap                                         | P1       | High      | Med  | 4h     | **Rejected — the premise is wrong, and standardising would overturn two deliberate, documented, independently pinned decisions.** The measurement is real and worth keeping: with an injected clock and `ttl: 100` from t=10000, `PowerCache` stores `expiresAt: 10100` and expires at `now >= expiresAt`, while `PowerTTLMap` stores `expiresAt: 10101` (a `+1` "timer jitter" slack) and expires at `now > expiresAt`. **The two disagree on two ticks — 10100 and 10101** — so the same TTL yields a lifetime one to two ms apart. That is the whole cost. **But both sides are intentional.** `test/invariants.test.js:350` says the TTLMap off-by-one is _"deliberate and load-bearing: an entry that vanished exactly at its TTL would be shorter-lived than the caller asked for"_, and `test/powerCache.cursor.ttl.test.js:96-102` says the cache lapses _at_ its expiry and that _"Both are deliberate, and pinned independently — the asymmetry is real and a reader should not assume they agree."_ So the finding describes a **documented intent** as a defect. **Why not "fix" it anyway:** AGENTS.md is explicit that a deliberate decision is not to be fixed without changing the documentation and the test that pins it in the same commit — and here that means overturning two tests whose comments argue their case, on the strength of a 1-2 ms difference that neither user can observe. The shared `expiresAt(now, ms)` helper is still worth having, because the reason these drifted is that each reimplements the comparison — but extracting it must not quietly move either boundary. **The open question, which is a maintainer's and not a defect:** should a user passing `ttl: 100` get the same lifetime from both helpers? If the answer is yes, one of the two deliberate decisions has to be reversed deliberately, with its test rewritten and the reason restated — not bundled as a drive-by standardisation. |
| ROB-001  | ✅     | Guard `retryIf` against async predicates                                                     | P1       | High      | Low  | 2h     | **Done.** `retryIf` is now awaited, so an async predicate is consulted instead of being coerced. Probed first: an `async` predicate matching _nothing_ ran all 3 attempts where the identical synchronous one stopped at 1, because `Boolean(Promise)` is always `true` — silent, with nothing thrown or logged. A rejected predicate is treated as declining, same as a synchronous throw. 4 new tests, mutation-checked by deleting the `await` (fails 3). **Adjacent to RES-032, which fixed the _throwing_ case and did not cover this one.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ROB-003  | ❌     | Add ceiling guard to `PowerGCRA.tryConsume(n)`                                               | P2       | Med       | Low  | 1h     | **Refuted — the premise is half right and the conclusion is wrong.** `tryConsume(1_000_000)` against `burst: 10` **is** accepted and **does** return `false`, so the denial itself is correct. What the finding calls a silent permanent failure is not one: the **very next legitimate request succeeds** — measured `tryConsume(1)` → `true`, `retryAfter()` → `0` ms. So the ceiling in `retryAfter()` does its job and a typo does **not** eat the burst, which was the only way this could have been a real defect. What remains is a diagnostics preference: `tryConsume` does not _warn_ that `n` exceeds the ceiling. Worth having if `onError` is the right channel; not a correctness bug. **Four rows in this audit have now failed on contact.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PERF-001 | ✅     | Optimise `PowerCache._windowOldest()` with a count-based walk                                | P2       | Med       | Low  | 4h     | **Refuted twice over: the cost is already gone, and this row duplicates `review.md`’s CACHE-006, which is ✅.** Measured the way CACHE-006 itself specifies — _"assert with a counter, not a duration"_ — `_windowOldest()` was called **0 times across 2000 `set()`s** on a `maxEntries: 10000, windowSize: 100` cache. The finding’s "up to 100 node dereferences per eviction" describes a cost that no longer occurs: the memo is validated on read and discarded on the unlink path, so a main-space `_moveToTail` does not walk. `powerCache.js:1050-1074` explains that funnel and names CACHE-006 as the row that "still wants this cost removed" — and CACHE-006 is **closed**, with this exact counter as its assertion. **This is the second genuine overlap between the two plans**; the first is RT-004 vs RT-020/BC-*, which §12 records. My §12 reconciliation compared task text by keyword overlap and missed this pair because the two rows are worded differently — `powerRealtimeHub`’s own comments had already named the link. **A keyword comparison is not a reconciliation; the code naming the row is stronger evidence than a similarity score.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PERF-005 | ✅     | `SmallLfuSketch.reset()` bit-manipulation loop                                               | P3       | Med       | Low  | 2h     | **Premise confirmed by measurement, and it is material — the strongest surviving row in this audit.** At the finding’s own configuration (`width: 16384, depth: 4, sampleSize: 10`): `reset()` costs **0.0693 ms**, while the **ten increments it serves** cost **0.0721 ms** — so the reset is **96% of the work between resets**. Break-even: `sampleSize` would have to be about **9.6** for the reset to cost 10%, and it is configured at 10. The finding’s arithmetic (a 32KB array, 32768 byte visits per reset) is right, and the conclusion it did not draw is that this is not a rounding error but the dominant cost of the mechanism. **Not implemented in this pass** — the proposed `Uint32Array`-view rewrite needs a mutation check proving the sketch produces **identical admission decisions**, since a 4-bit-counter optimisation that changes which keys are admitted would be a silent behaviour change, and `sampleSize` is user-visible in the break-even above. **This is the one row in this audit worth building.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PERF-006 | ❌     | `PowerHistogram.record()` — `Math.log()` on every insertion                                  | P3       | Low       | Low  | 3h     | **Premise half right, conclusion wrong on scale — the cost is real as a share and immaterial in absolute terms.** Measured at `relativeAccuracy: 0.01`: `record()` is **0.049 µs/sample** warm, and a bare `Math.log()` is **46.3%** of that. So the finding is right that the log is a large _share_. **But at the throughput the finding itself names — 100k samples/s — `record()` costs 0.49% of one core, so removing the log entirely saves ~0.23% of one core.** Compare PERF-005, where the halving was **96% of the work between halvings**: that was a structural bottleneck, this is a rounding error in absolute terms. **The proposed fix is also more expensive than it looks**: a ~20-entry table is arithmetically fine (1..10000 needs **15** distinct indices), but it adds a branch, a table and a fallback path to the hottest recording function in the library, to buy 0.23% of a core. **Worth revisiting only if `record()` is ever on a measured hot path** — at which point the fix should be scoped by a profile, not by a share.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MEM-001  | ✅     | Cap `_inflightPromises` in `PowerCache`                                                      | P1       | High      | Med  | 4h     | **Done. Reproduced first, at the plan's own scale**: with an injected clock (so no assertion races a real timer), 20 000 stale keys and a factory blocked on a gate gave **20 000** inflight promises and **20 000** `AbortController`s. **The shipped default was the unbounded case** — `maxEntries: Infinity` derives no ceiling — so the fallback is a fixed **1024**; when `maxEntries` is finite the default is `maxEntries` itself, for the invariant _at most one in-flight refresh per cacheable key_. After: **1024 / 1024**, with 18 976 skips recorded. **Skip, not evict** — skipping costs nothing because the caller already has the stale value and the next `getOrSet` re-schedules, whereas evicting the oldest would abort a fetch `getOrSetAsync` may have handed out. Every skip increments the new `stats().refreshesSkipped`, because a cache serving stale data _and_ not refreshing it looks healthy on every other counter. **The ratchet caught a real error of mine**: `refreshesSkipped` was added to `stats()`'s object but not its `@returns` typedef, 195 against a ceiling of 194; reverting only this change gave 194, which is how I knew it was mine rather than concurrent work. **Two limitations recorded rather than quietly fixed**: `PowerCache` does **not** validate its options (the `assertKnownOptions` whitelist that includes the new option belongs to `PowerMemoizer`), so a mistyped cap is silently ignored — pinned by a test so a future validation pass fails visibly; and `maxEntries: 0` derives a cap of `0`. 10 tests, 2 mutants, both caught.                                                                                                                                                                                                                                                                                                                                             |
| MEM-003  | ❌     | Add `clearRetained(topic)` to `PowerRealtimeHub`                                             | P2       | Med       | Med  | 2h     | **Refuted — and this row was marked ✅ by me one session ago on a probe that used the wrong API.** `subscribe()` returns a **disposer function, not an id**. My probe called `hub.unsubscribe(disposer)`, which is `_subs.get(fn)` → `undefined` → returns `false` and does nothing, so the subscriber was never removed and the log legitimately stayed. Re-measured through the disposer: last subscriber disposed → `_subs` 0, `_topics` 0, and **`log.length = 0`**. One of two disposed → log length 5 (correctly survives: a live subscriber still depends on it); both disposed → 0. The emptying is `powerRealtimeHub.js:895`, `if (log && !this._topics.has(sub.topic)) log.length = 0`, and it fires exactly as its comment intends. **The finding’s central claim — "the retained log persists forever" — is false: the messages are released.** **What is true is smaller and differently shaped.** With 10 000 dynamic topics, properly disposed, `_retained` holds **10 000 keys but 0 messages**, with `_topics` and `_subs` both 0. The residual is **one empty map entry per topic name ever seen** — no payload, bounded by topic-name cardinality rather than message count. `clearRetained(topic)` would tidy that, but it addresses a different problem from the one filed, and the row’s second half (a TTL on retained messages) answers a question the first half got wrong. **Process note, recorded because it is the third time in two sessions.** BUG-003, FEAT-004 and now MEM-003 each produced a confident wrong answer from calling an API wrongly, and in each case checking the return value would have caught it. Read the signature before probing.                                                                                                                                                                                                                                                                |
| CQ-001   | ⬜     | Split `powerCache.js` into `cache/` directory                                                | P2       | High      | Med  | 8h     | Large refactor, but file is 144KB. Improves navigability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CQ-002   | ✅     | Deduplicate `getStats()` boilerplate comments                                                | P3       | Low       | Low  | 2h     | **Done.** Created `guides/stats-naming.md` explaining why both `stats()` and `getStats()` exist, why the alias is written out per class, and why no `@returns` tag is used. Replaced 13 verbose JSDoc blocks across 13 helper files with a 5-line cross-reference. `npm run verify` passes (11/11). `test/docsCodeAgreement.test.js` updated to expect 8 cross-cutting guides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CQ-004   | ✅     | Document error-code table in `guides/errors.md`                                              | P2       | Med       | Low  | 3h     | **Done.** Created `guides/errors.md` with `## Codes outside the pool` table (10 codes) satisfying `test/errorCodes.test.js`. `test/docsCodeAgreement.test.js` updated to expect 8 cross-cutting guides. ...                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DX-002   | ⬜     | `PowerRateLimit.builder()` fluent API                                                        | P3       | Med       | Low  | 6h     | Ergonomic win for multi-limiter composition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DX-004   | ✅     | Typed event names for `PowerEventBus`                                                        | P2       | High      | Low  | 4h     | **Done.** Added generic type parameter `T` to `PowerEventBus` with default `Record<string, any>`. Public methods `on`, `once`, `off`, `emit`, `emitAsync`, `listeners`, and `clear` now accept `keyof T & string` for the event name, so a typo such as `bus.emit('stateChagne')` is caught at compile time. Untyped usage (`new PowerEventBus()`) continues to accept any string event name. Updated `guides/powerEventBus.md` with a type-safe event names section and added type tests in `test/types.test-d.ts` with `@ts-expect-error` cases for invalid event names. `npm run verify` passes (11/11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| DX-005   | ✅     | Add `Symbol.asyncDispose` to async helpers                                                   | P1       | High      | Low  | 3h     | **Done for the two helpers the row names**, and the row's headline framing was the valuable part: **21 of 23 helpers implementing `[Symbol.dispose]` had no `asyncDispose`, so `await using hub = new PowerRealtimeHub(…)` never disposed the hub at all** — not disposed ungracefully, _not disposed_, which looks exactly like correct code. **On the hub it is not a formality:** with `batchDelayMs > 0`, sync `dispose()` sent **0** frames at scope exit while `await using` sent **1**, because `close()` clears the pending batch along with everything else. Same shape as `PowerPool`: flush (swallowing flush failures, so a disposal path is never abandonable), then close. **On the client it is a delegation** — its teardown is a synchronous `close()` with nothing to await, and inventing an awaitable variant would imply a graceful path that does not exist. It delegates to `dispose()`, not `close()`, because `dispose()` also detaches the metrics sink. **The other 17 sync-only helpers were left alone deliberately** and that is recorded in the source, the guides and the changeset: `using` is the correct tool for them and a delegating hook would be API surface with no behaviour behind it. 9 tests, 3 mutants — **and one mutant caught a vacuous test of mine**: the metrics assertion passed against a mutant that skipped `dispose()` entirely, because `_metrics` is `null` on a fresh client (metrics are opt-in), so it could not fail until `observability: true` was set and the attached-sink assertion added.                                                                                                                                                                                                                                                                                                                                                                                         |
| DUP-003  | ✅     | Replace `normalizeAdaptive.num()` with `assertLimitRequired`                                 | P3       | Low       | Low  | 1h     | **Done.** Removed local `num()` helper from `normalizeAdaptive()` in `src/helpers/powerBackpressure.js`; replaced integer-field validation with `assertLimitRequired`. `beta` keeps a finite check. Lint clean, 9 backpressure tests pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| DEAD-001 | ❌     | Remove `_evictionCandidate`, read `_head` directly                                           | P3       | Low       | Low  | 3h     | **Refuted, and decisively — by the very instrumentation that would have been needed to action it.** The pointer is **live in 7 sites** (`powerCache.js:457,940,975,1025,1046,1260,1273`), so "rarely read" was already inaccurate. The load-bearing question was whether `_evictionCandidate` and `_head` are interchangeable, and an earlier probe of mine said they were: **equal in every state tested, under all four policies**. That was wrong, and wrong in the permissive direction — it sampled _between_ mutations, by which point the sweep had re-synced them. Trapping **every assignment** and comparing against `_head` at that instant: across **1 435 assignments, 689 diverged** — `lru` 180, `slru` 149, `mru` 180, `fifo` 180. So the two are **not** interchangeable, and the divergence is exactly where `:1260`/`:1273` assign the pointer to a `node` mid-sweep rather than to `_head`. Reading `_head` in `_evictIfNeeded` instead would change eviction behaviour under every policy. **Two lessons, both the kind this project already records elsewhere.** A probe that samples between mutations cannot see a divergence that only exists during one — so "equal at rest" is not "equal". And the earlier note on this row said "do not remove it on the strength of the above alone", which is why a live cursor survived an argument that had begun to look like a simplification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ALG-001  | ⬜     | Implement SIEVE eviction policy                                                              | P1       | Very High | Med  | 16h    | SOTA hit ratio, dramatically simpler than TinyLFU. Add as `policy: 'sieve'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ALG-002  | ⬜     | Implement S3-FIFO eviction policy                                                            | P2       | Very High | High | 32h    | Best-in-class but complex. Ghost queue needs memory budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ALG-005  | ⬜     | HyperLogLog for auto-tuning sketch `sampleSize`                                              | P3       | Med       | Low  | 6h     | Makes TinyLFU self-tuning for variable key spaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| FEAT-002 | ✅     | Task priorities in `PowerPool`                                                               | P2       | High      | Med  | 12h    | **Done.** Added `priority` to `PostMessageOptions` and `PreparedItem`. `PowerQueue` gained `shiftHighestPriority(priorityFn)`; `PowerPool` stores `options.priority` on queued items and dispatches highest-priority first, preserving FIFO among equal-priority tasks. Default is `0`. Composes with all `queuePolicy` values. 11 tests pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| FEAT-004 | ❌     | `maxWaitMs` linger timeout for `PowerBatch`                                                  | P1       | High      | Low  | 4h     | **Refuted — the premise is inverted, and the measurement is worth more than the feature.** Measured: one item flushes at **0.17 ms**; five items one per macrotask produce **five batches of one item each**, not one batch of five; and `PowerScheduler` offers only `microtask` \| `macrotask` \| `yield` — **no timer mode**, so there is no code path in which an item waits. **Items do not sit too long; under low throughput they do not batch at all.** So `maxWaitMs` would not flush anything sooner — it would _add_ a capability that makes items sit **longer**, trading latency for fewer handler calls, which is Kafka's `linger.ms` and a legitimate want but a feature, not a defect fix. **The decision that has to be made first is the default:** with the current microtask default, any linger above ~0 changes behaviour for every existing caller, so a non-zero default is a **breaking change**, not a new option — which is why the row's P1/Low rating is optimistic as written. The need is plausibly real, but only the description of today's behaviour was wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| FEAT-005 | ✅     | `computed()` / `effect()` for `PowerObserver`                                                | P3       | Med       | Low  | 8h     | **Done.** Added `computed()` and `effect()` reactive primitives to `PowerObserver`. `computed()` derives a signal from other signals; `effect()` runs a callback on change and supports cleanup functions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| FEAT-006 | ✅     | Wildcard subscriptions for `PowerEventBus`                                                   | P3       | Med       | Med  | 8h     | **Done.** Added wildcard/glob subscription support to `PowerEventBus`. Callers can subscribe to `'user:*'` and receive all `user.created`, `user.updated`, etc. events. Matches literal events first, then wildcards; unsubscription removes both literal and wildcard listeners.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| RT-002   | ⬜     | `PowerWebTransportClient` adapter                                                            | P2       | High      | High | 24h    | HTTP/3 QUIC transport, future-proofing. `detectWebTransportSupport()` already exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| RT-003   | ✅     | Per-topic rate limiting in `PowerRealtimeHub`                                                | P2       | High      | Low  | 6h     | **Done.** Added `rateLimit` option to `HubOptions` (accepts any `RateLimiterLike`). `publish()` calls `tryConsume(1, { key: topic })` before enqueuing; a `false` return increments `stats().rateLimited` and drops the message for that topic. Composes with `PowerThrottle`, `PowerGCRA`, `PowerRateLimit` with `keyFn`, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| RT-004   | ✅     | `BroadcastChannel` support in `PowerSocketAdapter`                                           | P3       | Med       | Low  | 6h     | Cross-tab messaging with same API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| RT-005   | ⬜     | SSE transport adapter for `PowerRealtimeHub`                                                 | P3       | Med       | Low  | 8h     | Covers unidirectional push without WebSocket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| RT-006   | ✅     | Connection quality metrics for `PowerWebSocketClient`                                        | P2       | Med       | Low  | 4h     | **Done.** Added `connectionUptime` (ms since last open) and `backpressureRatio` (fraction of uptime spent paused) to `stats()`. `rtt` already provided p50/p95/p99; `reconnects` counter already provided reconnect count. Tracked via `_connectedAt`, `_pausedAt`, `_totalPausedMs`; cleared on close.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| WT-002   | ✅     | `createWebTransportAdapter(session)` — a `kind: 'stream'` socket, after RT-005 and CODEC-001 | P2       | Med       | Low  | S      | **Done.** `src/helpers/powerWebTransportAdapter.js` exports an `async` `createWebTransportAdapter(session)` that calls `session.createBidirectionalStream()`, pumps the readable side through a `TransformStream` decoded by `createFrameDecoder({ maxFrameBytes: Infinity })`, and returns `{ kind: 'stream', writable, readable, close }`. The receive side now handles split frames without `RangeError` (pinned by `test/powerWebTransportAdapter.test.js`). `close()` calls `session.close({ closeCode, reason })` per TypeScript's `WebTransportCloseInfo` shape, then closes/aborts the writable and cancels the readable. 9 tests pass; full verify green. Supersedes RT-021.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RT-014   | ✅     | Add `nonRetryableCloseCodes` (opt-in, default `[]`) before a full `shouldReconnect`          | P2       | Med       | Low  | S      | **Done.** A 1008 / 1001 / 1002 close is reconnected immediately, forever, by every client at once — the reconnect stampede the backoff exists to prevent. `nonRetryableCloseCodes` on `PowerWebSocketClient`: opt-in, default `[]`, validated as an array of real close codes and copied at construction. A matching code arms no reconnect timer; the check runs ahead of every reconnect input (`autoReconnect`, `maxReconnectAttempts`, `maxReconnectElapsedMs`) so a bound cannot re-enable it and a future `shouldReconnect` callback cannot outrank a code the caller declared terminal. Settlement matches a caller-initiated close exactly rather than inventing a terminal path: `readyState` CLOSED, the close event still fires, heartbeat and poll timers cleared, no reconnect timer. **Not latched** — `connect()` afterwards works, because a code can be terminal for one close and wrong for the next. Numeric strings match numeric codes; duplicates are legal and mutating the caller's array afterwards changes nothing. `stats()` gained a third `reconnectExhaustedBy` value, `'close-code'`, which is the only thing that distinguishes "stopped because you said so" from "stopped because `autoReconnect: false`". 17 tests, mutation-checked: 15 mutants all killed, and three tests were added after the first pass because three were un-killed — they were decoration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

## 12. Reconciliation with `review.md`

This audit is a **second plan**, not a replacement. `review.md` holds 202 rows
(108 ✅, 85 ⬜, 8 ❌, 1 🟡); this file holds 30. Every open row here was compared
against every row there, by subject rather than by ID.

**Two genuine overlaps.**

| this audit                                                    | `review.md`                       | what it is                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT-004 — `BroadcastChannel` in `PowerSocketAdapter`           | **RT-020** plus **BC-001…BC-008** | The same feature, already tracked nine times over in the v2 plan. RT-020 is the hub; the BC rows are the measurement, the rejected alternatives, and the shape decisions. **Work it under `review.md`’s IDs, not this one** — nine rows describing one thing is already the duplication this project records as a finding, and adding a tenth would compound it. |
| PERF-001 — optimise `_windowOldest()` with a count-based walk | **CACHE-006**, ✅ **closed**      | The same cost, **already removed**. `powerCache.js:1050-1074` names CACHE-006 as the row that "still wants this cost removed", and CACHE-006’s own specified assertion — _a counter, not a duration_ — is the measurement that refutes PERF-001: **0 calls in 2000 `set()`s**.                                                                                   |

**The reconciliation missed the second pair, and the reason matters.** It compared task text by
keyword overlap, and these two rows are worded differently enough to score below threshold.
**A keyword comparison is not a reconciliation.** The stronger signal was the _code_ naming the row:
`powerCache.js`’s comment cites CACHE-006 by name, which is direct evidence and would not have
been missed by reading the code the finding is about. Re-run any cross-plan comparison by grepping
the **source** for row identifiers, not the prose for similar words.

**And that advice needs its own caveat, found by running it.** Of the 55 row IDs cited
in `src/`, only 3 resolve to rows that are still open — and all 3 are **false
positives caused by ID reuse across review cycles**. `powerCache.js` cites
`PERF-004` and `PERF-005` as the rationale for its width budget and its
`simpleArgsKey` default; `review.md`'s `PERF-004` and `PERF-005` are **codec**
items (`u82o`'s `TextDecoder` fallback, `o2u8`'s non-string `JSON.stringify`).
`powerMessageCodec.js` cites neither. So a bare ID in a comment is **not** a durable
citation — the same string names different work in different files, and a reader
following it lands on the wrong row.

**Two things follow, and they point in opposite directions.** A grep of the source
is still better than a keyword comparison — it is how the CACHE-006 link was found
at all — but **every hit needs its file checked against the row's subject**, and
an open hit is not evidence of stale work until it is. And the source itself has a
fix available: qualify the citations (`PERF-004 (cache width budget)`), or cite the
subject rather than the ID. Both are cheap; neither is urgent, and both would have
prevented a wrong conclusion here.
`PowerRealtimeHub` adapter. They are different transports on different runtimes;
the pairing is spurious.

**The other 27 open rows here are not tracked in `review.md` at all.** They are
genuinely new scope, not re-description. The notable one is **DX-005**
(`Symbol.asyncDispose`): `AGENTS.md` makes the dispose contract a stated project
convention, so `await using` support finishes something already half-built — yet
the v2 plan has no row for it at either status.

**Consequence, stated rather than acted on.** 27 rows of work are visible only in
this file. Anyone reading `review.md`, or the changeset, does not see them. The
choice between merging them into `review.md` and keeping two plans is a
maintainer's, and merging is not free: it would put 27 rows into a table that is
sorted by priority and already at 202. What should not happen is the silent
default this session started in — both documents read as authoritative, and
neither mentions the other.
