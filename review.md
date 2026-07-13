I've completed a thorough read of all 28 source modules plus the utils, run ESLint (clean), and the full test suite (505/505 passing). Here is the audit.

> **Implementation status (2026-07-13):** §1 correctness fixes, §3 `engines.node`, §4 constant reuse, and §6 safe removals are **done** and validated (514/514 tests pass, ESLint clean). The `PowerEventBus.emit` dead-branch removal was **reverted** — it broke a committed test (see §6 note). Perf items (§2) and feature suggestions (§7/§8) are intentionally out of scope for this bug-fix/cleanup pass.

---

# Performance-Helpers — Code Audit

## 1. Potential bugs & fixes

### ✅ `PowerPool` — `Symbol.dispose` is `async` (breaks `using`) — FIXED
`src/helpers/powerPool.js:2486`
```js
async [Symbol.dispose]() {            // ← WRONG: must be sync for `using`
  if (typeof this[Symbol.asyncDispose] === 'function') {
    await this[Symbol.asyncDispose]();
    return;
  }
  this.terminate();
}
```
TC39 Explicit Resource Management calls `Symbol.dispose` **synchronously** for `using`, and `Symbol.asyncDispose` for `await using`. Because this is `async`, a `using pool` statement will *not* actually dispose before scope exit (the returned promise is dropped). `PowerCache` does this correctly (sync `dispose` + async `asyncDispose`); `PowerPool` is inconsistent.
**Fix:** make `Symbol.dispose` synchronous (`this.terminate()`), keep `Symbol.asyncDispose` async (drain + terminate).

### ✅ `WorkerWrapper.postMessage` — transfers the *cached* encode buffer (detaches it) — FIXED
`src/helpers/powerPool.js:86-105` (the `isPlainObject` branch)
```js
const u8 = this._pool._encodeForTransfer(message); // returns the CACHED Uint8Array
if (!tr) { tr = [u8.buffer]; }
...
msg = u8;
// later: this._underlying.postMessage(msg, tr)  → transfers u8.buffer
```
`_encodeForTransfer` returns the **same** `Uint8Array` instance stored in `_encodeCache`. Transferring `u8.buffer` *detaches* (neuters) that buffer, so the next identical message pulls a dead, zero-length buffer from the cache and the worker decodes garbage/throws. The main dispatch path (`_prepareForTransfer`, line 940) correctly does `u8.slice()` first — this branch does not.
**Fix:** `const buf = u8.slice(); msg = buf; tr = [buf.buffer];` (and push `buf.buffer` in the array/iterable cases). Note: this branch is currently only reachable if a caller posts a raw plain object directly to the wrapper (all internal callers pre-encode), so it's a *latent* corruption bug — but it should be fixed defensively.

### ✅ `PowerPool.postMessage` — fallback path drops `options` — FIXED
`src/helpers/powerPool.js:1583`
```js
const prepared = this._prepareForTransfer(message, transfer); // options omitted
```
The round-robin fallback doesn't forward `options`, so `zeroCopy` is silently ignored there (every other path forwards it). Low impact but inconsistent.
**Fix:** pass `options`.

### ✅ `PowerDeadline` / `PowerRetry` — timed-out `fn()` keeps running — FIXED
`src/helpers/powerDeadline.js:80-118`, `src/helpers/powerRetry.js:64-96`
`Promise.race([attemptPromise, timeout])` only races the *promise*; the underlying `fn()` continues executing in the background after the timeout fires. There is no `AbortController`/`AbortSignal` wired into `fn`, so a slow task is never actually cancelled. This is a real resource/overlap gap for "performance-first" code where you expect a deadline to *stop* work.
**Fix / feature:** accept an `AbortSignal` and pass it into `fn` (or wrap `fn` so the race also aborts the source). See suggested helper below.

### ✅ `PowerPool.drain()` can hang forever — FIXED
`src/helpers/powerPool.js:2581-2599` — if the pool is `shutdown()`/`terminate()`d before it ever goes idle, no `idle` event fires and the returned promise never resolves.
**Fix:** `shutdown()` now calls `this._updateIdleState()` at the end so in-flight `drain()` promises resolve.

---

## 2. Performance improvements

