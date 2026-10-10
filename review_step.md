# Deep Audit — `performance-helpers`

**Date:** 2026-10-09
**Scope:** full `src/` tree (36,485 lines, 68 files), 315 test files, 56 guides, 12 ADRs, 17 benchmark modes
**Method:** direct source reading + targeted pattern scans + executable verification scripts + web research
**Baseline:** `npm test` — 3,179 passing / 8 failing across 306 files (see §1 for why)

> **Note on `notes.md`.** Disregarded as instructed. Nothing in this document derives from it.

---

## 0. Executive summary

The codebase is unusually disciplined. Documentation is dense and _earned_ — comments record
measurements, retracted claims, and the specific defect a guard was written for. The dispose
rule, the cross-realm internal-slot convention, and the "a guard that has never been observed
failing is a hypothesis" discipline are all genuinely applied, not aspirational.

That discipline is why the findings below are worth reading: **most of them are in the places
the discipline does not reach.** The S3-FIFO policy, the distributed-limiter path, and the
`drain()` wait are all newer, less-exercised code sitting next to heavily-tested neighbours.

Four things dominate:

1. **The build is broken right now.** `src/index.js` carries four duplicate export lines from
   an in-flight concurrent edit. `npm run build` fails, so `test/globalSetup.js` fails, so
   **the entire test suite cannot run.** I fixed this in the working tree (uncommitted) to
   unblock verification — see §1.
2. **S3-FIFO is wrong in three independent ways**, all verified by execution: it serves stale
   evicted values, it retains evicted values in its ghost queue, and it violates `maxEntries`
   while over-reporting `size`.
3. **`PowerRateLimit.reserve()` is broken with an async `sharedState` adapter** — it reports a
   granted reservation for a denied one, and `release()` then credits back permits that were
   never spent.
4. **`PowerPool.drain()` leaks an `AbortSignal` listener per call** — reproduced at 5 retained
   listeners after 5 timed-out drains.

Everything else is smaller. The performance section is mostly micro-optimisations with real
but modest wins; the SOTA section is where the largest _upside_ sits, because two of the
library's own primitives (a 64-register HyperLogLog at ~13% error, and a fixed-policy cache)
are measurably behind what the literature now offers.

**A note on verification.** Several findings reported by subagents during this audit were
**wrong**, including one labelled CRITICAL. §9 records every refuted claim with the reason.
Read it before trusting any single finding here — including mine.

---

## 1. Blocking: the build does not compile

### 1.1 `src/index.js` — four duplicate export lines

**Severity: CRITICAL. Status: fixed in working tree, uncommitted.**

An in-flight concurrent edit added four `export { default as … }` lines immediately after the
named exports that already covered the same symbols:

```js
export { PowerQueue } from './helpers/powerQueue.js';
export { default as PowerQueue } from './helpers/powerQueue.js'; // ← no default export exists
export { PowerPriorityQueue } from './helpers/powerPriorityQueue.js';
export { default as PowerPriorityQueue } from './helpers/powerPriorityQueue.js'; // ← duplicate
export { PowerGCRA } from './helpers/powerGCRA.js';
export { default as PowerGCRA } from './helpers/powerGCRA.js'; // ← duplicate
export { PowerDeduplication } from './helpers/powerDeduplication.js';
export { default as PowerDeduplication } from './helpers/powerDeduplication.js'; // ← duplicate
```

`powerQueue.js` exports **only** a named `PowerQueue` — there is no `default`, so that line is
a link error, not merely a duplicate. The other three are duplicate named exports.

**Effect.** `node -e "import('src/index.js')"` fails with
`SyntaxError: Duplicate export of 'PowerDeduplication'`. `npm run build` fails.
`test/globalSetup.js` shells out to `npm run build`, so it fails, so **every test file that
imports the barrel fails to load.** The suite is not "mostly green with a few failures" — it
cannot run at all.

**Fix applied.** Deleted the four `default as` lines. The concurrent session's intent (adding
`PowerPriorityQueue` and `PowerDeduplication` to the public surface) is preserved; the diff is
two added lines and nothing else. The entry point now loads with 95 exports.

**Follow-up still required by whoever owns that work** (all currently red, all mechanical):

| Gate                              | Failure                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `test/apiSurface.test.js`         | export list pins 91 names; barrel now exports 93 (`PowerDeduplication`, `PowerPriorityQueue` added) |
| `test/apiSurface.test.js:265`     | `expect(subpaths.length).toBe(49)` — `package.json` now declares 51                                 |
| `test/index.test.js`              | subpath targets must exist on disk                                                                  |
| `test/catchJustification.test.js` | `src/helpers/powerSseAdapter.js:150` has a bare `// ignore` with no reason (GATE-001)               |

**Recommendation.** Add a `node --check`-equivalent parse gate on `src/index.js` to
`scripts/verify.mjs` _before_ the build step. A barrel that does not parse is the one failure
that makes every other gate meaningless, and it currently costs a full suite run to discover.

---

## 2. Correctness bugs

### 2.1 S3-FIFO serves stale evicted values — **CRITICAL**

`src/helpers/cache/core.js:949` — `_fetchValidNode()` falls back to the ghost map:

```js
const node = this._map.get(key) ?? this._smallMap.get(key) ?? this._ghostMap.get(key);
```

A ghost node is an _evicted_ entry kept only as an admission hint. In S3-FIFO the ghost queue
holds **keys, not values**, precisely so that a ghost hit is a _miss_ which triggers a
re-fetch. Here the ghost node retains its full `value`, so `get()` returns it.

**Verified:**

```js
const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
c.set('a', 'ORIGINAL');
c.get('a'); // promote to Main
for (let i = 0; i < 12; i++) {
  c.set(`k${i}`, i);
  c.get(`k${i}`);
}
c.get('a'); // → "ORIGINAL"     expected: undefined
```

**Why it matters.** This is silent data corruption, not a performance issue. A caller that
evicted-and-refetched expects a fresh value; it gets the old one. Worse, `_moveToTail`
(`core.js:1381-1396`) then _promotes the ghost to Main_, so the stale value is re-admitted as
if it were live and starts being served as current.

**Fix.** In `_fetchValidNode`, treat a ghost hit as a miss: return `null` (or a sentinel) when
`node.queue === 'ghost'`, and let the caller re-fetch. Alternatively null `node.value` when
appending to the ghost queue (§2.2), which makes the existing path return `undefined`
naturally — but that loses the "this was recently evicted" signal the admission filter needs,
so the explicit miss is the better shape.

### 2.2 S3-FIFO ghost nodes retain evicted values — **HIGH (memory leak)**

`src/helpers/cache/core.js:1776-1778` — `_s3fifoEvict()` moves a node to the ghost queue
without releasing its value:

```js
this._unlinkNode(node, 'main', 'ghost');
this._s3fifoAppendGhost(node);
```

`_freeNode()` is called only on the `else` branch. The ghost node keeps `value`, `weight` and
`expiresAt`.

**Verified:** after eviction, `ghostNode.value === big` — the original object is still
reachable.

**Impact.** The ghost queue is bounded at `_ghostMaxSize = 20%` of `maxEntries`, so up to
**20% of the cache's capacity in evicted values is retained indefinitely.** For a cache
holding large payloads this is a substantial, invisible retention. It also defeats the
purpose of eviction: the memory an eviction was supposed to free is still held.

**Fix.** Null the value when appending to ghost:

```js
_s3fifoAppendGhost(node) {
  node.value = undefined;      // ghost holds a key, not a value
  node.weight = 0;
  node.expiresAt = 0;
  …
}
```

This must land together with §2.1, since §2.1's fix depends on the ghost no longer carrying a
servable value.

### 2.3 S3-FIFO violates `maxEntries` and over-reports `size` — **HIGH**

Two independent defects:

**(a) `size` counts ghost entries.** `core.js:2917`:

```js
get size() { return this._map.size + this._smallSize + this._ghostSize; }
```

Ghost entries hold no value. `size` is documented as "Current number of entries in cache".

**Verified:** `maxEntries: 100` → `size: 119` (99 live + 20 ghost).

**(b) Live capacity exceeds `maxEntries`.** `_s3fifoEvict` (`core.js:1772`) uses `>=`:

```js
while (this._map.size >= this.maxEntries || this._currentWeight > this.maxWeight) {
```

where the LRU and SIEVE paths (`core.js:1699`) use `>`. So Main holds at most
`maxEntries - 1`, and total live capacity is `maxEntries - 1 + 10%`.

**Verified:** `maxEntries: 100` → 99 live in Main + 10 in Small = **109 live entries**, over
the declared limit.

**Caution.** `test/powerCache.s3fifo.test.js:72` pins `expect(c._map.size).toBe(9)` for
`maxEntries: 10`. That test currently _pins the off-by-one_. Fixing (b) requires updating
that assertion deliberately, in the same commit, with a comment saying why 10 is now correct
where 9 was. Do not "fix" the code and leave the test red, and do not loosen the test to
match without saying so.

**Fix.** (a) exclude `_ghostSize` from `size` (expose it separately as `ghostSize` for
diagnostics). (b) change `>=` to `>` in `_s3fifoEvict` and update the pinned test.

