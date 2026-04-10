# Benchmarks

Lightweight benchmarking helpers for `PowerPool` and `PowerCache`.

This folder contains a small harness (`bench/run.js`) that measures:

- single-threaded CPU-bound compute (baseline)
- multi-worker `PowerPool` performance across pool sizes
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

Quick usage

```bash
# Run the full benchmark suite (profiles + cache)
npm run bench

# Run only the profile-based worker-pool benchmarks (across variable load mixes)
npm run bench:pool

# Run only the cache workload
npm run bench:cache

# Run the profile-based pool benchmark directly
node bench/run.js profiles

# Run only the realistic scenario benchmarks
node bench/run.js scenarios

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

Tips and notes

- Start with small values during iteration: `BENCH_TASKS=2 BENCH_ITERS=10000` to validate changes quickly
- Use `BENCH_POOL_TIMEOUT=0` when you expect long runs and don't want the harness to fall back to the plain `worker_threads` implementation
- The harness writes human-readable results to `bench/results.md` and writes a machine-readable copy to `results.json` at the repository root; the markdown contains a link to that file

Example quick smoke run

```bash
BENCH_TASKS=2 BENCH_ITERS=10000 BENCH_POOLS=1 BENCH_POOL_TIMEOUT=0 node bench/run.js pool
```

Reproducibility

- Run the same `BENCH_TASKS`, `BENCH_ITERS` and `BENCH_POOLS` across machines to compare relative performance
- Benchmark results are noisy on shared machines; run multiple times and take median/mean as appropriate