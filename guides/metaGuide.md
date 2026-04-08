# Meta Guide - Choosing the Right Helper

This guide is for selection first, implementation second.

Use it to answer four questions quickly:

1. What is the main failure mode or bottleneck?
2. What is the smallest helper that solves it?
3. What other helper usually gets paired with it in production?
4. Which low-level primitives should you avoid unless you really need them?

If you already know the exact helper you want, go straight to its dedicated guide. If you are deciding between helpers, start here.

---

## How to use this guide

- Start from the problem, not the API surface.
- Prefer the simplest helper that matches the requirement.
- Add composition helpers only when the system boundary demands them.
- Reach for low-level primitives like `PowerPermitGate`, `PowerScheduler`, and `PowerSubscriberSet` only when higher-level helpers stop fitting.

---

## Quick chooser

| If your problem is... | Start here | Add these when needed | Do not start with |
| --- | --- | --- | --- |
| Cache expensive values by key | `PowerCache` | `PowerPool`, `PowerEventBus`, `PowerDeadline` | `PowerMemoizer` if you are not memoizing a function |
| Memoize a function call | `PowerMemoizer` | `PowerRetry`, `PowerDeadline` | `PowerCache` unless you need direct cache control |
| Expire keys after a fixed TTL | `PowerTimedCache` or `PowerTTLMap` | `PowerLogger` | `PowerCache` unless you also need LRU or weights |
| Offload CPU-heavy or blocking work | `PowerPool` | `PowerCache`, `PowerQueue`, `PowerEventBus`, `PowerBuffer` | `PowerChunker` if you need real worker control |
| Process a very large iterable in parallel | `PowerChunker` | `PowerLogger`, `PowerHistogram` | `PowerPool` unless you need custom worker lifecycle |
| Smooth bursts from producers | `PowerQueue` | `PowerBackpressure`, `PowerBatch`, `PowerPool` | `PowerSemaphore` alone |
| Limit concurrent async work globally | `PowerSemaphore` | `PowerBulkhead`, `PowerHistogram` | `PowerPermitGate` unless you need a building block |
| Isolate noisy workloads from critical ones | `PowerBulkhead` | `PowerCircuit`, `PowerHistogram`, `PowerLogger` | `PowerSemaphore` if isolation matters |
| Enforce burst and sustained API quotas | `PowerThrottle`, `PowerSlidingWindow` | `PowerRateLimit`, `PowerDeadline`, `PowerCircuit` | `PowerRetry` alone |
| Retry flaky work safely | `PowerRetry` | `PowerDeadline`, `PowerCircuit`, `PowerLogger` | infinite custom retry loops |
| Put a hard time budget on work | `PowerDeadline` | `PowerRetry`, `PowerCircuit` | ad hoc `Promise.race` everywhere |
| Broadcast events across components | `PowerEventBus` | `PowerObserver`, `PowerLogger` | `PowerSubscriberSet` unless you are building infrastructure |
| Expose a single changing value reactively | `PowerObserver` | `PowerEventBus` | a full event bus |
| Coordinate callbacks or multi-step async completion | `PowerDefer`, `PowerLatch` | `PowerLogger` | hand-rolled promise state |
| Batch near-synchronous calls into one flush | `PowerBatch` | `PowerScheduler`, `PowerQueue` | `PowerQueue` alone |

---

## Pick by domain

### Caching and TTL

Use `PowerCache` when you need keyed caching with size bounds, LRU semantics, TTL, or inflight deduplication via `getOrSetAsync`.

Use `PowerMemoizer` when the public shape you want is "call a function and reuse results", not "manually manage a cache".

Use `PowerTimedCache` when the requirement is simply "keep this for N milliseconds" and the convenience of auto-started cleanup is enough.

Use `PowerTTLMap` when the data is lightweight and ephemeral: job locks, one-time tokens, per-request suppression flags, or short-lived coordination markers.

Rule of thumb:

