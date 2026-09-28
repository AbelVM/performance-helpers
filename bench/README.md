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
- **historical delta comparison**: on each run, results are compared against the previous `results.json` and regressions/improvements beyond the configured thresholds are highlighted in the markdown (35% + 50ms absolute for pool scenarios, 20% + 8ms absolute for helper micro-benchmarks; see `POOL_PCT_THRESHOLD` / `HELPER_PCT_THRESHOLD` in `run.js`)

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
- `BENCH_RUNS` (default: `9`) — repeat each helper micro-benchmark N times and report the **trimmed median** (one sample dropped from each end once N ≥ 5); raises to 9 from 5 because at 5 runs a single GC pause moves the reported median by more than most of the deltas this harness is asked to justify
- `BENCH_SEED` (default: `0x5eed1234`) — seed for the workload generator. Every workload — load profiles, task ordering, Box-Muller sampling — is built from this one seeded PRNG, so two runs with the same seed measure the *same work* and are directly comparable. Set it deliberately when you want a different workload
- `BENCH_HELPER_OPS` (default: `100000`) — operation count for each helper micro-benchmark variant

## `claims.js` — feature claims, not throughput

`bench/claims.js` is separate from `run.js` on purpose. `run.js` measures how fast things are; `claims.js` checks whether a shipped feature does what the release notes say it does.

```bash
node bench/claims.js zipf      # cache admission policies under a Zipf + scan workload
node bench/claims.js latency   # PowerHistogram quantile accuracy across 4 decades of scale
```

Both report **ratios over a whole run** — hit rate, and quantile relative error — rather than wall-clock. That is not a stylistic choice: `run.js` measures a 28% median min/max spread on a typical machine, so any timing comparison finer than that is noise, while a ratio computed over every operation is immune to how fast the machine is.

The `zipf` workload drives every policy with a **byte-identical seeded key stream**, so a difference between two rows is attributable to the policy rather than to a different input. It also **refuses to run** when `maxEntries` exceeds the working set: a cache that can hold the whole working set has no admission problem, every policy ties near 100%, and the run would prove nothing. Parameters are overridable — `CLAIM_ZIPF`, `CLAIM_WORKING_SET`, `CLAIM_MAX_ENTRIES`, `CLAIM_SCAN_KEYS`, `CLAIM_SCAN_EVERY`, `CLAIM_REPEATS` — and the seed is shared with `run.js` so a result is reproducible.

**`zipf` currently reports a failure.** `admission: 'tynilfu'` is meant to protect a working set from a scan; on a cold cache it does the opposite, measuring a 2.5% hit rate against plain LRU's 66.4%. The release note's original claim for this feature has been withdrawn accordingly. Run the benchmark rather than trusting either the old note or this paragraph.

## Reading a run honestly

Every generated report opens with a **Measurement quality** section, and it is the part to read before any number in the file:

- **The seed** tells you whether two runs are comparable at all. Before the seed was fixed, every workload came from `Math.random()`, so two runs measured two different workloads and no delta between them was meaningful — repetition reduces timer noise, not workload noise.
- **The noise floor** is the median min/max spread across all timed variants. A claimed improvement smaller than this is **not measurable at this sample count**, and raising `BENCH_RUNS` is the first thing to try. On a busy machine this number is easily above 20%, which is worth knowing before arguing about a 5% change.
- **Whether `global.gc()` ran.** The `bench*` npm scripts pass `--expose-gc`; invoking `node bench/run.js` directly does not, and the report says so explicitly. Without it, each phase is measured on the previous phase's uncollected garbage, and `memDeltaKb` inherits phantom memory cost from the helper before it.

The outlier policy is a **symmetric** one-from-each-end trim, not "discard anything slow". A GC pause only makes a run slower, so a one-sided rule would delete the most important noise source in a Node benchmark while leaving a pathologically fast run to distort the median in the other direction.

Tips and notes

- Start with small values during iteration: `BENCH_TASKS=2 BENCH_ITERS=10000` to validate changes quickly
- Use `BENCH_HELPER_OPS=10000` for a fast smoke test of all helpers, and `node bench/run.js helpers` to run *only* the helper micro-benchmarks — the pool and scenario phases dominate wall-clock time, and `helpers` is the fast way to iterate on them
- Use `BENCH_POOL_TIMEOUT=0` when you expect long runs and don't want the harness to fall back to the plain `worker_threads` implementation
- Use `BENCH_POOL_RUNS=3` for more stable pool benchmark numbers on a noisy machine (runs each pool variant 3 times, reports median)
- Use `BENCH_RUNS=15` or higher when you need to resolve a small delta; check the reported noise floor to confirm it worked
- The harness writes human-readable results to `bench/results.md` and writes a machine-readable copy to `results.json` at the repository root; the markdown contains a link to that file

Example quick smoke run

```bash
BENCH_TASKS=2 BENCH_ITERS=10000 BENCH_POOLS=1 BENCH_POOL_TIMEOUT=0 BENCH_HELPER_OPS=1000 node bench/run.js pool
```

Reproducibility

- Run the same `BENCH_TASKS`, `BENCH_ITERS` and `BENCH_POOLS` across machines to compare relative performance
- Benchmark results are noisy on shared machines; run multiple times and take median/mean as appropriate
- The `Δ prev` column in the markdown shows changes relative to the previous `results.json` on disk — commit `results.json` to track regressions over time