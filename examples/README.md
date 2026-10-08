# Examples

Runnable scripts, one per helper family. Every one of them is executed by
`test/examples.test.js` on every `npm test`, so an example that stops working
is a failing test rather than documentation that has quietly rotted.

```sh
npm run example            # lists them
npm run example cache      # runs examples/cache.mjs
```

Each script imports from the package root (`performance-helpers`) and exits
non-zero on an unexpected result, so they double as smoke tests. The ones that
demonstrate a rate limiter or a backoff loop print a small table rather than a
single line, because "it works" is not the interesting part of those — the
numbers are.

| Family        | Script              | Shows                                                                  |
| ------------- | ------------------- | ---------------------------------------------------------------------- |
| Caching       | `cache.mjs`         | `PowerCache` with an LRU + TTL, and what eviction actually costs       |
| Rate limiting | `ratelimit.mjs`     | `PowerThrottle` vs `PowerGCRA`, token buckets vs leaky buckets         |
| Resilience    | `resilience.mjs`    | `PowerCircuit`, `PowerRetry` with decorrelated jitter, `PowerDeadline` |
| Concurrency   | `pool.mjs`          | `PowerPool` over real worker threads, including autoscaling            |
| Batching      | `batch.mjs`         | `PowerBatch` amortising a burst into a flush                           |
| Backpressure  | `backpressure.mjs`  | `PowerPermitGate` and `PowerBulkhead` bounding concurrency             |
| Observability | `observability.mjs` | `PowerHistogram` quantiles and `PowerEventLoopMonitor`                 |
| Real-time     | `realtime.mjs`      | `PowerRealtimeHub` fan-out with a slow-consumer policy                 |
| Protocol      | `codec.mjs`         | `PowerMessageCodec` framing, and why the version byte exists           |
| Frameworks    | `frameworks.mjs`    | Framework-neutral lifecycle boundary for React, Vue, and Angular       |

The guides under [`guides/`](../guides/) cover the reference material; these
exist so you can see a working call before reading the prose. The copyable
framework snippets are in [`frameworks/`](frameworks/).
