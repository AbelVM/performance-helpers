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
- `BENCH_SEED` (default: `0x5eed1234`) — seed for the workload generator. Every workload — load profiles, task ordering, Box-Muller sampling — is built from this one seeded PRNG, so two runs with the same seed measure the _same work_ and are directly comparable. Set it deliberately when you want a different workload
- `BENCH_HELPER_OPS` (default: `100000`) — operation count for each helper micro-benchmark variant

## `claims.js` — feature claims, not throughput

`bench/claims.js` is separate from `run.js` on purpose. `run.js` measures how fast things are; `claims.js` checks whether a shipped feature does what the release notes say it does.

```bash
node bench/claims.js zipf      # cache admission policies under a Zipf + scan workload
node bench/claims.js sieve     # SIEVE eviction policy, against what ships
node bench/claims.js latency   # PowerHistogram quantile accuracy across 4 decades of scale
```

Both report **ratios over a whole run** — hit rate, and quantile relative error — rather than wall-clock. That is not a stylistic choice: `run.js` measures a 28% median min/max spread on a typical machine, so any timing comparison finer than that is noise, while a ratio computed over every operation is immune to how fast the machine is.

The `zipf` workload drives every policy with a **byte-identical seeded key stream**, so a difference between two rows is attributable to the policy rather than to a different input. It also **refuses to run** when `maxEntries` exceeds the working set: a cache that can hold the whole working set has no admission problem, every policy ties near 100%, and the run would prove nothing. Parameters are overridable — `CLAIM_ZIPF`, `CLAIM_WORKING_SET`, `CLAIM_MAX_ENTRIES`, `CLAIM_SCAN_KEYS`, `CLAIM_SCAN_EVERY`, `CLAIM_REPEATS` — and the seed is shared with `run.js` so a result is reproducible.

**`zipf` currently reports a failure.** `admission: 'tynilfu'` is meant to protect a working set from a scan; on a cold cache it does the opposite, measuring a 2.5% hit rate against plain LRU's 66.4%. The release note's original claim for this feature has been withdrawn accordingly. Run the benchmark rather than trusting either the old note or this paragraph.

**`sieve` reports a negative result, and that is the finding.** SIEVE is implemented _in the bench file_, not in `src/`: the claim under test is whether a policy beats what ships, so the policy was measured before the library gained it. It sits beside a hand-rolled plain-LRU **control** that differs from it in exactly one respect — three pointer writes per hit instead of one bit store — and that control reproduces shipped `PowerCache` exactly on both traces, which is what makes the SIEVE row a difference in policy rather than a difference in structure.