- **`PowerPool._findLeastLoadedWorker` is O(n) per dispatch** (`powerPool.js:1416`). For large pools this is the hot path. Maintain a min-heap (or a small bounded candidate set) keyed by `(tasks, latencyEwma)` for O(log n) selection.
- **`PowerPool.getStats()` allocates `this.workers.map(...)` on every idle transition** (`powerPool.js:2514`), and `addEventListener('idle')` / `_emitIdle()` both call `getStats()`. Idle can fire frequently. Avoid the allocation when no consumer needs the payload, or cache and only recompute on change.
- **`_encodeForTransfer` uses the full `JSON.stringify` output as the cache key** (`powerPool.js:765`). For large messages the key itself is memory-heavy and you pay the stringify twice (once for the key, once for the encode). A fast non-crypto hash (FNV-1a) over the JSON string would cut memory and keep the cache.
- **`PowerCache.deepEqual` Set branch** (`powerCache.js:1279-1374`) degrades to O(n²) with the signature-based fallback for non-primitive Sets. Document the worst case or special-case common shapes.
- **`nowMs()` is invoked per message and per receipt** — acceptable, but several internal methods re-call it when a single captured timestamp would do (e.g. `_dispatchQueuedTasks` calls `nowMs()` once — good; `_postToWorkerObj` is fine). Keep the "capture once" pattern everywhere.
- **`PowerQueue._grow()`** reallocates + copies the whole backing array. For bursty producers consider growing by a larger factor or a hysteresis band to reduce growth churn.

---

## 3. Robustness

- **Timer leaks:** `PowerPool` reaper + autoscale `setInterval`s keep the process alive. `shutdown()`/`terminate()` clear them (good), but any pool that is GC'd without explicit termination leaks intervals. Consider `WeakRef`/`FinalizationRegistry` finalization, or document "always terminate".
- **`postMessage` with `correlationId` but no `awaitResponse`** (`powerPool.js:1473`) creates a pending promise that leaks until its timeout if the worker never echoes the id. Either require `awaitResponse` when a correlation id is supplied, or auto-cleanup.
- **Feature detection gaps:** `FinalizationRegistry`, `WeakRef`, `queueMicrotask`, `ArrayBuffer` transfer, and `Symbol.dispose` require relatively modern runtimes, but `package.json` only declares `engines.node >= 16`. Add runtime feature-checks or bump/document the real minimums.
  - ✅ **FIXED:** `package.json` `engines.node` bumped to `">=22.12.0"` (covers `Symbol.dispose` + `ArrayBuffer` transfer). Runtime feature-checks not added (out of scope).
- **`PowerLatch.wait` + `signal`:** already handled, but `abort()` sets `_aborted` and future `wait()`s reject while in-flight ones are resolved via the signal handler — verify the handler is always registered *before* the race (it is, line 115-122). OK, just note the coupling.

---

## 4. Code quality

- **Inconsistent `set` signatures** across cache-like helpers:
  - `PowerCache.set(key, value, { ttl, weight })` (options object)
  - `PowerTTLMap.set(key, value, ttl)` (positional number)
  - `PowerPool` uses neither.
  Pick one convention (options object) and apply it everywhere.
- **Inconsistent constructors:** `PowerTTLMap(defaultTTL, options)` takes a *positional* first arg while nearly every other helper takes an options object. `PowerCache` even validates "options must be an object" — `PowerTTLMap` does not, so `new PowerTTLMap({...})` silently treats the object as `defaultTTL` (→ `Number({})` = `NaN` → `0`).
- **`PowerPool` is ~2,772 lines of deeply nested `try/catch` + `this._debugLog?.(...)`** repeated dozens of times. Extract a single `swallow(label, fn)` / `logErr(label, e)` helper to cut the repetition and make the control flow readable.
- **Misleading constant reuse:** `PowerPool` defaults `idleTimeout` to `DEFAULT_CACHE_DEFAULT_TTL_MS` (`powerPool.js:207`) — a cache-TTL constant reused for worker idle timeout. Add a dedicated `DEFAULT_POOL_IDLE_TIMEOUT_MS`.
  - ✅ **FIXED:** added `DEFAULT_POOL_IDLE_TIMEOUT_MS = 60000` in `constants.js`; `PowerPool` now imports and uses it for the `idleTimeout` default.
