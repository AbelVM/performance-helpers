# Benchmarks

Lightweight benchmarking helpers for `PowerPool` and `PowerCache`.

This folder contains a small harness (`bench/run.js`) that measures:

- single-threaded CPU-bound compute (baseline) with **p50/p95/p99** per-task latency
- multi-worker `PowerPool` performance across pool sizes with **speedup vs single-threaded**
- a simple `PowerCache` hit/miss benchmark
- `PowerPool + PowerCache` optimized cache reuse patterns
- `PowerPool` autoscaling performance
- `PowerMemoizer` memoization overhead with duplicate keys
- multiple real-world load profiles: `0%`, `25%`, `50%`, `75%`, and `100%` variable load
- additional realistic scenario benchmarks, including:
  - `Burstiness`: sudden bursts of work followed by short quiet periods
  - `Mixed task sizes`: alternating light and heavy work items to mimic uneven request costs
  - `Ramp traffic`: gradual ramp-up and ramp-down of task submission rates
  - `Variable payload sizes`: payloads with different serialized sizes to exercise data movement
  - `I/O bound`: tasks that include small async wait periods to simulate I/O latency
  - `Thundering herd`: many tasks contending for the same cache key at once
  - `Cache hit-ratio sweeps`: low/medium/high reuse ratios for cache-backed work
  - `Cache warmup behavior`: cold vs warm cache performance for repeated workloads
  - `Cache eviction under pressure`: tight maxEntries (20% of unique keys) measuring LRU overhead
  - `Serial vs concurrent getOrSetAsync`: in-flight deduplication benefit quantified
- **helper micro-benchmarks** for primitives not covered by the pool harness:
  - `PowerRateLimit`: tryConsume throughput under rate (all pass) and over rate (~50% rejected)
  - `PowerCircuit`: `call()` overhead in closed (happy path) vs open (fast-fail) state
  - `PowerRetry`: `run()` overhead with 0 retries and 1 retry (baseDelay=0)
  - `PowerSemaphore`: serial (limit=1) and concurrent (limit=8) permit acquisition
  - `PowerBulkhead`: single partition vs 2-partition critical/background isolation
  - `PowerBatch`: individual dispatch (maxSize=1) vs coalesced dispatch
  - `PowerBackpressure`: acquire/release with no pressure and with capacity=100
  - `PowerTTLMap`: set/get throughput with long TTL (no eviction) and short TTL (1 ms, high churn)
  - `PowerEventBus`: `emit` fan-out throughput at 1 / 10 / 50 / 100 subscribers
  - `PowerDeadline`: success path overhead and abort-path cost when task exceeds deadline
  - `PowerSlidingWindow`: `tryConsume` throughput under capacity and at capacity
  - `PowerQueue`: bulk push+shift and interleaved (ring-buffer steady state)
- **historical delta comparison**: on each run, results are compared against the previous `results.json` and regressions/improvements > 5% are highlighted in the markdown

Quick usage

```bash
# Run the full benchmark suite (profiles + cache + helpers)
npm run bench

# Run only the profile-based worker-pool benchmarks (across variable load mixes)
npm run bench:pool

# Run only the cache workload
npm run bench:cache

# Run the profile-based pool benchmark directly
node bench/run.js profiles

# Run only the realistic scenario benchmarks
node bench/run.js scenarios

# Run only the helper micro-benchmarks
node bench/run.js helpers

# Alias for the same profile benchmark flow
node bench/run.js variable
```

Environment variables (defaults shown)

- `BENCH_TASKS` (default: `1000`) — number of tasks submitted to the pool (or keys for cache benchmark)
- `BENCH_ITERS` (default: `1000000`) — work per task (higher = heavier per-task CPU)
- `BENCH_POOLS` (default: `1,2,4,8`) — comma-separated pool sizes when running pool benchmarks
- `BENCH_POOL_TIMEOUT` (default: `0`) — ms timeout for each `PowerPool` run; set to `0` to disable timeout and let the pool run to completion
- `BENCH_CACHE_DUPLICATE_KEYS` (default: `10`) — unique key count for cache getOrSetAsync duplicate-key benchmark
- `BENCH_MEMOIZER_DUPLICATE_KEYS` (default: `10`) — unique key count for PowerMemoizer repeated-call benchmark
- `BENCH_AUTOSCALE_CACHE_KEYS` (default: `10`) — unique key count for autoscale + cache duplicate-key benchmark
- `BENCH_POOL_RUNS` (default: `3`) — repeat each pool/scenario variant N times and report the result closest to the median wall-clock time; set to `3` for more stable pool numbers at the cost of a ~3× longer run
- `BENCH_RUNS` (default: `5`) — repeat each helper micro-benchmark N times and report the median; reduces measurement noise from OS jitter and JIT warm-up variance
- `BENCH_HELPER_OPS` (default: `100000`) — operation count for each helper micro-benchmark variant

Tips and notes

- Start with small values during iteration: `BENCH_TASKS=2 BENCH_ITERS=10000` to validate changes quickly
- Use `BENCH_POOL_TIMEOUT=0` when you expect long runs and don't want the harness to fall back to the plain `worker_threads` implementation
- Use `BENCH_POOL_RUNS=3` for more stable pool benchmark numbers on a noisy machine (runs each pool variant 3 times, reports median)
- Use `BENCH_RUNS=7` for even more stable helper micro-benchmark numbers on a noisy machine
- Use `BENCH_HELPER_OPS=10000` to run a quick smoke test of all helpers
- The harness writes human-readable results to `bench/results.md` and writes a machine-readable copy to `results.json` at the repository root; the markdown contains a link to that file

Example quick smoke run

```bash
BENCH_TASKS=2 BENCH_ITERS=10000 BENCH_POOLS=1 BENCH_POOL_TIMEOUT=0 BENCH_HELPER_OPS=1000 node bench/run.js pool
```

Reproducibility

- Run the same `BENCH_TASKS`, `BENCH_ITERS` and `BENCH_POOLS` across machines to compare relative performance
- Benchmark results are noisy on shared machines; run multiple times and take median/mean as appropriate
- The `Δ prev` column in the markdown shows changes relative to the previous `results.json` on disk — commit `results.json` to track regressions over time