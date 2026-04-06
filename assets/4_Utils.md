# Utils

- [PowerBuffer: Encode/decode JS objects to transferables for worker messaging](../guides/powerBuffer.md). Lightweight helpers for encoding/decoding JSON to/from binary (Uint8Array / ArrayBuffer / Node Buffer).
- [PowerDefer: Deferred promise primitive](../guides/powerDefer.md). Small utility that separates a `Promise` from its `resolve`/`reject` functions.
- [PowerPermitGate: Permit queue helper](../guides/powerPermitGate.md). Low-level concurrency gate that manages permits and FIFO waiters for building semaphore or backpressure primitives.
- [PowerScheduler: Work coalescing scheduler](../guides/powerScheduler.md). Lightweight scheduler for batching deferred work into a single microtask or macrotask flush.
- [PowerSubscriberSet: Shared listener registry](../guides/powerSubscriberSet.md). Internal subscriber helper with optional weak references and once-listener support.
- [PowerObserver: Lightweight reactive value](../guides/powerObserver.md). Tiny observable primitive for synchronous subscriptions to a single value.
- [Now utilities: high-resolution timers and measure helpers](../guides/now.md) — `nowMs()`, `measureSync()`, `measureAsync()` and timing best-practices.
- [Errors utilities: recommended error shapes and patterns](../guides/errors.md) — guidance for attaching `duration`, `correlationId` and structured diagnostics to errors and responses