### 2.4 `PowerRateLimit.reserve()` is broken with an async `sharedState` — **HIGH**

`src/helpers/powerRateLimit.js:551`:

```js
if (!this.tryConsume(want, { ...options, atomic: true })) return null;
return { n: want };
```

When `sharedState` is an **async** adapter, `_tryConsume` (`powerRateLimit.js:316-341`)
returns a **Promise**. A Promise is always truthy, so `!promise` is `false` and `reserve()`
returns `{ n: want }` — reporting success.

**Verified:**

```js
const legs = [new PowerThrottle({ capacity: 100, tokens: 100, refillRate: 0 })];
const limiter = new PowerRateLimit(legs, {
  sharedState: { checkAndIncrement: async () => ({ ok: false, retryAfterMs: 1000 }) },
});
const token = limiter.reserve(1);
// → {"n":1}   although the shared store DENIES
limiter.release(token);
// → leg tokens back to 100; a permit that was never spent has been credited
```

**Two distinct failures:**

1. A **denied** reservation is reported as **granted**.
2. The local legs are consumed _inside_ the promise's `.then()`, asynchronously. A
   `release(token)` issued synchronously right after `reserve()` runs **before** the legs were
   consumed, so it credits back permits that were never spent — inflating the local budget
   above `capacity`.

**Fix.** Make `reserve()` return a `Promise` when `this._sharedState` is async, and document
the dual return shape. The cleanest version: detect the async adapter at construction
(`sharedState.checkAndIncrement` returning a thenable on a probe, or an explicit
`async: true` flag) and expose `reserve()` / `reserveAsync()` as separate methods rather than
one method with a polymorphic return. A synchronous `reserve()` that silently lies is worse
than no `reserve()`.

### 2.5 `_reapIdleWorkers` skips a worker after swap-remove — **MEDIUM**

`src/helpers/powerPool.js:3916-3933`. The loop iterates **backwards** and, when reaping a
worker at index `i` that is not the last, does:

```js
this.workers[i] = this.workers.pop();
```

then decrements `i`. The worker swapped _into_ index `i` is therefore never examined in this
pass.

**Impact.** One worker per reap event escapes the idle check. Self-healing on the next reap
tick, so the practical effect is a delayed reap rather than a permanent leak — but it makes
reaping non-deterministic and hard to reason about, and it is the kind of off-by-one that
becomes a real bug the moment the loop body grows a second condition.

**Fix.** Iterate forwards with an explicit index, or re-check index `i` after the swap:

```js
if (i !== lastIndex) {
  this.workers[i] = this.workers.pop();
  i += 1;
} // re-examine
```

### 2.6 `PowerMessagePort._attach` clobbers caller handlers — **MEDIUM**

`src/helpers/powerMessagePort.js:229-232`:

```js
port.onmessage = (event) => { … };
port.onclose = () => { … };
```

The class's own doc comment (`powerMessagePort.js:9-13`) says it deliberately avoids this for
WebSocket — _"rather than assigning `socket.onmessage`, which would clobber a handler the
caller had already set"_ — and then does exactly that for `MessagePort`. `_detach` sets both
to `null` rather than restoring the previous values.

**Impact.** A caller who sets `port.onmessage` before constructing the adapter silently loses
their handler, with no error. This is the precise defect the class was written to avoid,
reintroduced on the other transport.

**Fix.** Capture and restore, or use `addEventListener`/`removeEventListener` symmetrically as
the WebSocket path does.

### 2.7 Cross-realm `instanceof` in the codec — **MEDIUM**

Two sites, both contrary to the project's own documented convention
(`AGENTS.md`: use `Reflect.get(ArrayBuffer.prototype, 'byteLength', value)`):

- `src/helpers/powerMessageCodec.js:682` — `frame.buffer instanceof SharedArrayBuffer`
- `src/helpers/powerMessageCodec.js:846` — `v instanceof ArrayBuffer` in `collectTransferables`

`src/helpers/powerBuffer.js:22-33` already implements the correct check (`isArrayBuffer` via
`Reflect.get`), so the fix is to call it.

**Impact.** Line 846 walks **arbitrary user values**, so a cross-realm `ArrayBuffer` is
silently _copied_ instead of transferred — a performance loss, not corruption. Line 682 is
lower risk because `frameTransferList` is normally fed frames the codec itself allocated
in-realm, but it is an exported function and the hazard is real for a caller who passes
their own frame.

**Fix.** Replace both with `isArrayBuffer(v)` / an `isSharedArrayBuffer(v)` helper built the
same way. Note `ArrayBuffer.isView()` is already realm-independent and is correct for views —
the gap is bare `ArrayBuffer`/`SharedArrayBuffer` only.

### 2.8 `PowerHistogram.merge()` uses `instanceof` and has no cross-worker path — **MEDIUM**

`src/helpers/powerHistogram.js:301`:

```js
if (!(other instanceof PowerHistogram))
  throw new TypeError('PowerHistogram.merge() expects a PowerHistogram');
```

The class doc (`powerHistogram.js:20-21`) advertises the headline feature: _"It also merges
exactly, so per-worker or per-shard sketches can be combined into a global histogram."_

**That path does not exist.** `structuredClone` does not preserve the class, so a sketch
arriving from a worker is a plain object and `merge()` rejects it. There is a `toJSON()`
(`powerHistogram.js:351`) but no `fromJSON()` and no `merge` that accepts a plain sketch.

**Impact.** The documented distributed use case is unreachable. A caller must hand-roll
reconstruction, which is exactly the kind of thing that gets the bucket indices wrong.

**Fix.** Add `static fromJSON(obj)` and make `merge()` accept either a `PowerHistogram` or a
plain sketch object with the same `_alpha`. Use a structural check (`typeof other._alpha ===
'number' && other._buckets instanceof Map`) rather than `instanceof`, per the cross-realm rule.

---

## 3. Memory leaks and retention

### 3.1 `PowerPool.drain()` leaks an `AbortSignal` listener per call — **HIGH**

`src/helpers/powerPool.js:4676-4689` — `release()` clears the timer, decrements
`_drainWaiters`, and removes the `'idle'` listener. It **never** removes the abort listener
registered at `powerPool.js:4716`:

```js
if (signal) signal.addEventListener('abort', onAbort, { once: true });
```

`{ once: true }` only auto-removes the listener _if it fires_. When the wait ends via the
`idle` or `timeout` path, the listener stays attached.

**Reproduced:**

```js
// pool kept busy by a worker that never replies
for (let i = 0; i < 5; i++) await pool.drain({ signal: ac.signal, timeout: 20 }).catch(() => {});
getEventListeners(ac.signal, 'abort').length; // → 5
```

**Impact.** Each retained listener closes over `resolve`, `reject`, `timer` and `this` — the
entire pool. With a long-lived signal (a server-lifetime `AbortSignal`, or a framework that
reuses one across requests) this grows without bound and will eventually trip Node's
max-listeners warning. Note the fast path at `powerPool.js:4649-4653` returns early when the
pool is already idle, which is why a naive test against an idle pool shows zero listeners and
misses the bug entirely.

**Fix.** Add to `release()`:

```js
if (signal) signal.removeEventListener('abort', onAbort);
```

**Test to add.** A regression test must keep the pool **busy** (a worker that never replies)
and assert `getEventListeners(signal, 'abort').length === 0` after a timed-out drain. A test
against an idle pool passes either way and is decoration.

### 3.2 `PowerQueue` has no `dispose()` — **MEDIUM**

`PowerQueue` owns a ring buffer and a `FinalizationRegistry`-free but manually-grown
`ArrayBuffer`-backed store, yet exposes no `dispose()` / `[Symbol.dispose]`. Its sibling
`PowerPriorityQueue` does (`powerPriorityQueue.js:149-155`).

This violates the project's own dispose rule as recorded in `AGENTS.md`, and it means
`PowerQueue` cannot take part in `using` / `await using` or a DI teardown.

**Fix.** Add `dispose()` that clears the ring and releases the buffer, plus
`[Symbol.dispose]`. Mirror `PowerPriorityQueue`'s implementation.

### 3.3 `receiverPendingCount` retains zero-valued entries — **LOW**

`src/helpers/powerBroadcastBus.js:149-160` — `close(sub)` sets
`receiverPendingCount.set(receiverId, 0)` when the count is positive, rather than deleting
the key. The entry is only removed on the _next_ decrement. A subscriber that closes while
holding pending sends leaves a `0` entry behind.

**Fix.** `receiverPendingCount.delete(receiverId)` instead of setting `0`.

### 3.4 Checked and clean

- **Abort listeners elsewhere.** `utils/abort.js:33-44`, `powerRetry.js:288-305`,
  `powerLatch.js:253-255,278-280`, `powerPermitGate.js:34-36,269,492` and
  `powerDeadline.js:100` all remove listeners on every exit path. This is the one area where
  the codebase is uniformly correct — which is what makes §3.1 stand out.
- **Timers.** 52 timer creations vs 44 clears across `src/`; every file that creates a timer
  also clears one. No orphaned intervals found.