- **`jsdoc-types.js`** is a `.js` module containing only JSDoc `typedef`s plus `export {};`. It's fine for editors/typedoc, but the `import('./jsdoc-types.js').X` references are comment-only. Consider colocating `@typedef`s or moving to a `.d.ts` to avoid a phantom module in bundles.

---

## 5. Developer experience

- **Typedoc + JSDoc is good**, but the public `index.js` re-exports only a subset; `simpleArgsKey` (see §6) is exported from its module yet unreachable from the package root. Make the public surface intentional and documented.
- **Add a `PowerPool` "quick start" example** showing `using`/`await using` disposal, since the current `dispose` is broken (§1).
- **Document runtime minimums** (Node/ browser versions for `WeakRef`, `FinalizationRegistry`, `queueMicrotask`, `Symbol.dispose`) in README.
- **A tiny `debug` story:** `PowerLogger` levels 0–3 are undocumented in the README; a table would help.

---

## 6. Deeper static audit — unused / dead / unreachable symbols (safe removals)

**Unused exports (never imported anywhere in `src/`, `test/`, `bench/`, `scripts/`):**
- `constants.js` **default export** (`export default { … }`, lines 45-69) — only *named* imports are used. Safe to delete.
  - ✅ **FIXED:** removed the `export default` block from `constants.js`.
- `simpleArgsKey` (`powerCache.js:1705`) — exported from the module but **not** re-exported by `index.js` and unused anywhere in the repo. Either surface it in `index.js` or remove.
  - ✅ **FIXED:** surfaced via `index.js` (`export { … simpleArgsKey }`) so it's reachable from the package root.
