# performance-helpers

[![npm version](https://img.shields.io/npm/v/performance-helpers.svg)](https://www.npmjs.com/package/performance-helpers) [![npm downloads](https://img.shields.io/npm/dm/performance-helpers.svg)](https://www.npmjs.com/package/performance-helpers) [![GitHub stars](https://img.shields.io/github/stars/AbelVM/performance-helpers.svg)](https://github.com/AbelVM/performance-helpers/stargazers) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

![logo](assets/logo.png)

Highly tuned lightweight toolbox for high-performance Node/browser code: zero-copy buffer helpers for worker messaging, an LRU TTL cache with a memoizer, a fully-featured worker pool wrapper, a tiny runtime debug logger, and much more:

## Caching

- [PowerCache: Caching (LRU + TTL + weight) and memoizing](guides/powerCache.md). An in-memory, memory-efficient LRU cache with TTL, weighted eviction and an optional reusable node pool.
- [PowerTTLMap: Map with per-key TTL](guides/powerTTLMap.md). Lightweight `Map`-like store where keys expire lazily on access.

## Parallelizing

- [PowerPool: Worker pool](guides/powerPool.md). A small, dependency-free worker pool that wraps underlying Worker instances.
- [PowerChunker: Chunk + pool helper](guides/powerChunking.md). Convenience helper to chunk iterables and process items via a `PowerPool`.
- [PowerBulkhead: Partitioned executor](guides/powerBulkhead.md). Isolate noisy workloads into separate lanes so one hot partition cannot starve the rest.
- [PowerCircuit: Circuit breaker](guides/powerCircuit.md). Small circuit breaker to protect external services from cascading failures.
- [PowerRetry: Retry with backoff](guides/powerRetry.md). Helper for retrying flaky async operations with configurable backoff and jitter.
- [PowerDeadline: Timeout, retry budget, and cancellation](guides/powerDeadline.md). Wrap async work with per-attempt timeouts, overall deadlines, and retry policy.
- [PowerHistogram: Lock-free percentile estimator](guides/powerHistogram.md). Compact in-process histogram for latency telemetry and estimated percentiles.
- [PowerBackpressure: Producer-facing backpressure controller](guides/powerBackpressure.md). Gate producers with adaptive refill and bounded waiting.
- [PowerBatch: Microtask coalescing dispatcher](guides/powerBatch.md). Coalesce synchronous calls into compact batches for bulk operations.
- [PowerLatch: Counting barrier](guides/powerLatch.md). Simple barrier that resolves when a count reaches zero. Useful for coordinating out-of-band task completions.
- [PowerThrottle: A token-bucket limiter](guides/powerThrottle.md). A tiny rate limiter useful for pacing external work or cooperating with `PowerPool`. New: supports `reserve()`/`release()` for reservation-style workflows.
- [PowerRateLimit: Compose multiple limiters](guides/powerRateLimit.md). Combine `PowerThrottle`, `PowerSlidingWindow` and others; supports an `atomic` option to attempt atomic consumes across composed limiters.
- [PowerSlidingWindow: Sliding-window limiter](guides/powerSlidingWindow.md). A simple rolling-window limiter for quota-style rate limiting.
- [PowerQueue: O(1) ring-buffer queue](guides/powerQueue.md). A resizable, high-performance queue intended for use in `PowerPool` and other high-throughput scenarios.
- [PowerSemaphore: Async concurrency gate](guides/powerSemaphore.md). Lightweight semaphore for limiting concurrent I/O and fan-out workloads.
- [PowerEventBus: Typed micro event bus](guides/powerEventBus.md). Lightweight pub/sub for intra-process coordination between helpers.

## Logging

- [PowerLogger: Gated logging](guides/powerLogger.md). Simple runtime debug gate and in-memory counters useful for lightweight instrumentation and tests.

## Utils

- [PowerBuffer: Encode/decode JS objects to transferables for worker messaging](guides/powerBuffer.md). Lightweight helpers for encoding/decoding JSON to/from binary (Uint8Array / ArrayBuffer / Node Buffer).
- [PowerDefer: Deferred promise primitive](guides/powerDefer.md). Small utility that separates a `Promise` from its `resolve`/`reject` functions.
- [PowerPermitGate: Permit queue helper](guides/powerPermitGate.md). Low-level concurrency gate that manages permits and FIFO waiters for building semaphore or backpressure primitives.
- [PowerScheduler: Work coalescing scheduler](guides/powerScheduler.md). Lightweight scheduler for batching deferred work into a single microtask or macrotask flush.
- [PowerSubscriberSet: Shared listener registry](guides/powerSubscriberSet.md). Internal subscriber helper with optional weak references and once-listener support.
- [PowerObserver: Lightweight reactive value](guides/powerObserver.md). Tiny observable primitive for synchronous subscriptions to a single value.
- [Now utilities: high-resolution timers and measure helpers](guides/now.md) — `nowMs()`, `measureSync()`, `measureAsync()` and timing best-practices.
- [Errors utilities: recommended error shapes and patterns](guides/errors.md) — guidance for attaching `duration`, `correlationId` and structured diagnostics to errors and responses.

## Quick start

Requirements: Node.js and npm.

Install dependencies:

```bash
npm install
```

Install the package from npm for direct use in your project:

```bash
npm install --save performance-helpers
# or
yarn add performance-helpers
```

Run tests:

```bash
npm run test
```

Run coverage (v8):

```bash
npm run test:coverage
```

## Quality bar

Helpers intended to be Tier 1 in this repository should meet a consistent bar:

- dedicated guide plus README coverage
- concise JSDoc for public constructor options and methods
- focused regression tests for edge cases and failure paths
- repo-wide coverage stays above the Vitest thresholds, and Tier 1 promotion work raises the helper's own file coverage to the same bar
- no known open correctness bugs in the public contract

Helpers that remain larger or more experimental can stay as advanced helpers, but Tier 1 helpers should be predictable, narrow in scope, and cheap to maintain.

Current classification notes:

- `PowerPool` is an advanced helper by design. It has a broader surface area than the narrow Tier 1 primitives, so coverage and maintenance expectations should be interpreted with that scope in mind.
- `PowerRateLimit` is treated as a metric outlier for function coverage. Its public behavior and rollback paths are heavily covered; the remaining low function number is not currently considered a release blocker on its own.
- Promotion work should prioritize public correctness, narrow APIs, and edge-case coverage before chasing residual coverage misses in broad orchestration helpers.

Build (Vite):

```bash
npm run build
```

Generate docs (Typedoc):

```bash
npm run docs
```

## Usage examples

Importing from the package entry (or directly from `src/helpers/*` during development):

```javascript
import {
  o2b,
  o2u8,
  u82o,
  b2o,
  PowerCache,
  PowerMemoizer,
  PowerTimedCache,
  PowerPool,
  PowerLogger,
  PowerThrottle,
  PowerSlidingWindow,
  PowerRateLimit,
  PowerQueue,
  PowerSemaphore,
  PowerDefer,
  PowerTTLMap,
  nowMs,
  measureSync,
  measureAsync,
  PowerCircuit,
  PowerRetry,
  PowerDeadline,
  PowerHistogram,
  PowerBackpressure,
  PowerBatch,
  PowerBulkhead,
  PowerLatch,
  PowerObserver,
  PowerEventBus,
} from 'performance-helpers';
```

## CDN usage

You can import the package directly from a CDN for quick demos. Example using unpkg (ES module support):

```html
<script type="module">
  import { PowerMemoizer } from 'https://unpkg.com/performance-helpers@latest?module';
  const fetchUser = async (id) => fetch(`/users/${id}`).then((r) => r.json());
  const memo = new PowerMemoizer(fetchUser);
  console.log(await memo(1));
</script>
```

Or using jsDelivr:

```html
<script type="module">
  import { PowerCache } from 'https://cdn.jsdelivr.net/npm/performance-helpers@latest/dist/index.js';
  const cache = new PowerCache();
  cache.set('a', 1);
  console.log(cache.get('a'));
</script>
```

UMD example (script tag):

```html
<script src="https://unpkg.com/performance-helpers@latest/dist/performance-helpers.umd.js"></script>
<script>
  // UMD builds attach a global. Use the global that your build exposes.
  const lib = window.PerformanceHelpers;
  const { PowerCache } = lib || {};
  const cache = new PowerCache();
  cache.set('a', 2);
  console.log(cache.get('a'));
</script>
```

## License

[MIT](LICENSE.md).