- `PowerTTLMap` for lightweight expiring keys.
- `PowerTimedCache` for simple TTL-backed caching.
- `PowerCache` for serious caching.
- `PowerMemoizer` for function-shaped caching.

### Parallel work and throughput

Use `PowerPool` when you need explicit worker orchestration: request/response, batching, autoscaling, or direct control over dispatch.

Use `PowerChunker` when the input is already an iterable and you mainly want a fast path to chunked processing without building pool plumbing yourself.

Use `PowerQueue` when the real issue is burst smoothing between producers and consumers.

Use `PowerBackpressure` when producers must slow down before queues or memory grow unbounded.

Use `PowerBatch` when many small operations can be coalesced into a single flush.

### Concurrency control and protection

Use `PowerSemaphore` for a simple global concurrency ceiling.

Use `PowerBulkhead` when one workload must not starve another. This is the right choice when you care about isolation, partitioning, or multi-tenant fairness.

Use `PowerPermitGate` only when you need the low-level acquire/release primitive that higher-level helpers are built from.

Important distinction:

- `PowerSemaphore` limits total concurrency.
- `PowerBulkhead` isolates lanes of concurrency.
- `PowerPermitGate` is the primitive, not the typical app-level answer.

### Rate limits and resilience

Use `PowerThrottle` for smoothing bursty traffic with token-bucket behavior.

Use `PowerSlidingWindow` for strict rolling-window quotas.

Use `PowerRateLimit` when you need both burst and sustained rules to pass at once.

Use `PowerRetry` when retry policy is the main concern.

Use `PowerDeadline` when timeout, abort, total budget, or retry budget matter.

Use `PowerCircuit` when downstream failure should trigger fast rejection instead of continued pressure.

### Events, observability, and coordination

Use `PowerEventBus` for decoupled fan-out between helpers or subsystems.

Use `PowerObserver` for one changing value with subscribers.

Use `PowerHistogram` for latency distribution and percentile-style telemetry.

Use `PowerLogger` for structured runtime diagnostics and test-friendly output sinks.

Use `PowerDefer` when external code resolves a promise later.

Use `PowerLatch` when you must wait until N completions have happened.

---

## Recommended combinations

This is the section most users actually need. Most production use cases are not about one helper, but about one primary helper plus two or three supporting ones.

### 1. Worker-backed compute cache

Use when expensive CPU work is repeated for the same key and concurrent callers should share the same in-flight work.

Recommended helpers:

- `PowerCache`
- `PowerPool`
- `PowerEventBus`
- `PowerDeadline` if worker replies must be bounded

Example:

```javascript
const pool = new PowerPool(tileWorkerFactory, { size: 4, maxSize: 8, autoScale: true });
const cache = new PowerCache({ maxEntries: 3000, defaultTTL: 60_000 });
const bus = new PowerEventBus();

async function getDecodedTile(tileId, rawTileBytes) {
  const decoded = await cache.getOrSetAsync(
    tileId,
    () => pool.postMessage(
      { op: 'decode-tile', tileId, rawTileBytes },
      undefined,
      { awaitResponse: true, timeout: 5000 }
    ),
    { ttl: 60_000 }
  );

  bus.emit('tile:decoded', { tileId, decoded });
  return decoded;
}
```

Why this combination works:

- `PowerCache` avoids repeated computation.
- `getOrSetAsync` deduplicates concurrent misses.
- `PowerPool` keeps CPU-heavy work off the main execution path.
- `PowerEventBus` lets renderers, metrics, and cache warmers react without tight coupling.

### 2. Bursty ingestion pipeline

Use when producers are faster than consumers and the system needs a place to absorb bursts safely.

Recommended helpers:

- `PowerQueue`
- `PowerBackpressure`
- `PowerBatch`
- `PowerPool` when processing is expensive

Typical flow:

1. Producers enqueue incoming work into `PowerQueue`.
2. Consumers drain the queue in chunks.
3. `PowerBackpressure` gates or delays producers when the system is saturated.
4. `PowerBatch` coalesces small downstream writes into efficient bulk flushes.

Example:

```javascript
const queue = new PowerQueue(1024);
const backpressure = new PowerBackpressure({
  capacity: 128,
  queueCapacity: 256,
  lowWaterMark: 32,
  refillAmount: 16,
  refillInterval: 100,
});

const writer = new PowerBatch(async (events) => {
  await sendBulk(events);
}, { maxSize: 500 });

async function ingestEvent(event) {
  const release = await backpressure.acquire();
  queue.push({ event, release });
}

async function flushQueue(maxItems = 200) {
  const items = [];

  while (queue.length > 0 && items.length < maxItems) {
    const next = queue.shift();
    if (next) items.push(next);
  }

  if (!items.length) return;

  try {
    await Promise.all(items.map(({ event }) => writer.add(event)));
    await writer.flush();
  } finally {
    items.forEach(({ release }) => release());
  }
}

setInterval(() => {
  flushQueue().catch((err) => {
    console.error('flushQueue failed', err);
  });
}, 50);
```

Use this for socket ingestion, telemetry pipelines, event collectors, and ETL front doors.

### 3. Rate-limited external API client

Use when the hard part is staying within quotas while also surviving latency spikes and downstream instability.

Recommended helpers:

- `PowerThrottle` for burst smoothing
- `PowerSlidingWindow` for strict quotas
- `PowerRateLimit` to combine them
- `PowerDeadline` for per-call and total time budgets
- `PowerCircuit` to fail fast when the dependency is unhealthy

Example:

```javascript
const burst = new PowerThrottle({ capacity: 30, refillRate: 10 });
const sustained = new PowerSlidingWindow({ capacity: 1000, windowMs: 60_000 });
const limiter = new PowerRateLimit([burst, sustained], { atomic: true });
const circuit = new PowerCircuit({ threshold: 5, timeout: 30_000 });

async function callBackend(request) {
  if (!limiter.tryConsume(1, { atomic: true })) {
    throw new Error('Rate limit exceeded');
  }

  return circuit.call(() =>
    PowerDeadline.run(
      () => fetch(request),
      {
        maxAttempts: 3,
        attemptTimeout: 3000,
        retryDelay: 200,
        totalTimeout: 10_000,
      }
    )
  );
}
```

Why this combination works:

- The rate limiters keep you inside contract.
- `PowerDeadline` prevents a single slow call from consuming the whole request budget.
- `PowerCircuit` prevents continued pressure on a failing dependency.

### 4. Multi-tenant workload isolation

Use when one customer, partition, or job class must not consume all available concurrency.

Recommended helpers:

- `PowerBulkhead`
- `PowerSemaphore` for a separate global cap when needed
- `PowerHistogram`
- `PowerLogger`

Example:

```javascript
const bulkhead = new PowerBulkhead({
  partitions: 4,
  maxConcurrency: 2,
  queueCapacity: 100,
});

function handleTask(tenantId, task) {
  return bulkhead.run(
    () => processTask(task),
    { partitionKey: tenantId }
  );
}
```

Why this combination works:

- `PowerBulkhead` isolates partitions.
- `partitionKey` keeps related work together.
- Metrics and logging tell you which partition is hot before it becomes an outage.

### 5. Large iterable processing with minimal plumbing

Use when the input is a large array or stream and you want chunked parallel processing without manually wiring a pool.

Recommended helpers:

- `PowerChunker`
- `PowerLogger`
- `PowerHistogram`

Example:

```javascript
const rows = await loadRows();
const pool = new PowerChunker(rows, transformRow, {
  poolOptions: { size: 4 },
  chunkSize: 500,
});

pool.onmessage = (e) => {
  const { results } = e.data;
  writeResults(results);
};

await pool.drain();
pool.terminate();
```

When not to use it:

- You need a real worker implementation with custom messaging semantics.
- You need fine-grained worker routing.
- You need custom pool lifecycle management.

In those cases, go straight to `PowerPool`.

---

## Common mistakes