- **Circular imports.** None. A full DFS over the `src/` import graph found zero cycles (the
  single hit was a JSDoc comment in `powerLogger.js`, not an import).
- **Dead exports.** None. Every exported symbol is referenced somewhere in
  `src/`, `test/`, `bench/`, `examples/`, `guides/` or `scripts/`.

---

## 4. Performance

Ordered by expected impact. All are real but none is a 10× win; the library's hot paths are
already tight.

### 4.1 `_idempotencySweep` allocates the whole ledger on every post — **HIGH**

`src/helpers/powerPool.js:2921`:

```js
const keys = [...ledger.keys()];
```

The comment above it claims _"bounded slice per call"_, but the spread materialises **every**
key in the ledger before the slice is taken. With idempotency enabled this is an O(n)
allocation on **every `postMessage`**, where `n` is the number of in-flight idempotency keys.

**Fix.** Iterate the cursor directly without materialising:

```js
let examined = 0;
for (const key of ledger.keys()) {
  if (examened++ >= IDEMPOTENCY_SWEEP_LIMIT) break;
  …
}
```

This also fixes the comment, which currently describes behaviour the code does not have.

### 4.2 `PowerHistogram.percentile()` is a linear scan — **MEDIUM**

`src/helpers/powerHistogram.js:256-259` walks the sorted bucket list accumulating counts
until the target is reached. `_sortedIndexList()` (`powerHistogram.js:395-398`) already
maintains a sorted array, so a **binary search** over the cumulative counts is available at
O(log B) instead of O(B).

For a long-running histogram B (distinct buckets) grows into the thousands, and `percentile()`
is typically called in a loop over several quantiles — so the cost is O(Q·B) per reporting
cycle.

**Fix.** Precompute a cumulative-count array alongside `_sortedIndices` (invalidated together,
at `powerHistogram.js:220` and `:323`) and binary-search it. Keep the linear path for small B
where the constant factor wins.

### 4.3 `PowerSlidingWindow._prune()` calls `shrink()` on every prune — **MEDIUM**

`src/helpers/powerSlidingWindow.js:90`. `_prune` runs on every `tryConsume` and every
`available()`. `shrink()` reallocates the ring buffer whenever capacity has dropped below the
current allocation.

After a burst grows the ring to its high-water mark, every subsequent prune while the queue is
small reallocates downward. On a monitoring path that polls `available()` this is repeated
O(capacity) work for no benefit.

**Fix.** Only shrink when the drop is significant (e.g. `length < capacity / 4`), or move
`shrink()` to `dispose()` only — which is what `reset()` already deliberately does.

### 4.4 `PowerPriorityQueue._grow()` copies unused slots — **LOW**

`src/helpers/powerPriorityQueue.js:141-142`:

```js
const next = new Array(newCap);
for (let i = 0; i < this._heap.length; i++) next[i] = this._heap[i];
```

`new Array(newCap)` creates a holey array; the copy loop then runs to `_heap.length`, leaving
`newCap - _heap.length` holes. `push()` on a holey array deoptimises. `PowerQueue._grow()`
does the same thing and has the same issue.

**Fix.** `const next = new Array(newCap).fill(null)` — or better, copy with
`next.set(this._heap)` and keep the array packed.

### 4.5 `PowerQueue.fill()` is an O(n) loop — **LOW**

`src/helpers/powerQueue.js:227-233` pushes one item at a time, re-checking capacity each
iteration. `pushMany` already has a bulk path; `fill` should share it. Only matters for large
batch consumption (`PowerSlidingWindow.tryConsume(n)` with big `n`), which is rare.

### 4.6 `collectTransferables` walks depth 8 on every encode — **LOW**

`src/helpers/powerMessageCodec.js:846` recursively walks up to depth 8 collecting
transferables, allocating a `Set` and a `seen` set per call. For the common case (a flat
payload with no buffers) this is pure overhead.

**Fix.** Fast-path the common shapes first — `ArrayBuffer.isView(v)` and a plain-object check
— before entering the recursive walk.

### 4.7 `PowerBroadcastBus` allocates a `TextDecoder` per ack — **LOW**

`src/helpers/powerBroadcastBus.js:71` — `JSON.parse(new TextDecoder().decode(ackData.payload))`.
Hoist a module-level decoder.

---

## 5. Robustness

### 5.1 `PowerThrottle` freezes on a permanent backwards clock step — **LOW**

`src/helpers/powerThrottle.js:99-100`:

```js
const elapsedMs = Math.max(0, now - this._lastRefill);
if (elapsedMs <= 0) return; // returns WITHOUT updating _lastRefill
```

I specifically checked whether this over-credits on recovery — **it does not.** Preserving
`_lastRefill` at the last valid reading is the correct, safe direction, and
`test/powerThrottle.refill.test.js:23-33` pins the behaviour deliberately.

The residual issue is narrower: if the clock steps backwards **and stays back**, `elapsedMs`
is permanently `0` and the throttle never refills again. Verified: with the clock stuck at 500
after a refill at 1000, tokens stay at 0 indefinitely.

**Fix (optional).** Track a monotonic fallback: if `now < _lastRefill`, record the anomaly and
clamp `_lastRefill = now` after a threshold, so a permanent regression degrades to "no refill
credit for the jump" rather than "no refill ever". Low priority — this requires a broken clock.

### 5.2 `PowerRateLimit.available()` swallows all errors as "no capacity" — **MEDIUM**

`src/helpers/powerRateLimit.js:420-428` wraps each leg's `available()` in `try/catch` and
returns `0` on any throw. A genuine fault (a broken custom clock, a throwing third-party leg)
is indistinguishable from "rate limited".

**Fix.** Re-throw anything that is not a capacity signal, or surface it through the existing
`onError` hook. At minimum, count it in stats so an operator can see the limiter is broken
rather than busy.

### 5.3 `PowerRateLimit.dispose()` does not dispose per-slot limiters — **LOW**

`src/helpers/powerRateLimit.js:841` nulls `_slots` without calling `dispose()` on the limiters
inside each slot. Any metrics registration or timer a leg holds survives teardown.

**Fix.** Iterate the slots and dispose each before nulling.

### 5.4 `PowerHistogram` rejects negative values outright — **LOW (by design)**

`record()` throws on `n < 0` (`powerHistogram.js:192-194`). DDSketch handles negatives fine
(sign-magnitude bucket mapping), and latency _deltas_ are legitimately negative. Currently a
caller measuring jitter must offset manually.

**Fix (optional).** Accept negatives via sign-magnitude indexing, or document the constraint
prominently. Low priority — the throw is at least loud.

### 5.5 `HyperLogLog` is too coarse to be useful — **MEDIUM**

`src/utils/hyperLogLog.js` uses **64 registers**, giving a standard error of
`1.04/√64 ≈ 13%`. The file's own header is admirably honest about this, but the practical
consequence is that the estimator cannot distinguish 1,000 from 1,130 — which is below the
threshold at which approximate distinct counting is worth doing at all.

**Fix.** See §8.1 — replace with UltraLogLog, which gets _better_ accuracy in _less_ memory.

---

## 6. Code quality, dead code, refactors

### 6.1 Duplicated reconnect logic across four transports — **MEDIUM**

`powerWebSocketClient`, `powerWebTransportClient`, `powerRTCChannel` and `powerSseAdapter`
each implement their own backoff, jitter, attempt-capping and timer cleanup. Four copies of
the same state machine, four places for the same off-by-one.

**Fix.** Extract a shared `ReconnectPolicy` (backoff curve + jitter + attempt cap + timer
lifecycle) into `src/utils/`, and have all four compose it. This is the single highest-value
refactor in the realtime family — not for performance, but because it collapses four
independently-buggy copies into one tested one.

### 6.2 `stats()` / `getStats()` duplication — **LOW (intentional)**

Every limiter exposes both, with `getStats()` delegating to `stats()`. Documented in
`guides/stats-naming.md` as a backward-compatibility decision. Recorded here only so a future
reader does not "clean it up" without reading that guide.

### 6.3 `bucketCount` is accepted and ignored — **LOW**

`src/helpers/powerHistogram.js:78-82` keeps `bucketCount` purely so a caller reading the
option back does not see `undefined`. Reasonable, but it means a caller who sets
`bucketCount: 1000` believing it controls precision gets silently ignored.

**Fix.** Either honour it (map to `relativeAccuracy`) or warn once on first use.

### 6.4 `PowerChunker` owns a pool with no dispose — **LOW**

`src/helpers/powerChunking.js:125` constructs a `PowerPool` and returns it to the caller, who
must remember to `terminate()` it. The class itself has no `dispose()`. Acceptable as a
factory, but a `using`-compatible wrapper would prevent the common "forgot to terminate" leak.

### 6.5 No parse gate on the barrel — **MEDIUM (process)**

See §1. `scripts/verify.mjs` should `node --check` (or import) `src/index.js` as step 0,
before the build. The current ordering means a syntax error in the entry point costs a full
26-second suite run to surface, and surfaces as ~300 confusing per-file failures rather than
one clear one.

---

## 7. Developer experience and ergonomics