It does not pay here. On zipf + scan, SIEVE measures **26.4 %** against LRU's **27.0 %**; scan-heavy, **51.1 %** against **51.0 %** — a tie. The paper's cost claim does not reproduce either: the hit really is cheaper in principle and it is **slower** in practice here (137 ns/op against the control's 105).

Read the row, not just the verdict: **the benchmark is silent on the paper's headline claim.** "No lock on a hit, 2× a 16-thread LRU" is about _concurrent_ caches, and a single-threaded Node run cannot measure lock contention. This measures the portable half — miss ratio — and says only that it does not transfer to these traces. It is not evidence against SIEVE for a lock-contended multicore cache.

Two trace-design notes worth keeping, because both produced wrong numbers before the right one. The working set must **exceed** capacity: the first scan-heavy run used 300 against 500 and every policy survived 300/300, so the scan fit in the slack and nothing was ever evicted — the comparison was vacuous. And SIEVE's hand is **persistent and one-way**; resetting it per eviction is a CLOCK sweep, a weaker policy that is not SIEVE, and it reported a 5-point loss. Hit rates here are deterministic — same seed, identical survivors across runs — so only the ns/op column moves.

Parameters: `CLAIM_SIEVE_CAPACITY`, `CLAIM_SIEVE_SEED`, `CLAIM_SIEVE_WORKING`, `CLAIM_SIEVE_SCAN_EVERY`, `CLAIM_SIEVE_SCAN_KEYS`, `CLAIM_SIEVE_ZIPF`.

The same mode also benches the **generational two-`Map`** structure (`quick-lru` / `hashlru`), and that row is the more interesting one. At the configured `maxEntries` it shows the largest number in the table — **+13.0 points** over LRU on scan-heavy — and gets there by **peaking at 1003 entries against a configured 500**. That is the row's own "up to 2x over-fill" bound, reproduced exactly. Sized so its peak lands at 502 instead, it scores **35.5 %** against LRU's 51.0 %: **the entire margin was the memory.**

Read the `peak` column before the verdict, always. For `PowerCache` specifically, `maxEntries` is not a memory hint but a contract — `_evictIfNeeded` loops while `_map.size > this.maxEntries` and `stats().size` is public — so a structure holding 2x `maxEntries` breaks a published guarantee rather than exceeding a soft one. `bench: generational @ half cap` exists for exactly this comparison; without it the full-capacity row reads as a win.

What survives is the structural claim, which was the genuinely new part of the proposal: no cursor and no node pool makes CACHE-001 _structurally_ impossible rather than merely unreachable-by-inspection. That is a real property — and CACHE-001 is closed as not reproducible, so it prevents a bug that does not exist.

## `baseline.js` — a timing gate that knows it is on a machine

`run.js` measures a 28% median min/max spread on a typical machine, so a hand-written "within ±20% of the committed baseline" gate is not a weak gate — it is an unreliable one, and the fastest way to get a flaky gate ignored is to ship one. This is the gate that was specified anyway, with the threshold **derived rather than chosen**.

```bash
npm run bench:baseline       # measure this machine and record its baseline
npm run bench:gate           # measure and compare; exit 1 only on a reproduced regression
npm run bench:baseline:show  # print the recorded baseline
```

Three things make it different from the ±20% version:

- **The threshold is each site's own recorded spread**, so a clean tree passes by construction and a site calibrated at 80% spread is not held to the same bar as one at 8%. A constant chosen in advance is a coin flip; a threshold measured on the machine is a measurement.
- **Baselines are per-machine and gitignored**, in `bench/baselines/<hash>.json`. The key hashes hostname, platform, arch, CPU model, core count and Node version. A committed absolute baseline is a claim about every other machine's hardware, which is the mistake this design exists to avoid — and the files end up in CI artifacts, so the hash keeps a hostname out of them.
- **There are three answers, not two.** A run is `PASS`, `FAIL`, or `INCONCLUSIVE` — and _inconclusive is never a failure_. It covers both a machine whose level has drifted (the median delta across all sites is the signal, so one real regression cannot hide inside it) and a machine noisier than it was calibrated. Measured during development: a clean tree reported six unrelated helpers 44–48% slower than a baseline recorded minutes earlier, and a gate that failed on that would have been wrong.

A `FAIL` also **re-measures before reporting**. Nine samples, trimmed one from each end, still admits a GC pause landing on one measurement — one site out of 25 came back +48.9% against a 7.8% threshold on an unmodified tree. A real regression is still there on the second run; a blip is not, and the gate says `INCONCLUSIVE` rather than failing. It costs a second pass only when something was already reported, and nothing at all when the tree is clean.

**Mutation-checked, because a gate that always passes is worse than none.** A deliberate second `get` inside `PowerCache.get` is caught and reproduced (`cacheHitMs: 9.9 ms → 16.0 ms, +62%` against a 17.6% threshold); a clean tree is not. Two versions of this gate failed that check first — one that had no cache site to move at all, and one whose threshold arithmetic turned a 60% band into a 3000% allowance. The sites it guards are `PowerCache` (`get` on hits, `set` on misses) and `PowerThrottle.tryConsume`: the two the item names, and the two that had no band.

The gate measures the harness's `helpers` mode only. The full run takes the better part of an hour, which is too long to run before landing a change, and the pool scenarios are dominated by worker start-up and message transport, where the spread is far wider. Override with `BENCH_GATE_MODE=all` for a change big enough to want the slower run.

CI has no baseline to compare against on a fresh runner, so `bench:gate` **exits 0 and says so** rather than failing a run it cannot judge. Cache `bench/baselines/` as an artifact to get a real verdict.

## Reading a run honestly

Every generated report opens with a **Measurement quality** section, and it is the part to read before any number in the file:

- **The seed** tells you whether two runs are comparable at all. Before the seed was fixed, every workload came from `Math.random()`, so two runs measured two different workloads and no delta between them was meaningful — repetition reduces timer noise, not workload noise.
- **The noise floor** is the median min/max spread across all timed variants. A claimed improvement smaller than this is **not measurable at this sample count**, and raising `BENCH_RUNS` is the first thing to try. On a busy machine this number is easily above 20%, which is worth knowing before arguing about a 5% change.
- **Whether `global.gc()` ran.** The `bench*` npm scripts pass `--expose-gc`; invoking `node bench/run.js` directly does not, and the report says so explicitly. Without it, each phase is measured on the previous phase's uncollected garbage, and `memDeltaKb` inherits phantom memory cost from the helper before it.

The outlier policy is a **symmetric** one-from-each-end trim, not "discard anything slow". A GC pause only makes a run slower, so a one-sided rule would delete the most important noise source in a Node benchmark while leaving a pathologically fast run to distort the median in the other direction.

Tips and notes

- Start with small values during iteration: `BENCH_TASKS=2 BENCH_ITERS=10000` to validate changes quickly
- Use `BENCH_HELPER_OPS=10000` for a fast smoke test of all helpers, and `node bench/run.js helpers` to run _only_ the helper micro-benchmarks — the pool and scenario phases dominate wall-clock time, and `helpers` is the fast way to iterate on them
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
