# Parallelizing

- [PowerPool: Worker pool](../guides/powerPool.md). A small, dependency-free worker pool that wraps underlying Worker instances.
- [PowerChunker: Chunk + pool helper](../guides/powerChunking.md). Convenience helper to chunk iterables and process items via a `PowerPool`.
- [PowerCircuit: Circuit breaker](../guides/powerCircuit.md). Small circuit breaker to protect external services from cascading failures.
- [PowerRetry: Retry with backoff](../guides/powerRetry.md). Helper for retrying flaky async operations with configurable backoff and jitter.
- [PowerRetry: Retry with backoff](../guides/powerRetry.md). Helper for retrying flaky async operations with configurable backoff and jitter.
- [PowerBatch: Microtask coalescing dispatcher](../guides/powerBatch.md). Coalesce synchronous calls into compact batches for bulk operations.
- [PowerLatch: Counting barrier](../guides/powerLatch.md). Simple barrier that resolves when a count reaches zero. Useful for coordinating out-of-band task completions.
- [PowerThrottle: A token-bucket limiter](../guides/powerThrottle.md). A tiny rate limiter useful for pacing external work or cooperating with `PowerPool`.
- [PowerSlidingWindow: Sliding-window limiter](../guides/powerSlidingWindow.md). A simple rolling-window limiter for quota-style rate limiting.
- [PowerQueue: O(1) ring-buffer queue](../guides/powerQueue.md). A resizable, high-performance queue intended for use in `PowerPool` and other high-throughput scenarios.
- [PowerEventBus: Typed micro event bus](../guides/powerEventBus.md). Lightweight pub/sub for intra-process coordination between helpers.