1. **The failure mode of a broken barrel is 300 unrelated test failures.** A parse gate (§6.5)
   turns that into one clear message. Highest-value DX fix in the repo.

2. **`reserve()` returning a truthy Promise is a trap.** See §2.4. A method whose return type
   depends on an adapter's synchronicity will be misused. Split into `reserve()` and
   `reserveAsync()`.

3. **`PowerHistogram` advertises cross-worker merge but cannot do it.** See §2.8. Either ship
   `fromJSON` or soften the doc claim — a documented feature that does not work is worse than
   an absent one.

4. **`PowerMessagePort` silently clobbers handlers.** See §2.6. At minimum, throw if
   `port.onmessage` is already set, so the failure is loud.

5. **No `dispose()` on `PowerQueue`.** See §3.2. Breaks the `using` story the rest of the
   library supports.

6. **`test/powerCache.s3fifo.test.js:72` pins an off-by-one.** See §2.3(b). A test that pins
   a bug is worse than no test, because it actively prevents the fix. Needs a deliberate
   update with a comment.

7. **Benchmark mode list is hand-maintained in `AGENTS.md`.** The file itself says
   `bench/claims.js` is authoritative and its own list may be wrong. Generate the list in
   `AGENTS.md` from the mode table, or drop it and point at the script.

8. **`review.md` is gitignored and untestable in CI.** Already well understood by the project
   (`AGENTS.md` §1). Recorded here only to note that `test/reviewTable.test.js` skipping when
   the file is absent means the plan table has **no** automated guard — the discipline is
   entirely human. Worth a CI job that fails if `review.md` is absent _and_ the branch is not
   `main`, so a stale plan cannot reach a release branch silently.

---

## 8. New SOTA algorithms and techniques

### 8.1 Replace HyperLogLog with UltraLogLog — **HIGH ROI**