- Using `PowerCache` for a simple expiring flag where `PowerTTLMap` is enough.
- Using `PowerPermitGate` as if it were the main app-facing concurrency abstraction.
- Using `PowerRetry` without a deadline, causing work to linger too long.
- Using `PowerSemaphore` when the real problem is workload isolation, not just total concurrency.
- Using `PowerChunker` for scenarios that really need explicit worker control.
- Building custom batching around arrays and timers when `PowerBatch` or `PowerScheduler` already matches the problem.

---

## If you are unsure between two helpers

Choose the left-hand option when in doubt:

- `PowerTTLMap` over `PowerCache` for ephemeral TTL keys.
- `PowerTimedCache` over `PowerCache` for simple TTL caching.
- `PowerMemoizer` over `PowerCache` for function result reuse.
- `PowerSemaphore` over `PowerPermitGate` for normal concurrency limits.
- `PowerBulkhead` over `PowerSemaphore` when noisy-neighbor protection matters.
- `PowerPool` over `PowerChunker` when worker behavior itself is part of the design.
- `PowerDeadline` over `PowerRetry` when time budget matters at all.
- `PowerEventBus` over `PowerSubscriberSet` for application-level pub/sub.
- `PowerObserver` over `PowerEventBus` when there is only one value to watch.

---

## Complete helper index

This section is intentionally concise. Use it as a directory, not as the primary selection aid.

### Caching

- `PowerCache`: LRU cache with TTL, size controls, and inflight dedupe.
- `PowerMemoizer`: Function-shaped memoization on top of `PowerCache`.
- `PowerTimedCache`: Convenience wrapper for simple TTL caching.
- `PowerTTLMap`: Lightweight expiring key-value store.

### Parallelism and flow control

- `PowerPool`: Worker/task pool with batching, response tracking, and autoscaling.
- `PowerChunker`: Chunked iterable processing built on pool semantics.
- `PowerQueue`: Fast FIFO queue for burst absorption.
- `PowerBackpressure`: Producer-facing admission control.
- `PowerBatch`: Coalesce many calls into one flush.
- `PowerSemaphore`: Global async concurrency gate.
- `PowerBulkhead`: Partitioned concurrency isolation.
- `PowerPermitGate`: Low-level permit primitive used by higher-level gates.
- `PowerScheduler`: Small flush scheduler for deferred work.

### Rate limiting and resilience

- `PowerThrottle`: Token-bucket style rate limiter.
- `PowerSlidingWindow`: Strict rolling-window quota limiter.
- `PowerRateLimit`: Compose multiple limiter strategies.
- `PowerRetry`: Retry with backoff and jitter.
- `PowerDeadline`: Attempt timeout, total deadline, abort, and retry budget wrapper.
- `PowerCircuit`: Circuit breaker for unhealthy downstream dependencies.

### Events, state, and diagnostics

- `PowerEventBus`: Decoupled pub/sub for in-process events.
- `PowerSubscriberSet`: Low-level listener collection helper.
- `PowerObserver`: Reactive container for one changing value.
- `PowerLogger`: Structured runtime logging.
- `PowerHistogram`: In-process latency and percentile-style telemetry.

### Coordination and async building blocks

- `PowerDefer`: External resolve/reject promise primitive.
- `PowerLatch`: Wait until a count reaches zero.

### Buffer and timing utilities

- `o2u8`, `o2b`: Encode values to transferable binary.
- `u82o`, `b2o`: Decode transferable binary back to values.
- `nowMs`: High-resolution current time helper.
- `measureSync`, `measureAsync`: Small timing helpers for instrumentation.

---

## Final advice

Most real systems here start with one dominant helper and then gain one supporting helper from each of these categories:

- data reuse: `PowerCache` or `PowerTTLMap`
- execution control: `PowerPool`, `PowerSemaphore`, or `PowerBulkhead`
- safety: `PowerDeadline`, `PowerRetry`, or `PowerCircuit`
- observability: `PowerLogger`, `PowerHistogram`, or `PowerEventBus`

If you find yourself combining more than four or five helpers for one narrow code path, step back and re-check whether you are solving multiple problems at once.
