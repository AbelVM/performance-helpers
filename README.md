# performance-helpers

[![npm version](https://img.shields.io/npm/v/performance-helpers.svg)](https://www.npmjs.com/package/performance-helpers) [![npm downloads](https://img.shields.io/npm/dm/performance-helpers.svg)](https://www.npmjs.com/package/performance-helpers) [![GitHub stars](https://img.shields.io/github/stars/AbelVM/performance-helpers.svg)](https://github.com/AbelVM/performance-helpers/stargazers) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

![logo](assets/logo.png)

Highly tuned lightweight toolbox for high-performance Node/browser code: zero-copy buffer helpers for worker messaging, an environment-agnostic worker abstraction (`WorkerAgnostic`), an LRU TTL cache with a memoizer, a fully-featured worker pool wrapper, a tiny runtime debug logger, and much more:

> ## ⚠️ Upgrading to 2.0 — the worker wire format changed
>
> `PowerPool` now posts a versioned [`PowerMessageCodec`](guides/powerMessageCodec.md) frame
> (`[version][codec][length][payload]`) instead of a bare `Uint8Array` of JSON. In 1.x every
> worker had to hand-decode the bytes, the format had no version so it could never evolve, and a
> genuinely binary message was silently corrupted by `JSON.parse`.
>
> **One line changes in each worker:**
>
> ```diff
> -import { u82o } from 'performance-helpers';
> +import { decodeMessage, encodeMessage } from 'performance-helpers';
> -self.onmessage = (e) => handle(u82o(e.data));
> -self.postMessage({ result });
> +self.onmessage = (e) => handle(decodeMessage(e.data).value);
> +self.postMessage(encodeMessage({ result }));
> ```
>
> Your worker must also **reply in the shape it received** — a worker talking to a pool still on
> `messageCodec: 'legacy'` must reply with `o2u8`, not a frame. Full details, a
> try-the-frame-and-fall-back recipe, and the `messageCodec: 'legacy'` escape hatch are in
> [Migrating to the framed protocol](guides/powerPool.md#migrating-to-the-framed-protocol).
>
> Nothing else in the public API breaks.

## Caching

- [PowerCache: Caching (LRU + TTL + weight) and memoizing](guides/powerCache.md). An in-memory, memory-efficient LRU cache with TTL, weighted eviction and an optional reusable node pool.
- [PowerMemoizer: Function-shaped memoization](guides/powerCache.md). Call a function and reuse results without manual cache management.
- [PowerTimedCache: Simple TTL cache](guides/powerCache.md). Auto-started cleanup for "keep this for N milliseconds" use cases.
- [PowerTTLMap: Map with per-key TTL](guides/powerTTLMap.md). Lightweight `Map`-like store where keys expire lazily on access.

## Parallelizing

- [PowerPool: Worker pool](guides/powerPool.md). A small, dependency-free worker pool that wraps underlying Worker instances. Autoscaling scales the worker count from a latency-threshold heuristic; `autoScale.policy` (`'aimd' | 'vegas' | 'gradient2'`) additionally computes an adaptive concurrency limit, but that limit is **reported and not enforced** — nothing on the dispatch path reads it, and enforcing it measured 3.7 % behind the best hand-picked constant cap.
- [WorkerAgnostic: One worker abstraction for Node, browser and web worker](guides/WorkerAgnostic.md). Resolves the environment and returns a worker-like object either way, from a factory function or a path/code string. Handles the pure-ESM `node:worker_threads` caveat. Used directly by `PowerPool` and `PowerChunker`.
- [PowerChunker: Chunk + pool helper](guides/powerChunking.md). Convenience helper to chunk iterables and process items via a `PowerPool`.
- [PowerBulkhead: Partitioned executor](guides/powerBulkhead.md). Isolate noisy workloads into separate lanes so one hot partition cannot starve the rest.
- [PowerCircuit: Circuit breaker](guides/powerCircuit.md). Small circuit breaker to protect external services from cascading failures.
- [PowerCron: Drift-free cron-like scheduler](guides/powerCron.md). `setTimeout` chaining from an absolute target, with catch-up policy, jitter and a skip/run-once choice for missed fires.
- [PowerRetry: Retry with backoff, budget, and hedging](guides/powerRetry.md). Retry flaky async work with a configurable backoff curve — including AWS **decorrelated jitter**, which decorrelates a fleet instead of re-synchronising it — plus an optional **retry budget** so retries cannot amplify an outage, and optional **hedged attempts** that trade average load for a cut p99.
- [PowerDeadline: Timeout, retry budget, and cancellation](guides/powerDeadline.md). Wrap async work with per-attempt timeouts, overall deadlines, and retry policy.
- [PowerHistogram: Lock-free percentile estimator](guides/powerHistogram.md). Compact in-process histogram for latency telemetry and estimated percentiles.
- [PowerBackpressure: Producer-facing backpressure controller](guides/powerBackpressure.md). Gate producers with bounded waiting and an adaptive refill that self-tunes to unknown downstream capacity (`{ adaptive: true }` enables AIMD; off by default).
- [PowerBatch: Microtask coalescing dispatcher](guides/powerBatch.md). Coalesce synchronous calls into compact batches for bulk operations.
- [PowerLatch: Counting barrier](guides/powerLatch.md). Simple barrier that resolves when a count reaches zero. Useful for coordinating out-of-band task completions.
- [PowerThrottle: A token-bucket limiter](guides/powerThrottle.md). A tiny rate limiter useful for pacing external work or cooperating with `PowerPool`. New: supports `reserve()`/`release()` for reservation-style workflows.
- [PowerRateLimit: Compose multiple limiters](guides/powerRateLimit.md). Combine `PowerThrottle`, `PowerSlidingWindow`, `PowerGCRA` and others; supports an `atomic` option to attempt atomic consumes across composed limiters, and a **`keyFn`** for per-key limiting (Bottleneck `Group`-shaped) that hashes keys into a bounded slot array — bounded memory with **no eviction path**, so no key's budget can be silently reset.
- [PowerSlidingWindow: Sliding-window limiter](guides/powerSlidingWindow.md). A simple rolling-window limiter for quota-style rate limiting.
- [PowerGCRA: Cell-based rate limiter](guides/powerGCRA.md). GCRA — the ATM Forum algorithm behind `redis-cell` and Go's `x/time/rate`. O(1) with a single number of state, and an **exact** `retryAfter()` rather than an estimate. Composes in `PowerRateLimit` alongside the other limiters.
- [PowerQueue: O(1) ring-buffer queue](guides/powerQueue.md). A resizable, high-performance queue intended for use in `PowerPool` and other high-throughput scenarios.
- [PowerSemaphore: Async concurrency gate](guides/powerSemaphore.md). Lightweight semaphore for limiting concurrent I/O and fan-out workloads.
- [PowerCrossLock: Cross-worker mutex](guides/powerCrossLock.md). A fair mutex shared by every worker in the process, over the platform's Web Locks implementation. Use it when the thing you must exclude is running in _another_ thread — `PowerSemaphore` cannot do that, because every instance is local to its thread.
- [PowerServo: Closed-loop transfer function](guides/powerServo.md). Hold a measured value at a setpoint — a queue depth, a byte ceiling, a pool size — with an optional feedforward path for a disturbance you can see before it shows up in the measurement. Supplies the arithmetic (PI, derivative on the measurement, an integral that cannot wind up) and takes both terms of the error from you, so the decision of _what to measure_ stays with the caller. The loop cannot diverge: the output is clamped every step and the integral is clamped within the same window.
- [PowerEventBus: Typed micro event bus](guides/powerEventBus.md). Lightweight pub/sub for intra-process coordination between helpers.

## Realtime

Transport framing and real-time fan-out. These compose: the hub delivers over whatever transport you supply, and the codec is what makes a batch of messages legible to the receiver. Full index: [assets/5_Realtime.md](assets/5_Realtime.md).

- [PowerMessageCodec: Versioned binary message framing](guides/powerMessageCodec.md). Explicit `[version][codec][length][payload]` envelope so a transport never has to _guess_ what it received, replacing `PowerPool`'s ArrayBuffer sniffing. Framed `json`/`raw` codecs for byte streams, plus `encodeNative` for the platform structured clone on a `MessagePort`/`Worker`. This is the protocol `PowerPool` speaks by default since 2.0.

  **Protocol negotiation.** The frame is portable and it is lossy: a `Map` arrives as `{}`, a `Date` as an ISO _string_, `Infinity` as `null`, and a `BigInt` makes the whole message undecodable. So a worker can advertise the native structured-clone carrier and get that instead, while every worker that does not advertise keeps getting the frame — one pool, a mixed fleet, and a rollout that can start before any worker is ready:

  ```javascript
  // pool
  const pool = new PowerPool(WorkerScript, { messageCodec: 'negotiated' });

  // worker — reads all three carriers, and says what it can decode
  import { decodeInbound, announceCapabilities } from 'performance-helpers';
  parentPort.postMessage(announceCapabilities());
  parentPort.on('message', (data) => handle(decodeInbound(data).value));
  ```

  It is **not** a speedup, and the release note that claimed 2–5× was withdrawn: a structured clone is a tie for small objects, up to ~1.7× _slower_ for deeply nested structure, and faster only for string-heavy payloads. Fidelity is the reason. `node bench/claims.js carrier` reproduces both tables.

- [PowerRealtimeHub: Topic fan-out with slow-consumer control](guides/powerRealtimeHub.md). Per-subscriber bounded queues and a declared policy (`drop-oldest` / `drop-newest` / `disconnect`) so one slow consumer cannot stall or OOM the process. Transport-agnostic via a `send` adapter; batches over `PowerMessageCodec`.

- [PowerMessagePort: `MessagePort` transport adapter for `PowerRealtimeHub`](guides/powerMessagePort.md). Uses the platform's native structured-clone codec so `Map`, `Set`, `Date`, `BigInt` and cycles survive the boundary without JSON round-tripping. Supplies inbound decoding through `decodeInbound` and safe listener teardown on `dispose()`.
- [PowerWebSocketClient: Reconnecting client with back-pressure](guides/powerWebSocketClient.md). `WebSocket` has no back-pressure, so this adds it two ways: `bufferedAmount` watermarks (universal, with a backing-off poll and `onPause`/`onResume`) and `WebSocketStream` where available (awaits `writer.ready`). Plus heartbeats with RTT, decorrelated-jitter reconnects, and a connect timeout. Pairs with `PowerRealtimeHub` via `sendFrame`.

- [PowerSocketAdapter: One interface over three socket models](guides/powerSocketAdapter.md). Normalise a Node `ws` socket, a browser `WebSocket`, or a `WebSocketStream` behind one API. They are genuinely incompatible — a `ws` `message` handler receives `(data, isBinary)`, an `EventTarget` one receives an event object, and a `WebSocketStream` has neither `on`, `readyState`, nor `bufferedAmount` — and the mismatches fail silently. Adds socket-level liveness, per-message rate limiting, and a graceful `drain()` for shutdown. The server-side counterpart to the client above; there is no WebSocket server here, and there should not be.
- [PowerRTCChannel: One `RTCDataChannel` behind the same shape as `PowerSocketAdapter`](guides/powerRTCChannel.md) — string `readyState` normalised, SCTP's message-size ceiling enforced, and back-pressure that arrives as a push signal instead of a poll timer. A data channel's `readyState` is `'open'`, not `1`, so the `=== READY_STATE.OPEN` guard every other transport satisfies is silently false on a healthy channel. `send()` **throws** above the SCTP ceiling where a `WebSocket` would buffer, which is the one case a hub can actually see — a `false` is invisible to `PowerRealtimeHub`, so watch `sendRefusals`. `binaryType` is already `arraybuffer`, so the framed codec works unchanged; `expectUnreliable` asserts the `ordered:false, maxRetransmits:0` this class cannot set for you.
- [PowerDatagramChannel: Bounded, drop-counting datagram wrapper](guides/powerDatagramChannel.md). Enforces a hard `maxDatagramSizeBytes` ceiling before the platform sees the datagram, so an oversize frame is refused with a `TypeError` and counted in `stats().oversizeDatagrams` rather than silently discarded. When the internal queue is full, the oldest queued datagram is dropped first and the new one is queued in its place, so the loss is observable in `droppedCount`. This is **not** a hub `send` adapter: `retain` and datagrams contradict each other. Use it directly for bounded, counted datagram delivery, or wrap it in your own adapter that knows how to frame and retain.
- [PowerWebTransportAdapter: `WebTransportBidirectionalStream` behind the same shape as `PowerSocketAdapter`](guides/powerWebTransportAdapter.md). Wraps a `WebTransport` session's bidirectional stream and decodes inbound frames with `createFrameDecoder` so split frames do not surface as `RangeError`s at the reader. `maxFrameBytes` is `Infinity`; enforcement is left to `PowerSocketAdapter`'s `maxPayloadSizeBytes`.

- [WebTransport feature detection](guides/webTransportSupport.md). `detectWebTransportSupport()` — a pure probe for what a build actually supports, with no connection opened. Three of the surfaces it reports (`reliability`, `getStats()`, `WebTransportSendGroup`) are **not** Baseline, so `reliableOnly` is the one flag to branch on: it is `true` only when every surface present is Baseline.

  ```javascript
  const support = detectWebTransportSupport();
  if (support.available && support.reliableOnly) {
    // safe to depend on
  }
  ```

  Presence and usability are tracked separately, because a Limited-availability `getStats()` can exist and still throw — and a build carrying one is not a build to gate on.

## Logging

- [PowerLogger: Gated logging](guides/powerLogger.md). Simple runtime debug gate and in-memory counters useful for lightweight instrumentation and tests.

## Observability

- [PowerEventLoopMonitor: Event-loop delay and utilization](guides/powerEventLoopMonitor.md). Timer-drift histogram plus Node's `eventLoopUtilization()`, so a latency regression can be attributed to the host instead of guessed at. Zero dependencies, both runtimes; `utilization()` returns `null` where the runtime cannot measure it. `stats()` also reports the milliseconds blocked alongside the count of blocked ticks, the readings it refused, and the share of wall-clock time it actually sampled.

## Utils

- [PowerBuffer: Encode/decode JS objects to transferables for worker messaging](guides/powerBuffer.md). Lightweight helpers for encoding/decoding JSON to/from binary (Uint8Array / ArrayBuffer / Node Buffer).
- [PowerDefer: Deferred promise primitive](guides/powerDefer.md). Small utility that separates a `Promise` from its `resolve`/`reject` functions.
- [PowerPermitGate: Permit queue helper](guides/powerPermitGate.md). Low-level concurrency gate that manages permits and FIFO waiters for building semaphore or backpressure primitives.
- [PowerScheduler: Work coalescing scheduler](guides/powerScheduler.md). Lightweight scheduler for batching deferred work into a single microtask or macrotask flush.
- [PowerSubscriberSet: Shared listener registry](guides/powerSubscriberSet.md). Internal subscriber helper with optional weak references and once-listener support.
- [PowerObserver: Lightweight reactive value](guides/powerObserver.md). Tiny observable primitive for synchronous subscriptions to a single value.
- [Now utilities: high-resolution timers and measure helpers](guides/now.md) — `nowMs()`, `measureSync()`, `measureAsync()` and timing best-practices.
- [Errors utilities: recommended error shapes and patterns](guides/errors.md) — guidance for attaching `duration`, `correlationId` and structured diagnostics to errors and responses.

## When to use what

Check the [Quick Guide](guides/metaGuide.md), or the
[Troubleshooting guide](guides/troubleshooting.md) if something is already
misbehaving — it starts with the pure-ESM `preloadNode()` failure, which is the
most likely thing to go wrong on a first run.

To propagate a W3C trace across a worker pool, see
[Trace context](guides/traceContext.md) — it needs nothing from this library,
because `PowerPool` already round-trips a field you choose.

To plot what the helpers report, use [Metrics](guides/metrics.md) rather than
each helper's own `stats()`: those shapes are different kinds of thing — a
`PowerCache` reports counters, a `PowerGCRA` mostly configuration, a
`PowerPool` a nested array per worker — and the snapshot gives them stable,
versioned names.

## Quick start

Requirements: Node.js and npm.

Install the package:

```bash
npm install --save performance-helpers
# or
yarn add performance-helpers
```

Run tests:

```bash
npm test
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

Runnable scripts live in [`examples/`](examples/README.md), one per helper family. They are executed by the test suite, so they cannot drift from the API:

```sh
npm run example              # list them
npm run example cache        # run one
npm run example -- --all     # run every one
```

The guides below cover the reference material; the examples exist so you can see
a working call before reading the prose.

Import everything from the package entry:

```javascript
import {
  o2b,
  o2u8,
  u82o,
  b2o,
  encodeMessage,
  decodeMessage,
  decodeInbound,
  announceCapabilities,
  PowerCache,
  PowerMemoizer,
  PowerTimedCache,
  PowerPool,
  PowerLogger,
  PowerThrottle,
  PowerSlidingWindow,
  PowerGCRA,
  PowerRateLimit,
  PowerQueue,
  PowerSemaphore,
  PowerServo,
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

Import a single helper or utility when you want the smallest possible bundle:

```javascript
import { PowerCache } from 'performance-helpers/powerCache';
import { nowMs } from 'performance-helpers/now';
import { normalizeError } from 'performance-helpers/errors';
```

The package is marked as side-effect free, so bundlers can treeshake unused exports from the root entry as well.

## CDN usage

You can import the package directly from a CDN for quick demos. Example using unpkg (ES module support):

```html
<script type="module">
  import { PowerMemoizer } from 'https://unpkg.com/performance-helpers@latest/dist/performance-helpers.es.js';
  const fetchUser = async (id) => fetch(`/users/${id}`).then((r) => r.json());
  const pm = new PowerMemoizer(fetchUser);
  console.log(await pm.run(1));
</script>
```

Or using jsDelivr:

```html
<script type="module">
  import { PowerCache } from 'https://cdn.jsdelivr.net/npm/performance-helpers@latest/dist/performance-helpers.es.js';
  const cache = new PowerCache();
  cache.set('a', 1);
  console.log(cache.get('a'));
</script>
```

UMD example (script tag):

```html
<script src="https://unpkg.com/performance-helpers@latest/dist/performance-helpers.js"></script>
<script>
  // UMD builds attach a global. Use the global that your build exposes.
  const lib = window.PerformanceHelpers;
  const { PowerCache } = lib || {};
  const cache = new PowerCache();
  cache.set('a', 2);
  console.log(cache.get('a'));
</script>
```

## Worker support: Node and the browser

`WorkerAgnostic` (re-exported from `performance-helpers/WorkerAgnostic`) gives you one
transparent API for spawning and talking to a worker whether you are on Node.js
(`worker_threads`) or in a browser / Web Worker context (Web Worker). `PowerPool`
uses it under the hood, so the pool is environment-agnostic too.

```javascript
import WorkerAgnostic, { detectEnv, preloadNode } from 'performance-helpers/WorkerAgnostic';

console.log(detectEnv()); // 'node' | 'browser' | 'webworker' | 'unknown'

const worker = new WorkerAgnostic('./myWorker.js', { type: 'module' });
worker.addEventListener('message', (ev) => console.log(ev.data));
worker.postMessage({ hello: 'world' });
await worker.terminate();
```

**What is transparent:**

- Worker creation from a path string, a factory function, or a constructor — the
  correct native worker is chosen for the runtime.
- The event model (`addEventListener`/`removeEventListener` and Node-style
  `on`/`off`) and `postMessage(message, transfer)` transfer lists.
- Message payloads are normalized to `{ data }` (Node delivers the value
  directly; Web Workers deliver a `MessageEvent` whose payload is on `.data`).
- `terminate()` always returns a Promise.

**Caveats you should know:**

1. **Pure-ESM Node + string-source workers** need one `await preloadNode()` call
   before constructing the worker (or set `globalThis.Worker`, or pass a factory
   function). This is the only non-transparent seam. CJS/vitest, factory-function
   sources, and all browser paths do **not** need it.

   ```javascript
   import WorkerAgnostic, { preloadNode } from 'performance-helpers/WorkerAgnostic';
   await preloadNode();
   const worker = new WorkerAgnostic('./myWorker.js', { type: 'module' });
   ```

2. **Transparency covers creation and messaging, not your worker's internals.**
   `WorkerAgnostic` spawns the correct native worker and unifies the API, but the
   worker _source file_ you write must still be valid for its target runtime
   (Node `worker_threads` uses `parentPort`; a browser worker uses
   `self.onmessage`). It does not transpile worker code between environments.

3. **Browser usage requires a bundler or an ESM CDN.** The package ships as raw
   ESM source (no prebuilt UMD/browser bundle is required for the worker layer).
   In a bundler or a `<script type="module">` from a CDN, `WorkerAgnostic`
   resolves the worker URL against `import.meta.url` / `document.currentScript` /
   `location.href` and falls back to the plain string.

## API docs

See the [full API documentation](docs/README.md)

## License

[MIT](LICENSE.md).