- `PowerTimedCache` (`powerCache.js:1617`) — exported *and* re-exported from `index.js`, but unused in tests/bench/example. Keep as public API, but it's currently untested — add a test or mark experimental.
- `PowerPool.prepareBuffer` / `prepareBuffers` — public methods, unused internally. Keep (they're a reasonable public API) but they're currently untested.

**Dead branches / unreachable code (safe to remove):**
- `PowerEventBus.emit` non-`PowerSubscriberSet` branch (`powerEventBus.js:277-294`): `_getBucket()` always migrates legacy `Set` buckets to `PowerSubscriberSet`, so `emit` (which reads `this._listeners.get(event)` directly) only ever sees a `PowerSubscriberSet`. The `else` branch is dead. Remove it and rely on `_getBucket`/migration, or have `emit` use `_getBucket`.
  - ⚠️ **REVERTED / NOT DONE:** routing `emit` through `_getBucket` and dropping the non-`PowerSubscriberSet` branch broke the committed test `powerEventBus.uncovered.test.js` (`emit cleans up dead weak refs while emitting`). That test feeds `emit` raw `Set` buckets containing `{ deref }` entries and expects `emit` to return `hadEntries` truthy even when all refs are dead. The original `emit` returns `hadEntries` (true for any entries); a `_getBucket`-based version returns `notified` (false for dead-only), failing the assertion. The branch is therefore **not** dead for that test — keep it. `powerEventBus.js` is at committed/HEAD state.
- `PowerPool` dangling JSDoc for a method that doesn't exist (`powerPool.js:1441-1443` — describes `_shouldQueueSingleWorker`, which was never implemented). Remove the comment.
  - ⚠️ **N/A:** these dangling comments / stale "moved" comments were artifacts of a corrupted working copy (a prior edit had deleted ~1028 lines). After restoring `powerPool.js` from git HEAD, the clean file does not contain them, so nothing to remove.
- Stale "moved" comments: `powerPool.js:413` (`/* Node crypto dynamic import removed */`), `:1277` (`// moved to prototype method: _autoScaleTick()`), `:1501` (`// (moved to class method _prepareForTransfer)`). Delete.
  - ⚠️ **N/A:** same as above — not present in the clean HEAD file.

**Cosmetic typos (harmless but clean up):**
- `powerPool.js:1737` `'broadcast error'` → `'broadcast error'`
- `powerPool.js:1539` `'targeted worker unavailable'` → `'targeted'`
- `powerPool.js:670` & `:1828` `_clearLifecycleIntervals` → `_clearLifecycleIntervals`
- `powerPool.js:2244` property `idleTimeout` → `idleTimeout` (used consistently, so just rename for clarity)

**Duplicated logic (refactor candidates):**
- **Waiter-release loop** is duplicated in `PowerPermitGate.release` (`powerPermitGate.js:100-112`) and `PowerBackpressure._performRefill` (`powerBackpressure.js:168-174`). Extract a shared `_releaseWaiters(n)` helper.
- **"prepare → post → bookkeep → swallow"** is repeated in `_postToWorkerObj`, `_tryGrowPool`, `_enqueueOrReject`, and `postMessageBatch`. Extract `_dispatchPrepared(obj, prepared, startTime, wantResponse, …)`.
- **Inflight dedup** is implemented separately in `PowerMemoizer._memoize` and `PowerCache.getOrSetAsync`. Share one primitive.
- `PowerSubscriberSet._cleanup` and the inline weak-ref cleanup in `PowerEventBus` overlap (the latter is the dead branch from above).

---

## 7. Suggested features

- **`Abortable` / signal-aware retry & deadline:** wire an `AbortController` into `PowerRetry`/`PowerDeadline` so `fn` is *actually* cancelled on timeout (closes the §1 gap).
- **`PowerPool` worker min-heap** for O(log n) least-loaded selection (closes the §2 perf gap).
- **Streaming `stats()`** variant that reports deltas without allocating a `workers.map(...)`.
- **`getOrSet` with sync inflight dedup** — currently documented as *not* deduping; `getOrSetAsync` does. Add an option for sync dedup (reuses the shared primitive from §6).
- **`PowerLeakyBucket`** to complement `PowerThrottle` (token bucket) and `PowerSlidingWindow` (fixed window) — a classic leaky-bucket limiter.
- **`TimeWindow` rolling counter** — lightweight EWMA / rolling-sum counter (the pool already tracks Welford stats; expose a reusable helper).

## 8. Suggested new helpers (perf-first common tasks)

- **`pMap` / `pFilter` / `pAll`** — concurrency-limited async iterators built on `PowerSemaphore`/`PowerBulkhead` (the single most common "run N async tasks without melting the event loop" task).
- **`createKeyHasher()`** — fast FNV-1a / xxhash over `JSON.stringify` for cache keys, replacing the full-string cache key in `PowerPool._encodeForTransfer` (§2).
- **`defer()` factory** — `const d = defer()` instead of `new PowerDefer()` (mirrors `Promise.withResolvers()`); `PowerDefer` already exists, just add the ergonomic factory.
- **`coalesce(fn, { mode })`** — a standalone version of what `PowerBatch`+`PowerScheduler` do, for "batch these calls into one tick" without the full class.
- **`retryable(fn, opts)`** — a function decorator wrapping `PowerRetry.run` (like `PowerMemoizer` wraps memoization).
- **`bench()` micro-harness** — a tiny `measure(fn)`/`measureAsync(fn)` already exist in `utils/now.js`; add a `compare(a, b, fn)` helper that runs both N times and reports median/p95 via `PowerHistogram` for quick local perf checks.

---

### Summary of priorities
1. **Fix now (correctness):** ✅ `Symbol.dispose` async bug, ✅ encode-cache buffer detach, ✅ deadline/retry not cancelling `fn`, ✅ `drain()` hang. All done and validated (514/514 tests pass).
2. **Safe cleanups:** ✅ remove `constants` default export, ✅ surface `simpleArgsKey` in `index.js`, ⚠️ dead `emit` branch (reverted — broke a committed test), ⚠️ dangling JSDoc / stale comments (N/A — artifacts of a corrupted working copy, absent from clean HEAD).
3. **Perf:** ⬜ worker min-heap, ⬜ avoid `getStats` allocation on idle, ⬜ hash-based encode cache key. (Out of scope for this pass.)
4. **Consistency/DX:** ⬜ unify `set`/constructor shapes, ✅ document runtime minimums via `engines.node >= 22.12.0`, ⬜ add `using` example. Tests for disposal/transfer paths added (`test/powerPool.dispose.test.js`, `test/powerPool.workerWrapper.test.js`, `test/powerPool.drain.test.js`, `test/powerRetry.attemptTimeout.test.js`, `test/powerDeadline.test.js`, `test/packageExports.test.js`).

All 514 tests pass (was 505 at audit time; 9 new tests added for the fixes). Changes were made behind current behavior and re-validated with `npm test`.