**Source:** Otmar Ertl, _UltraLogLog: A Practical and More Space-Efficient Alternative to
HyperLogLog for Approximate Distinct Counting_, PVLDB 17(7):1655-1669, 2024.
[arXiv:2308.16862](https://arxiv.org/abs/2308.16862) · production reference implementation in
Hash4j.

UltraLogLog keeps every property HLL is valued for — constant memory, constant-time insert,
commutative/idempotent/associative merge (it forms a CRDT) — and improves the
memory-variance product:

| Sketch                   | MVP    | Relative std. error |
| ------------------------ | ------ | ------------------- |
| HyperLogLog (q=6)        | 6.4485 | 1.04/√m             |
| UltraLogLog (FGRA)       | 4.895  | 0.782/√m            |
| UltraLogLog (MLE)        | 4.631  | 0.761/√m            |
| UltraLogLog (martingale) | 3.466  | 0.658/√m            |

**Net: 24-28% less memory at the same accuracy**, or equivalently ~25% better accuracy at the
same memory. The configuration is `b=2, d=2, q=6` — 8-bit registers in a byte array, which
also compresses better than HLL's packed 6-bit registers.

**Why this matters here specifically.** The current `HyperLogLog` uses 64 registers at ~13%
error (§5.5). Moving to ULL at the same 64 bytes would drop the error to roughly 10%, and
raising to 256 registers (still only 256 bytes) would reach ~5% — a genuinely useful
estimator. The martingale estimator is the tightest but is invalidated by merge, so FGRA is
the right default for a library whose sketches are meant to be merged across workers.

**Effort:** moderate. The insert path is the same shape as HLL; the work is the estimator
(bias-corrected FGRA with the Hurvitz zeta function) and a merge that respects the ULL partial
order. **Must be benchmarked** — `bench/claims.js` has no cardinality mode, and this project's
own rule is that a claimed improvement is a hypothesis until measured.

### 8.2 Adaptive cache policy selection — **HIGH ROI**

**Source:** the 2026 GAMP study _"GAMP: A Gated Adaptive Multi-Policy Cache for Modern
Hardware"_ ([arXiv:2601.02224](https://arxiv.org/abs/2601.02224)), which evaluates 10
admission/eviction combinations across 5 workloads and 3 hardware tiers.

Headline result: **no single policy wins.** The best policy is workload- and
hardware-dependent, and the gap between best and worst is large:

| Policy            | Avg. miss-rate reduction vs LRU |
| ----------------- | ------------------------------- |
| S3-FIFO           | 15.6%                           |
| SIEVE             | 22.8%                           |
| **2Q-SIEVE**      | **26.7%**                       |
| LHD               | 27.1%                           |
| **S3-FIFO-SIEVE** | **28.1%**                       |
| FRD               | 29.3%                           |
| 3L-Cache          | 31.5%                           |

The study also found that **latency-aware** policies (which account for the cost of a miss,
not just its frequency) beat hit-rate-optimal ones on tail latency — directly relevant to a
library whose histogram exists to measure exactly that.

**Recommendation.** Two separable pieces:

1. **Add `2Q-SIEVE` and `S3-FIFO-SIEVE` as policies.** Both are small deltas on code the
   library already has (SIEVE is implemented; S3-FIFO is implemented). `S3-FIFO-SIEVE` uses
   SIEVE's eviction inside S3-FIFO's two queues — a genuine hybrid, not a rename.
2. **Add an adaptive mode** that runs a hill-climbing selector over the resident policies,
   the way Caffeine does. This is the larger piece and should be gated behind an opt-in flag
   with its own `bench/claims.js` mode, because an adaptive policy that picks wrong is worse
   than a fixed one that is merely suboptimal.

**Sequencing note.** §2.1-§2.3 must land first. Adding policies on top of a S3-FIFO that
serves stale values and leaks memory would compound the defects.

### 8.3 `Atomics.waitAsync` for SharedArrayBuffer coordination — **MEDIUM ROI**

Already at ~94.7% global support. The library's `bench/claims.js permit` mode measured that a
SAB-based permit pool is **6.4× more expensive** than the field read already in the path — a
result the project correctly recorded and refused to act on.

But that measurement was about a _permit pool_. `Atomics.waitAsync` is a different shape: it
lets a worker **block on a shared counter without a `postMessage` round-trip**, which is the
actual cost centre in the pool's dispatch path. Worth a new benchmark mode rather than a
feature — the project's own history says measure the premise first, and this premise has not
been measured.

### 8.4 ES2026 platform features worth adopting — **MEDIUM ROI**

ES2026 was approved 2026-06-30. Several features delete code this library has hand-rolled:

| Feature                                                              | Where it applies                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Uint8Array.prototype.toBase64` / `fromBase64` / `toHex` / `fromHex` | `powerBuffer.js`, `powerMessageCodec.js` — replaces manual base64 paths                             |
| `Math.sumPrecise`                                                    | `PowerHistogram` sum accumulation (currently naive `+=`, which loses precision on mixed magnitudes) |
| `Error.isError`                                                      | `utils/errors.js` — the project already hand-rolls a cross-realm error check                        |
| `Map.prototype.getOrInsert` / `WeakMap` upsert                       | `cache/core.js` bucket updates, `powerPool` ledgers                                                 |
| `Array.fromAsync`                                                    | async iteration over worker replies                                                                 |
| `Iterator.concat`                                                    | merging sorted bucket lists in `PowerHistogram`                                                     |

**Caveat.** This library targets Node ≥20.22 and browsers. Several of these need feature
detection and a fallback, which partly negates the "deletes code" benefit. Adopt only where
the fallback is trivial (`Math.sumPrecise`, `Error.isError`) and benchmark before adopting the
rest.

### 8.5 WebRTC / WebTransport backpressure watermarks — **MEDIUM ROI**

**Source:** RFC 8831 (WebRTC Data Channels) and the `rtc.io` backpressure guide.

`RTCDataChannel.bufferedAmount` grows without bound if `send()` outpaces the SCTP congestion
window; the browser eventually kills the connection. The standard fix is a **two-watermark**
scheme:

- **High watermark** (e.g. 16 MB): stop calling `send()`, hold bytes in a JS-side queue.
- **Low watermark** (e.g. 1 MB): resume, driven by the `bufferedamountlow` event with
  `bufferedAmountLowThreshold` set to the low watermark.

The default ratio is 1:16, and the guidance is to tune the _ratio_ before the absolute numbers.

**Recommendation.** `PowerRTCChannel` should expose `highWatermark` / `lowWatermark` options
and implement the pause/resume cycle, with a bounded JS-side queue (a separate
`queueBudget`, default 1 MB) so backpressure does not become an unbounded memory leak. This
is the single most valuable missing feature in the realtime family — without it, the helper
is unsafe for any payload above a few hundred KB, which is most real uses.

Note also RFC 8831's requirement that data channels be congestion-controlled _as a class or
in conjunction with SRTP media streams_ — worth documenting as a known limitation if
`PowerRTCChannel` does not participate in the PeerConnection's shared congestion window.

### 8.6 SSE `Last-Event-ID` reconnection — **LOW ROI**

`powerSseAdapter.js` reconnects but does not send `Last-Event-ID`, so every reconnect silently
drops events emitted during the gap. For a telemetry or log-streaming use case that is data
loss. Small, well-specified fix.

### 8.7 WebSocket `permessage-deflate` — **LOW ROI**

`bench/claims.js payload` already established that compression does not pay in-process. But
that measurement was about _in-process_ payloads; over a real network the trade is different.
Worth a benchmark mode rather than a default-on feature.

---

## 9. Refuted claims — checked and found NOT to be bugs

This section exists because several findings raised during this audit were wrong, one of them
labelled CRITICAL. Recording them is as valuable as recording the real ones: it stops the next
audit repeating the work, and it calibrates how much any single finding here should be trusted.

| #   | Claim                                                                                               | Verdict        | Why                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `powerWebSocketClient.js` registers **duplicate** message listeners, delivering every message twice | ❌ **Refuted** | `powerWebSocketClient.js:1142-1195` uses a strict `if`/`else` — `addEventListener` in one branch, `onmessage` in the other, never both. A comment at `:1146-1150` says so explicitly. The subagent read the two branches as sequential. |
| R2  | `powerPool` leaks idempotency keys when the pool is terminated                                      | ❌ **Refuted** | `powerPool.js:2967-2972` wraps `_postMessageInner` in `try/catch` and releases the key on throw.                                                                                                                                        |
| R3  | `powerBroadcastBus` double-decrements `receiverPendingCount` on ack-timeout race                    | ❌ **Refuted** | `powerBroadcastBus.js:71` calls `clearTimeout(entry.timer)` on ack, so the timeout callback cannot fire afterwards.                                                                                                                     |
| R4  | `PowerThrottle` over-refills after a backwards clock step                                           | ❌ **Refuted** | Traced and executed: preserving `_lastRefill` at the last valid reading credits exactly the real elapsed time. `test/powerThrottle.refill.test.js:23-33` pins this deliberately. The residual issue is narrower — see §5.1.             |
| R5  | `PowerSlidingWindow` has an off-by-one at the window boundary                                       | ❌ **Refuted** | `powerSlidingWindow.js:72-78` keeps `t > now - windowMs`, i.e. expires entries at least `windowMs` old. That is the conventional half-open sliding window, not a defect.                                                                |
| R6  | `PowerGCRA` allows `burst + 1` operations, one too many                                             | ❌ **Refuted** | Correct per GCRA theory: `burst` is the _tolerance_, so `burst + 1` operations fit in the window at idle. Matches the reference implementations.                                                                                        |
| R7  | `PowerRateLimit` key routing differs between `tryConsume` and `release`                             | ❌ **Refuted** | All four call sites use `this.keyFn(options.context ?? options)` identically. A comment at `:596-602` records the historical bug and its fix.                                                                                           |
| R8  | `PowerChunker` leaks a worker pool                                                                  | ❌ **Refuted** | `powerChunking.js:125` returns the pool to the caller, who terminates it. See §6.4 for the weaker ergonomics point.                                                                                                                     |
| R9  | Circular imports exist in `src/`                                                                    | ❌ **Refuted** | Full DFS over the import graph: zero cycles. The one hit was a JSDoc comment in `powerLogger.js`.                                                                                                                                       |
| R10 | Dead/unused exports exist                                                                           | ❌ **Refuted** | Every exported symbol is referenced somewhere in `src/`, `test/`, `bench/`, `examples/`, `guides/` or `scripts/`.                                                                                                                       |

**Lesson for the next audit.** The two most confidently-asserted wrong findings (R1, R4) were
both in files with _dense, accurate comments explaining exactly the behaviour in question_.
The subagent pattern-matched on the code shape and did not read the comment. When a file here
says "deliberately does X", verify before disagreeing — the project has a strong track record
of those comments being correct.

---

## 10. Features beyond the current set

Ranked by expected value to a realtime-heavy user.

### 10.1 Backpressure-aware realtime send path — **HIGHEST VALUE**

See §8.5. Without watermarks, `PowerRTCChannel` and `PowerWebTransportClient` are unsafe for
large payloads. This is the gap most likely to bite a real user.

### 10.2 A shared `ReconnectPolicy` — **HIGH VALUE**

See §6.1. Four copies today; one tested implementation after.

### 10.3 Cross-worker sketch merging — **HIGH VALUE**

See §2.8. `PowerHistogram.merge()` and `HyperLogLog` both advertise distributed use and
neither can actually cross a worker boundary. `fromJSON`/`toJSON` on both, plus a
`mergePlain()` that accepts a deserialised sketch.

### 10.4 Latency-aware cache eviction — **MEDIUM VALUE**

See §8.2. The GAMP finding that latency-aware policies beat hit-rate-optimal ones on tail
latency is directly relevant to a library that ships a DDSketch. A `missCost` hook on the
eviction path would let a caller weight evictions by what a miss actually costs them.

### 10.5 `PowerHistogram` t-digest or KLL mode — **MEDIUM VALUE**

DDSketch gives _relative_ error, which is right for latency. But it is one-way mergeable only
in the sense that it merges exactly — it cannot answer "give me the top-k heaviest contributors"
or do a streaming merge with bounded error on rank. A t-digest or KLL mode would cover the
rank-error use case. Lower priority than §8.1 because DDSketch is the correct default for the
library's stated purpose.

### 10.6 A `PowerFlowController` — **MEDIUM VALUE**

The library has limiters (admission), a semaphore (concurrency), and a bulkhead (isolation),
but nothing that combines _admission + queue depth + latency feedback_ into one closed loop —
which is what a realtime service actually needs. `PowerServo` is the closest thing and is
scoped to autoscaling. A flow controller that reads `PowerHistogram` p99 and adjusts a
`PowerGCRA` rate would compose existing primitives rather than add new ones.

### 10.7 WebTransport datagram priorities — **LOW VALUE**

`WebTransport` exposes per-datagram `sendOrder`. Exposing it would let a caller mark control
frames as high-priority. Niche, but cheap.

---

## 11. Implementation plan

Status icons: ✅ done · 🟡 partial · ⬜ not started · ⏰ deferred · ➖ resolved by deletion ·
❌ rejected

| Task ID | Status | Task                                                                                         | Priority | ROI       | Risk     | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ------ | -------------------------------------------------------------------------------------------- | -------- | --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUD-001 | ✅     | Fix `src/index.js` duplicate exports (4 lines)                                               | P0       | Very high | Very low | 5 min  | **Done, uncommitted.** Unblocked the entire suite. Concurrent session must still update `apiSurface.test.js`, `index.test.js`, `package.json` subpath count, and the `powerSseAdapter.js:150` `// ignore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AUD-002 | ✅     | Add a parse gate on `src/index.js` as step 0 of `scripts/verify.mjs`                         | P0       | High      | Very low | 15 min | **Done.** `scripts/check-barrel.mjs` _imports_ the barrel rather than `node --check`-ing it, because a duplicate export is syntactically valid and only fails at link time — a parse gate would have been green through the exact defect it was written for. Mutation-checked against both a duplicate export and a syntax error. Now step 1/12 of `verify.mjs`, before `lock:sync`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AUD-003 | ✅     | S3-FIFO: stop serving stale evicted values                                                   | P0       | Very high | Low      | 2 h    | **Done.** `_fetchValidNode` returns `null` and counts the miss when the node found in Small/Ghost has `queue === 'ghost'`. Re-admission still happens on the write path (`set` → `_updateExisting` → `_moveToTail`), which is what the ghost queue is for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AUD-004 | ✅     | S3-FIFO: null `value` on ghost append                                                        | P0       | High      | Low      | 30 min | **Done.** `_s3fifoAppendGhost` nulls `value`, `weight` and `expiresAt`. Landed with AUD-003 as required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AUD-005 | ✅     | S3-FIFO: exclude `_ghostSize` from `size`; fix `>=` → `>`                                    | P1       | High      | Low      | 1 h    | **Done, and the fix goes further than prescribed.** (a) `size` excludes ghosts; a `ghostSize` getter and a `stats().ghostSize` field expose them for diagnostics. (b) The Main loop bounds the **whole live set** (`_map.size + _smallSize > maxEntries`), not Main alone — the prescribed `>=` → `>` alone still let the total reach `maxEntries + 10%`, so it was insufficient on its own terms. (c) **A fourth defect found in the same function:** both Small-queue exit branches bypass `_unlinkNode`, so every Small entry leaving Small leaked its weight into `_currentWeight` permanently — 58 against 10 resident entries after 60 inserts. Both branches now subtract. The pinned test at `:72` was updated deliberately, with the reason recorded in the test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AUD-006 | ✅     | `PowerPool.drain()`: remove the abort listener in `release()`                                | P1       | High      | Very low | 15 min | **Done.** Reproduced the audit's exact figure — 5 retained listeners after 5 timed-out drains, 0 after the fix. Three regression tests, all mutation-killed. **A fourth test I wrote was deleted**: the aborted path could not fail on any mutation, because the explicit `removeEventListener` covers it and `{ once: true }` already did.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AUD-007 | ⬜     | `PowerRateLimit.reserve()`: fix the async `sharedState` path                                 | P1       | High      | Medium   | 3 h    | `powerRateLimit.js:551`. Split into `reserve()` / `reserveAsync()`. Verified: denied reservation reported as granted, and `release()` credits unspent permits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AUD-008 | ✅     | `_idempotencySweep`: stop materialising all keys per post                                    | P1       | Medium    | Very low | 30 min | **Done, and the fix goes further than prescribed.** The spread is gone — the sweep iterates `ledger.keys()` lazily, verified by counting iterator yields (33 for a 5000-key ledger, was 5000). **The rotating cursor the existing comment already claimed but the code never had is now real:** a head-only scan stops draining the moment the head is occupied by in-flight entries, which are never deleted, so every settled key behind more than one batch of them was retained past its TTL forever. The audit's prescribed fix alone does _not_ close that gap — verified by applying it in isolation and watching the cursor test fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AUD-009 | ❌     | `_reapIdleWorkers`: re-examine the swapped-in worker                                         | P2       | Medium    | Low      | 30 min | **Refuted by measurement — do not apply.** The claim is that the swap-and-decrement skips the swapped-in worker, so an idle worker survives a pass. It does not, and the reason is structural: the loop iterates from the **end**, so by the time it reaps at position `i` every worker above `i` has already been examined, and the swap moves an already-examined worker **down** into `i`. `_terminateWorker` mutates only the worker being terminated plus pool-level counters — never another worker`s `tasks`or`lastActive`, and never `this.workers`— so an earlier examination cannot be invalidated. Verified with 16 adversarial arrangements (all-idle, alternating, idle at every other index, one busy worker among ten, busy only at both ends, minSize 1/2/3): **every idle worker above`minSize` is reaped in a single pass, in all 16**. The audit`s own note concedes it is "self-healing today"; the measurement says there is nothing to heal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AUD-010 | ⬜     | `PowerMessagePort._attach`: stop clobbering caller handlers                                  | P2       | Medium    | Low      | 1 h    | `powerMessagePort.js:229-232`. The exact defect the class doc says it avoids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AUD-011 | ✅     | Replace cross-realm `instanceof` in the codec (2 sites)                                      | P2       | Medium    | Very low | 30 min | **Done.** `powerBuffer.js` already had a correct private `isSharedBuffer` doing the internal-slot check; exported it as `isSharedArrayBuffer` and used it at `frameTransferList`, plus the existing `isArrayBuffer` in `collectTransferables`'s walk. New `test/powerMessageCodec.crossRealm.test.js` (7 tests) uses a **real `node:vm` realm**, not a `{ byteLength: n }` stand-in — a stand-in is accepted by `new Uint8Array()` and would pass for the wrong reason. Includes sanity assertions that the fixtures really are foreign, and an impostor test pinning that a `Symbol.toStringTag` spoof is _not_ treated as a buffer. Mutation-checked: restoring both `instanceof` sites fails exactly the three cross-realm tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AUD-012 | ✅     | `PowerHistogram`: add `fromJSON`, accept plain sketches in `merge()`                         | P2       | High      | Low      | 2 h    | **Done.** Added `static fromJSON()` and `merge()` now accepts an instance, a cross-realm instance, or a `toJSON()` result. The check is **structural**, per the cross-realm rule — `instanceof` is false for a value from another realm, and `structuredClone` does not preserve the class at all, so a sketch arriving from a worker is a plain object that was never an instance of anything. **Two shapes exist and confusing them was the bug my first attempt had:** an instance carries private names (`_alpha`, `_count`) with `buckets` as a `Map`, while `toJSON()` carries public names (`relativeAccuracy`, `count`) with `buckets` as an array. Checking only one silently rejected the other — caught because the round-trip test failed. Fixed with a single `sketchFields()` normaliser so `merge()` does not branch per field. The bucket container is checked for **iterability** rather than `instanceof Map`, because a foreign realm's `Map` is not an instance of this realm's `Map` — the cross-realm rule applied to a container. Five tests, mutation-checked (restoring the `instanceof` check fails 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AUD-013 | ✅     | `PowerQueue`: add `dispose()` / `[Symbol.dispose]`                                           | P2       | Medium    | Very low | 30 min | **Done.** `dispose()` clears and then replaces `_buffer`, because `clear()` nulls the slots but deliberately keeps the array — which is the part a burst leaves behind. Four tests, mutation-checked two ways: removing the buffer reassignment fails the identity test; renaming `dispose()` so the class is not disposable fails **all four**, confirming the `using` / `await using` tests genuinely catch the method's absence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AUD-014 | ✅     | `PowerBroadcastBus.close()`: delete the zero entry                                           | P3       | Low       | Very low | 5 min  | **Done, and it needed a diagnostic to be testable.** The defect is pure retention with no behavioural symptom, so every test written against the public surface passed either way — including the pre-existing `close` test, which asserted only `getSlowConsumerIds()`. Added `getPendingCounts()`, a snapshot accessor in the same shape as the existing `getSlowConsumerIds()`, because "what is the bus still tracking" is the question an operator debugging this leak actually asks. Mutation-checked by restoring the `set(receiverId, 0)` branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AUD-015 | ✅     | `PowerHistogram.percentile()`: binary search over cumulative counts                          | P2       | Medium    | Low      | 2 h    | **Done, measured.** Replaced the linear walk with a lower-bound binary search over the `prefix` array `_bucketOrder()` already builds. O(log b) instead of O(b) in occupied buckets. A/B on the real class (20 000 percentile calls, 9 runs): **95.4 % faster at 200 occupied buckets, 99.4 % at 2 000** — the O(log b) against O(b) the row predicted. **The tests are explicitly labelled characterisations, not regression tests:** the old walk was correct, only slow, so no behavioural test can fail on the change — mutation-checked by restoring the walk, and the differential test passes either way. The benchmark is the evidence. **One process error worth recording: my first benchmark printed the labels backwards** (`a` was binary, `b` was linear, and I printed them swapped), which made the fix look 1 800 % _slower_. Caught by noticing the magnitude was implausible for an algorithmic change, not by the test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AUD-016 | ✅     | `PowerSlidingWindow._prune()`: shrink only on significant drop                               | P3       | Low       | Low      | 30 min | **Done, measured, and it broke a pinned test that had to be updated deliberately.** `_prune()` called `shrink()` unconditionally, and a sliding window is empty at _every_ boundary by design — so the ring was shrunk to the initial capacity and immediately regrown, forever. Measured on the real class by watching the backing array's identity (a capacity reading is blind to a shrink followed by a grow): **4 reallocations per window** at 100-per-window traffic, **6 at 400**. Traffic at or below the initial capacity never thrashed, which is why it went unnoticed. Now shrinks only when the prune crossed a boundary **and** the window that just ended needed less than half the ring — hysteresis, so the ring settles. Result: **1 reallocation total** across 200 windows at all three levels. **My first attempt made it worse (7/window)** by recording demand on every `tryConsume`; caught by re-running the measurement, not by reading. **The pre-existing pinned test `hands back the buffer a burst grew` was rewritten, not loosened**: it asserted a 5 000-burst into a capacity-8 192 window releases its ring, but 5 000 timestamps _need_ 8 192 slots, so that expectation was the thrash. The rewrite pins both directions — a correctly-sized ring is retained, a genuinely-dropped one is released — plus the bound that makes retention safe (the ring can never exceed the configured capacity).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AUD-017 | ❌     | `_grow()` in both queues: avoid holey arrays                                                 | P3       | Low       | Very low | 30 min | **Refuted by measurement — do not apply.** The premise is that `new Array(newCap)` "leaves holes that deoptimise `push`". Measured on the **real `PowerQueue` class** (A/B copy in-tree, 2 M push/shift cycles, 9 runs, 4 independent repetitions): `.fill(undefined)` is **17.5–18.9 % slower**, with spreads of 1.4–4.6 % in the stable runs. The reason is visible in hindsight: `.fill()` is an extra O(cap) pass on every grow, and grows happen _on the push path_, so the elements-kind saving never pays for the pass that buys it. A synthetic loop first suggested the opposite (+41 %) before GC noise at a 165 % spread made it meaningless — which is the same "reproduce against the real call path" lesson the project has already recorded four times.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AUD-018 | ✅     | `PowerQueue.fill()`: share `pushMany`'s bulk path                                            | P3       | Low       | Very low | 30 min | **Done, measured.** Grows once for the whole batch instead of testing capacity per item, then writes in contiguous blocks wrapping at most once per block — the same shape `pushMany` uses. A/B on the **real class** (200 k rounds of `fill(v, 8)` + drain, 9 runs, 4 independent repetitions): **13.1–18.1 % faster**, same direction every run. The two new tests are explicitly labelled **characterisations**, not regression tests: the old loop was correct, only slower, so no behavioural test can fail on the change — and one that claimed to would be decoration. The benchmark is the evidence; the tests pin that the refactor preserved wrap and weight behaviour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AUD-019 | ✅     | `collectTransferables`: fast-path flat payloads                                              | P3       | Low       | Low      | 1 h    | **Done — and the measurement redirected the work into fixing a regression the same change had introduced.** The proposed fast path was never built, because measuring the premise found something more important: **AUD-011, my own earlier change, had made `collectTransferables` ~30× slower.** `isArrayBuffer()` fell through to `Reflect.get(ArrayBuffer.prototype, 'byteLength', value)` inside a `try/catch` for any value failing the `instanceof` fast path, and that accessor **throws** for every primitive — an exception unwind per value, on a function called for _every value in a payload_. Fixed with a `typeof value !== 'object'` guard before the `try`: a primitive cannot be an `ArrayBuffer`, so the guard reaches the same answer without the exception. Measured in isolation: **735× faster** (1 986 ms to 2.7 ms per million calls). **A residual ~38× cost is recorded rather than fixed:** with the guard in place the walk still measures 1 312 ms against 34 ms for a `try`-free equivalent, because V8 declines to optimise a function whose call graph contains a `try/catch` — even though the `try` is never entered for a same-realm payload. Three structures were measured and none closed it (the `try` inline; the `try` isolated in a cold function; the cheap checks hoisted to the call site), all within 5 % of each other. Only removing the `try/catch` entirely recovered the speed, and that is not available: the spec accessor is the one unforgeable internal-slot check, and both non-throwing alternatives are spoofable. The reasoning and the numbers are in the `isArrayBuffer` docblock so the next reader does not re-derive them.                                                                                                                                                                                                                                                                       |
| AUD-020 | ✅     | `PowerBroadcastBus`: hoist the per-ack `TextDecoder`                                         | P3       | Low       | Very low | 5 min  | **Done.** Module-level lazily-created decoder via `getAckDecoder()`, mirroring `powerBuffer.getDecoder()` including the "there is none" answer — lazy rather than top-level so a missing global throws for nobody at import time. A pure performance change has no behavioural symptom, so the test counts `TextDecoder` constructions across three acks and asserts at most one; reverting to a per-ack `new` turns it red.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AUD-021 | ✅     | `PowerRateLimit.available()`: stop swallowing all errors                                     | P2       | Medium    | Medium   | 2 h    | **Done, mutation-checked.** A leg whose `available()` threw was indistinguishable from "no capacity" — both returned `false` — so a broken custom clock or a throwing third-party leg looked exactly like a rate limit, and `rejectionRate` reported a busy limiter rather than a broken one. The fault is now counted in `stats().legErrors` (and `getStats()`), cleared by `reset()`, and kept **out** of `rejectionRate` so the two are distinguishable. **Re-throwing was the audit's first preference and was rejected**, for two reasons recorded in the code: the commit path (`l.tryConsume(...)`) has no `try/catch` and already propagates, so re-throwing would make the _same_ fault surface differently depending on whether the leg happened to expose `available()` — a property of the limiter, not of the fault; and `tryConsume`'s documented contract is a boolean, so a caller composing limiters has no reason to wrap every call in a `try`. The pre-flight still refuses, which is the safe direction: a leg that cannot answer "can I afford this" is not a leg that should be charged. Six tests, mutation-checked (removing the counter fails 5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AUD-022 | ✅     | `PowerRateLimit.dispose()`: dispose per-slot limiters                                        | P3       | Low       | Very low | 30 min | **Done.** `dispose()` now calls `dispose()` on every built slot limiter before `fill(null)` drops them. `fill(null)` releases the _references_, which suffices for `PowerThrottle`/`PowerSlidingWindow`/`PowerGCRA` (state resets, no timers) but **not** for a slot whose caller-supplied factory returned something owning a resource. Guarded on `typeof === 'function'`, wrapped so one throwing slot cannot abort the rest. Five tests, mutation-checked (removing the loop fails 3). **Tripped the GATE-001 catch-justification gate**, which was correct to: my first comment was `/* swallow: … */`, a dismissal verb with no second clause. Rewritten to lead with the reason. One test I first wrote was wrong — it passed a bare `PowerGCRA` to a keyed composer, which the constructor rejects because `keyFn` requires factories; the "caller's own limiters" rule applies to the _unkeyed_ path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AUD-023 | ⬜     | Extract a shared `ReconnectPolicy`; adopt in all 4 transports                                | P1       | High      | Medium   | 1 d    | Collapses four independently-buggy copies of the same state machine into one tested one. Highest-value refactor in the realtime family.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AUD-024 | ✅     | RTC/WebTransport backpressure watermarks (`highWatermark`/`lowWatermark` + bounded JS queue) | P1       | Very high | Medium   | 2 d    | **Done, mutation-checked two ways.** The _detection_ half already existed (`highWaterMarkBytes`, `_backpressured`, `bufferedamountlow`, counters) but the _control_ half did not: `send()` called the platform unconditionally, so `isBackpressured` gated nothing and `bufferedAmount` grew without ceiling until the browser killed the connection. Added `lowWaterMarkBytes` (default `high / 16`) and `queueBudget` (1 MiB), the pause branch in `send()`, `_drainQueue()` driven by `bufferedamountlow`, the budget refusal counted in `droppedFrames`, `queuedBytes`/`queuedFrames` getters, and queue-drop on `dispose()`. **`bufferedAmountLowThreshold` moved from the high mark to the low mark** — it was the high mark, which made the event fire the moment the buffer returned to the level the channel had paused at, so it resumed where it paused and oscillated at roughly one frame per drain cycle. A two-watermark scheme with one watermark is a detector, not a controller. **Three pre-existing pinned tests were rewritten, not loosened**, each with the reason recorded: the threshold assertion, the `sent: 5` count (now `sent: 1, queuedFrames: 4`, because held frames are counted separately), and the structural "exactly one watermark option" claim — that inference was wrong in the direction that mattered, since the push signal makes a second watermark _cheap_, not unnecessary, and a single mark cannot express pause-and-resume. Nine new tests; disabling the pause branch fails 6, reverting the threshold fails 1. The RFC 8831 shared-congestion-window limitation is now documented in the guide rather than left to discover.                                                                                                                                                                                                                                                                                    |
| AUD-025 | ✅     | SSE `Last-Event-ID` on reconnect                                                             | P3       | Medium    | Very low | 2 h    | **Done, mutation-checked.** The adapter is **server-side** — the browser's `EventSource` does the reconnecting — so the bug was not missing reconnect logic but a missing `id:` field. SSE reconnection is client-driven: an `EventSource` that loses its connection reconnects on its own and sends `Last-Event-ID` carrying the last `id:` the server emitted. This adapter wrote only `data:` lines, so there was never an `id:` to remember, the header was never sent, and every reconnect silently dropped the gap. It now emits a per-subscriber monotonic `id:` before every `data:` line, in **one write** (they are one SSE event block and the spec dispatches them together; two writes would be back-pressure the caller pays for nothing). It also reads `Last-Event-ID` from the request headers on register and exposes it through `lastEventId(sub)`, with `lastSentId(sub)` as the server-side counterpart — the difference between the two is exactly the gap a reconnect must replay. **The adapter deliberately does not replay**: it holds no buffer of past frames, it is a `send(sub, frame)` bridge, and a replay buffer is the message source's concern. What it owes the caller is the resume _point_. The pre-existing pinned test `writes one base64 data line per frame` was **rewritten, not loosened** — it asserted `lines[0]` matches `/^data: /`, which is the very absence the fix removes. Seven tests, mutation-checked (removing the `id:` field fails 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AUD-026 | ⬜     | Replace `HyperLogLog` with UltraLogLog                                                       | P2       | High      | Medium   | 2 d    | §8.1. 24-28% less memory at equal accuracy. **Needs a new `bench/claims.js` mode first** — no cardinality benchmark exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AUD-027 | ⬜     | Add `2Q-SIEVE` and `S3-FIFO-SIEVE` cache policies                                            | P2       | High      | Medium   | 2 d    | §8.2. Both are small deltas on existing code. **Must follow AUD-003/004/005.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AUD-028 | ⬜     | Adaptive cache policy selection (hill-climbing, opt-in)                                      | P3       | High      | High     | 1 w    | §8.2. Gate behind a flag with its own benchmark mode. An adaptive policy that picks wrong is worse than a fixed suboptimal one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AUD-029 | ✅     | Adopt ES2026 features where the fallback is trivial                                          | P3       | Low       | Low      | 1 d    | **Done, and the row's named fix turned out not to apply — the underlying defect is real and was fixed a different way.** **`Error.isError` was already fully adopted**: grepping the whole defect class rather than the single site the audit named, every `instanceof Error` in `src/` is either a comment explaining why `isError()` is used instead, or the fallback inside `utils/errors.js` itself. **`Math.sumPrecise` does not apply**, and this was measured rather than assumed: the precision loss is real (recording `1e16` then a thousand `1`s gave a `sum` of `1e16`, absolute error **-1000**), but `sumPrecise` sums an **iterable** and a DDSketch does not retain its values — O(1) memory for an unbounded range is the entire point of the format. It is also `undefined` on this library's declared floor (`engines.node` is `>=22.12`), so it would need a capability probe and a fallback, which is the "partly negates the benefit" case the audit itself warns about. **So the accumulator is Neumaier-compensated instead**, which is the technique an _incremental_ sum requires: each add keeps the error it could not represent in `_sumCompensation`, and the `sum` getter returns the pair. Measured after: absolute error **0**. All five sum sites migrated — `record()`, `merge()`, `reset()`, `fromJSON()` and `toJSON()` — and `merge()`/`sketchFields()` read `src.sum` (the getter on an instance, the stored field on a plain sketch) so both shapes contribute their real total; reading the private `_sum` would have dropped the other sketch's compensation. Six tests, mutation-checked (reverting to naive `+=` fails 4). **Adding `check:bench-list` after `docs:drift` broke a pinned assertion in `test/verifyGate.test.js`** that `docs:drift` is last; rewritten to assert the property it was really about — that `docs:drift` is the last step which _regenerates_ a committed tree — with the reason recorded. |
| AUD-030 | ⬜     | `Atomics.waitAsync` benchmark mode (not a feature)                                           | P3       | Unknown   | Low      | 1 d    | §8.3. The existing `permit` mode measured a _permit pool_; blocking on a shared counter is a different premise and has not been measured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AUD-031 | ⬜     | `PowerFlowController` composing histogram + GCRA                                             | P3       | High      | Medium   | 3 d    | §10.6. Composes existing primitives rather than adding new ones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AUD-032 | ⬜     | Latency-aware eviction (`missCost` hook)                                                     | P3       | Medium    | Medium   | 2 d    | §10.4. GAMP found latency-aware policies beat hit-rate-optimal ones on tail latency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AUD-033 | ✅     | Generate the `AGENTS.md` benchmark list from `bench/claims.js`                               | P3       | Low       | Very low | 1 h    | **Done, mutation-checked in both directions.** `scripts/check-bench-list.mjs`, now step 13 of `verify`. It runs `bench/claims.js` with a nonsense mode, reads the mode list out of the harness's **own generated unknown-mode error**, and compares it against the `node bench/claims.js <mode>` lines in `AGENTS.md` — failing in either direction. **The probe rather than a parse of `MODES`, deliberately:** a regex over an object literal stops matching the day someone reformats it, and a gate that silently stops matching is a failure this project has already recorded several times. Exporting `MODES` was the other option and was rejected — it would make a benchmark harness a library surface for the benefit of one check. **The gate earned its place immediately:** it found real, current drift — `AGENTS.md` documented 25 modes against 28 in the table, missing `geoencode`, `geocoalesce` and `geoprecision`. Those three were added with descriptions taken from the workload headers in `bench/claims.js` rather than guessed, "all twenty-five" became "all twenty-eight", and the closing "treat `bench/claims.js` as the authority" caveat was replaced with a statement that the list is now **checked rather than trusted**. Mutation-checked: removing a documented mode is caught as "exists but undocumented", and adding a bogus one is caught as "documented but does not run".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AUD-034 | ⬜     | CI job: fail if `review.md` is absent on a non-`main` branch                                 | P3       | Medium    | Low      | 2 h    | §7.8. The plan table currently has no automated guard at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AUD-035 | ❌     | WebSocket duplicate-listener fix                                                             | —        | —         | —        | —      | **Refuted (R1).** The code is correct; a comment says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AUD-036 | ❌     | `PowerThrottle` backwards-clock over-refill fix                                              | —        | —         | —        | —      | **Refuted (R4).** Accounting is correct and pinned by a test. See AUD-037 for the real, narrower issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| AUD-037 | ✅     | `PowerThrottle`: handle a _permanent_ backwards clock step                                   | P3       | Low       | Low      | 2 h    | **Done, mutation-checked.** `_refill()` now counts _consecutive_ backwards clock observations and, after `BACKWARD_CLOCK_TOLERANCE` (3), clamps `_lastRefill` to the regressed clock so refill resumes. Any forward step resets the counter, so a clock that jitters backwards occasionally never reaches the threshold — which is why the threshold is a count rather than a duration. `reset()` re-seeds the baseline and clears the counter. Four tests, mutation-checked (removing the clamp fails 2). The pre-existing pinned test `clamps suspension jumps and ignores backward clock steps` still passes untouched: one backwards observation is below the tolerance, so the transient behaviour it pins is preserved exactly. **Adding the constant broke `test/apiSurface.test.js`**, which pins the internal constants module deliberately — updated with the new name in sorted position and a comment saying it was added deliberately rather than swept in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AUD-038 | ❌     | `PowerSlidingWindow` boundary off-by-one fix                                                 | —        | —         | —        | —      | **Refuted (R5).** Conventional half-open window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| AUD-039 | ❌     | `PowerGCRA` burst off-by-one fix                                                             | —        | —         | —        | —      | **Refuted (R6).** Correct per GCRA theory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AUD-040 | ✅     | `PowerHistogram`: honour or warn on ignored `bucketCount`                                    | P3       | Low       | Very low | 1 h    | **Done.** Warns once per process when `bucketCount` is set, naming `relativeAccuracy` as the option that actually controls precision. Honouring it was the alternative and was **rejected**: `bucketCount` and `relativeAccuracy` are two spellings of the same knob, so mapping one to the other would silently override an explicitly-passed `relativeAccuracy` whenever both were set. Once per process rather than per instance, because the warning is about the _option_, which does not change between instances. Four tests, mutation-checked (removing the warning fails 2). The tests use `vi.resetModules()` because the flag is module-level and the pre-existing tests in the same file construct histograms with `bucketCount` at lines 7, 22, 34 and 64 — so a plain construction warns nothing by the time these run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AUD-041 | ❌     | `PowerChunker`: `using`-compatible pool wrapper                                              | P3       | Low       | Low      | 2 h    | **Refuted — already satisfied by existing code.** The audit says "the class itself has no `dispose()`" and proposes "a `using`-compatible wrapper". But `PowerChunker`'s constructor **returns the `PowerPool` it builds** (both the array and streaming paths `return pool`), and `PowerPool` has had `dispose()`, `[Symbol.dispose]()` and `[Symbol.asyncDispose]()` since before this audit. Verified by execution: the object `new PowerChunker(...)` hands back exposes all three, `constructor.name` is `PowerPool`, and a `using` block around it terminates the pool on scope exit. So the "forgot to terminate" leak the row is about is already preventable, and a wrapper would add a layer that forwards to symbols that already exist. Nothing to do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AUD-042 | ⬜     | `PowerHistogram`: accept negative values (sign-magnitude)                                    | P3       | Low       | Medium   | 3 h    | §5.4. Latency _deltas_ are legitimately negative. Currently throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Recommended sequencing

**Wave 1 — unblock and stop the bleeding (½ day).** AUD-001 (done), AUD-002, AUD-003, AUD-004,
AUD-006, AUD-008. All are small, all are verified, and AUD-003/004 together remove a silent
data-corruption path and a memory leak from the same policy.

**Wave 2 — correctness in the less-exercised paths (2-3 days).** AUD-005, AUD-007, AUD-009,
AUD-010, AUD-011, AUD-012, AUD-013. These are the findings in code that has fewer tests around
it, which is exactly where the next production bug will come from.

**Wave 3 — performance and quality (3-5 days).** AUD-015 through AUD-022, AUD-023. Benchmark
each before and after; the project's own rule is that an unmeasured improvement is a
hypothesis.

**Wave 4 — new capability (2-4 weeks).** AUD-024 first (highest real-world value), then
AUD-026/027 (with benchmarks), then the rest as capacity allows.

### Verification standard for every row above

Per this project's own conventions, each task is not done until:

1. A test exists that **fails without the fix** — verified by reverting the fix and watching it
   go red. A test that passes either way is decoration and should be deleted, not kept.
2. `npm run verify` is green, including `types:drift` and `docs:drift` (regenerate `types/`
   **and** `docs/` _before_ staging, never after).
3. A changeset in `.changeset/` — mandatory unless the change is docs-only.
4. For any performance claim, a `bench/claims.js` mode that measures it on the real call path,
   not a synthetic harness.
5. The review row closed in the same commit as the work.

---

## 12. What this audit could not cover

- **`bench/` was not run.** Each mode takes minutes and the full harness over an hour. No
  performance claim in §4 is benchmarked — they are code-shape observations only.
- **Coverage was not measured.** `npm run test:coverage` requires a working build; with
  AUD-001 fixed it should now run, but I did not run it.
- **`docs/` and `types/` drift was not checked.** Both are generated and both need
  regeneration after any JSDoc change; several findings here would touch JSDoc.
- **The observability family was only partly audited.** `powerServo`, `powerEventBus`,
  `powerCron`, `powerTTLMap`, `powerObserver`, `powerEventLoopMonitor`, `metrics.js` and
  `powerBrownout` were scanned for patterns but not read line-by-line. The subagent dispatched
  for them returned empty twice. **This is the largest remaining gap.**
- **The concurrency family beyond limiters was not audited.** `powerBulkhead`,
  `powerCircuit`, `powerScheduler`, `powerCrossLock`, `powerDeadline`, `powerBatch`,
  `powerDeduplication`, `powerSemaphore` — pattern-scanned only.
- **`powerRealtimeHub`, `powerSocketAdapter`, `powerDatagramChannel`, `powerWebTransportClient`,
  `powerRTCChannel`** were audited by subagent and the results were plausible but I did not
  independently verify each finding the way I did for §2 and §3. Treat §8.5 and §10.1 as
  well-founded feature recommendations, but re-verify any specific defect claim in those files
  before acting on it.
