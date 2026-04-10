# Parallelizing

- [PowerPool: Worker pool](../guides/powerPool.md). A small, dependency-free worker pool that wraps underlying Worker instances.
- [PowerChunker: Chunk + pool helper](../guides/powerChunking.md). Convenience helper to chunk iterables and process items via a `PowerPool`.
- [PowerBulkhead: Partitioned executor](../guides/powerBulkhead.md). Isolate noisy workloads into separate lanes so one hot partition cannot starve the rest.
- [PowerCircuit: Circuit breaker](../guides/powerCircuit.md). Small circuit breaker to protect external services from cascading failures.
- [PowerRetry: Retry with backoff](../guides/powerRetry.md). Helper for retrying flaky async operations with configurable backoff and jitter.
- [PowerDeadline: Timeout, retry budget, and cancellation](../guides/powerDeadline.md). Wrap async work with per-attempt timeouts, overall deadlines, and retry policy.
- [PowerHistogram: Lock-free percentile estimator](../guides/powerHistogram.md). Compact in-process histogram for latency telemetry and estimated percentiles.
- [PowerBackpressure: Producer-facing backpressure controller](../guides/powerBackpressure.md). Gate producers with adaptive refill and bounded waiting.
- [PowerBatch: Microtask coalescing dispatcher](../guides/powerBatch.md). Coalesce synchronous calls into compact batches for bulk operations.
- [PowerLatch: Counting barrier](../guides/powerLatch.md). Simple barrier that resolves when a count reaches zero. Useful for coordinating out-of-band task completions.
- [PowerThrottle: A token-bucket limiter](../guides/powerThrottle.md). A tiny rate limiter useful for pacing external work or cooperating with `PowerPool`. New: supports `reserve()`/`release()` for reservation-style workflows.
- [PowerRateLimit: Compose multiple limiters](../guides/powerRateLimit.md). Combine `PowerThrottle`, `PowerSlidingWindow` and others; supports an `atomic` option to attempt atomic consumes across composed limiters.
- [PowerSlidingWindow: Sliding-window limiter](../guides/powerSlidingWindow.md). A simple rolling-window limiter for quota-style rate limiting.
- [PowerQueue: O(1) ring-buffer queue](../guides/powerQueue.md). A resizable, high-performance queue intended for use in `PowerPool` and other high-throughput scenarios.
- [PowerSemaphore: Async concurrency gate](../guides/powerSemaphore.md). Lightweight semaphore for limiting concurrent I/O and fan-out workloads.
- [PowerEventBus: Typed micro event bus](../guides/powerEventBus.md). Lightweight pub/sub for intra-process coordination between helpers.
