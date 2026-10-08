# Benchmark Results

Generated: 2026-10-08T09:55:05.706Z

## Configuration

- MODE: all
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8
- LOAD_PROFILES: 0% variable, 25% variable, 50% variable, 75% variable, 100% variable
- BENCH_RUNS: 9
- POOL_RUNS: 3
- HELPER_OPS: 100000

## Measurement quality

- Workload seed: `1592594996` (default) — the workload is generated from a seeded PRNG, so two runs with this seed measure the same work and are comparable. Set `BENCH_SEED` to vary it deliberately.
- Repeats: 9 per micro-benchmark, 3 per pool variant
- Outliers: symmetric trim 1 from each end, reported as the trimmed median
- `global.gc()` between repeats and phases: enabled (run with `--expose-gc`)
- Noise floor: **21.92%** median min/max spread across 25 timed variants (p95 134.08%, max 188.04% at `noPresMs`)
  - Any claimed delta smaller than this is **not measurable at this sample count** — raise `BENCH_RUNS` before believing it.

Learn more about the benchmarks [here](README.md)

## Synthetic scenario benchmarks

### Load profile: 0% variable

- Single-threaded total: 2845.76 ms | throughput: 351 tasks/s | p50: 3.18 ms | p95: 3.39 ms | p99: 3.52 ms
- Worker-thread total: 3435.20 ms

| Pattern \ Pool size      |                    1 |       2 |       4 |      8 | Speedup |
| :----------------------- | -------------------: | ------: | ------: | -----: | ------: |
| Pool                     | 3238.32 _(+8112.0%)_ | 1272.72 |  649.66 | 377.66 |   7.54x |
| Pool + Autoscale         | 3523.31 _(+8765.0%)_ | 1291.25 |  484.86 | 327.39 |   8.69x |
| Pool + Cache             |     54.41 _(+38.6%)_ |   42.94 | `42.92` |  49.53 |  66.30x |
| Pool + Cache + Autoscale |     55.90 _(+43.3%)_ |   44.03 |   49.12 |  53.66 |  64.64x |

### Load profile: 25% variable

- Single-threaded total: 1346.36 ms | throughput: 743 tasks/s | p50: 1.30 ms | p95: 1.89 ms | p99: 2.24 ms
- Worker-thread total: 2035.68 ms

| Pattern \ Pool size      |                    1 |      2 |      4 |        8 | Speedup |
| :----------------------- | -------------------: | -----: | -----: | -------: | ------: |
| Pool                     | 2022.41 _(+5275.1%)_ | 753.79 | 390.81 |   350.45 |   3.84x |
| Pool + Autoscale         | 2105.18 _(+5338.5%)_ | 747.49 | 403.17 |   290.30 |   4.64x |
| Pool + Cache             |   439.14 _(+997.9%)_ | 228.83 | 156.12 |   143.59 |   9.38x |
| Pool + Cache + Autoscale |  438.53 _(+1019.8%)_ | 239.28 | 141.38 | `115.78` |  11.63x |

### Load profile: 50% variable

- Single-threaded total: 1541.15 ms | throughput: 649 tasks/s | p50: 1.53 ms | p95: 2.16 ms | p99: 2.89 ms
- Worker-thread total: 2250.54 ms

| Pattern \ Pool size      |                    1 |      2 |      4 |        8 | Speedup |
| :----------------------- | -------------------: | -----: | -----: | -------: | ------: |
| Pool                     | 2232.18 _(+5544.0%)_ | 820.24 | 447.52 |   349.12 |   4.41x |
| Pool + Autoscale         | 2354.04 _(+5759.1%)_ | 813.24 | 445.16 |   320.41 |   4.81x |
| Pool + Cache             |  840.01 _(+2065.5%)_ | 434.27 | 250.97 |   209.75 |   7.35x |
| Pool + Cache + Autoscale |  871.73 _(+2124.7%)_ | 437.91 | 251.98 | `188.77` |   8.16x |

### Load profile: 75% variable

- Single-threaded total: 1959.36 ms | throughput: 510 tasks/s | p50: 1.73 ms | p95: 3.70 ms | p99: 4.54 ms
- Worker-thread total: 2284.17 ms

| Pattern \ Pool size      |                    1 |      2 |      4 |        8 | Speedup |
| :----------------------- | -------------------: | -----: | -----: | -------: | ------: |
| Pool                     | 2307.69 _(+8287.1%)_ | 824.74 | 451.48 |   371.18 |   5.28x |
| Pool + Autoscale         | 2314.20 _(+5490.8%)_ | 839.03 | 447.50 |   322.39 |   6.08x |
| Pool + Cache             | 1603.55 _(+4025.0%)_ | 655.31 | 353.78 |   297.28 |   6.59x |
| Pool + Cache + Autoscale | 1668.37 _(+4197.2%)_ | 644.84 | 359.12 | `234.68` |   8.35x |

### Load profile: 100% variable

- Single-threaded total: 1565.07 ms | throughput: 639 tasks/s | p50: 1.57 ms | p95: 2.24 ms | p99: 2.54 ms
- Worker-thread total: 2328.03 ms

| Pattern \ Pool size      |                    1 |      2 |      4 |        8 | Speedup |
| :----------------------- | -------------------: | -----: | -----: | -------: | ------: |
| Pool                     | 2297.63 _(+5828.0%)_ | 841.10 | 463.93 |   412.40 |   3.80x |
| Pool + Autoscale         | 2301.95 _(+5884.0%)_ | 833.75 | 498.08 |   291.39 |   5.37x |
| Pool + Cache             | 2342.80 _(+5877.8%)_ | 832.77 | 474.17 |   334.81 |   4.67x |
| Pool + Cache + Autoscale | 2380.49 _(+6083.5%)_ | 860.57 | 465.38 | `289.46` |   5.41x |

## Realistic scenario benchmarks

### Load profile: Burstiness

| Pattern \ Pool size      |                    1 |      2 |      4 |       8 |
| :----------------------- | -------------------: | -----: | -----: | ------: |
| Pool                     | 2305.06 _(+4403.2%)_ | 879.48 | 511.78 |  329.09 |
| Pool + Autoscale         | 2490.96 _(+4835.4%)_ | 915.70 | 503.88 |  305.25 |
| Pool + Cache             |      54.56 _(+6.1%)_ |  51.81 |  51.94 | `49.75` |
| Pool + Cache + Autoscale |     55.32 _(+11.7%)_ |  73.93 |  50.77 |   50.00 |

### Load profile: Mixed task sizes

| Pattern \ Pool size      |                    1 |      2 |       4 |      8 |
| :----------------------- | -------------------: | -----: | ------: | -----: |
| Pool                     | 2444.63 _(+6438.2%)_ | 887.16 |  486.90 | 407.79 |
| Pool + Autoscale         | 2472.66 _(+6205.7%)_ | 913.51 |  495.73 | 326.80 |
| Pool + Cache             |     63.82 _(+72.5%)_ |  46.56 |   45.16 |  53.24 |
| Pool + Cache + Autoscale |     61.93 _(+63.4%)_ |  42.48 | `40.28` |  58.11 |

### Load profile: Ramp traffic

| Pattern \ Pool size      |                    1 |      2 |      4 |      8 |
| :----------------------- | -------------------: | -----: | -----: | -----: |
| Pool                     | 2289.75 _(+2060.2%)_ | 855.43 | 458.72 | 359.56 |
| Pool + Autoscale         | 2362.04 _(+2095.3%)_ | 879.00 | 451.20 | 334.85 |
| Pool + Cache             |     106.37 _(+0.7%)_ | 106.87 | 106.04 | 106.22 |
| Pool + Cache + Autoscale |   `104.90` _(-1.1%)_ | 105.11 | 105.20 | 106.86 |

### Load profile: Variable payload sizes

| Pattern \ Pool size      |                    1 |      2 |       4 |      8 |
| :----------------------- | -------------------: | -----: | ------: | -----: |
| Pool                     | 2421.01 _(+7505.8%)_ | 836.51 |  467.77 | 365.78 |
| Pool + Autoscale         | 2331.17 _(+5679.6%)_ | 842.21 |  459.77 | 321.12 |
| Pool + Cache             |     58.13 _(+46.0%)_ |  48.29 |   46.07 |  51.21 |
| Pool + Cache + Autoscale |     57.65 _(+48.4%)_ |  43.65 | `40.80` |  55.88 |

### Load profile: I/O bound

| Pattern \ Pool size      |                    1 |       2 |       4 |       8 |
| :----------------------- | -------------------: | ------: | ------: | ------: |
| Pool                     | 2275.30 _(+4954.7%)_ | 1173.75 |  611.85 |  433.52 |
| Pool + Autoscale         | 8229.86 _(+8642.6%)_ | 4118.64 | 2021.19 | 1050.35 |
| Pool + Cache             |     58.83 _(+32.9%)_ |   63.68 | `57.36` |   58.74 |
| Pool + Cache + Autoscale |   209.60 _(+425.1%)_ |  111.96 |   77.73 |   67.02 |

### Load profile: Thundering herd

| Pattern \ Pool size      |                    1 |      2 |       4 |      8 |
| :----------------------- | -------------------: | -----: | ------: | -----: |
| Pool                     | 2300.02 _(+5707.3%)_ | 828.00 |  457.98 | 360.74 |
| Pool + Autoscale         | 2382.94 _(+5955.5%)_ | 837.92 |  456.17 | 314.12 |
| Pool + Cache             |     30.18 _(-22.3%)_ |  32.02 |   31.47 |  36.43 |
| Pool + Cache + Autoscale |     24.01 _(-37.9%)_ |  26.08 | `23.11` |  35.34 |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size      |                    1 |      2 |      4 |        8 |
| :----------------------- | -------------------: | -----: | -----: | -------: |
| Pool                     | 2302.86 _(+5850.7%)_ | 825.69 | 467.56 |   375.17 |
| Pool + Autoscale         | 2315.54 _(+5925.7%)_ | 836.24 | 438.66 |   318.94 |
| Pool + Cache             | 2028.85 _(+4901.8%)_ | 750.46 | 405.65 |   327.25 |
| Pool + Cache + Autoscale | 2145.66 _(+5418.1%)_ | 756.10 | 405.54 | `296.00` |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size      |                    1 |      2 |      4 |        8 |
| :----------------------- | -------------------: | -----: | -----: | -------: |
| Pool                     | 2284.94 _(+5858.6%)_ | 824.75 | 447.28 |   397.62 |
| Pool + Autoscale         | 2339.82 _(+6157.2%)_ | 837.67 | 444.73 |   320.67 |
| Pool + Cache             |  934.53 _(+2294.1%)_ | 466.01 | 310.74 |   220.29 |
| Pool + Cache + Autoscale |  947.08 _(+2321.8%)_ | 471.17 | 282.36 | `189.35` |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size      |                    1 |      2 |      4 |       8 |
| :----------------------- | -------------------: | -----: | -----: | ------: |
| Pool                     | 2303.09 _(+5905.0%)_ | 844.90 | 485.78 |  356.37 |
| Pool + Autoscale         | 2298.96 _(+5856.1%)_ | 825.96 | 474.80 |  323.94 |
| Pool + Cache             |   262.39 _(+568.5%)_ | 154.69 |  88.58 |   98.22 |
| Pool + Cache + Autoscale |   272.14 _(+626.0%)_ | 149.74 |  98.74 | `78.24` |

## Cache benchmark

- Miss total: 4.98 ms
- Hit total (5 reps): 2.27 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 5.09 ms
- Hit pass under eviction: 0.38 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 13.35 ms
- Concurrent (dedup): 1.49 ms (88.8% faster)

- Cache getOrSetAsync dedupe total: 15.84 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10

## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 32.24 ms
- Warm-start total: 0.25 ms

- PowerMemoizer total: 16.06 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10

## Helper micro-benchmarks

_100,000 ops per variant, median of 9 runs_

| Helper                 | Variant                               | Total (ms) |     ops/sec | Δ prev |
| :--------------------- | :------------------------------------ | ---------: | ----------: | -----: |
| **PowerRateLimit**     | under rate (all pass)                 |      13.24 |   7,553,733 |  (new) |
| **PowerRateLimit**     | over rate (~50% reject)               |      14.04 |   7,122,508 |  (new) |
| **PowerCircuit**       | closed (happy path)                   |       1.84 |  10,842,659 |  (new) |
| **PowerCircuit**       | open (fast-fail)                      |      52.73 |     379,298 |  (new) |
| **PowerRetry**         | 1 attempt (no retry)                  |       5.06 |   1,976,717 |  (new) |
| **PowerRetry**         | 2 attempts (1 retry, baseDelay=0)     |   10907.60 |         917 |  (new) |
| **PowerSemaphore**     | limit=1 (exclusive lock, serial)      |      10.53 |   4,749,779 |  (new) |
| **PowerSemaphore**     | limit=8 (concurrent pool)             |      34.68 |   1,441,799 |  (new) |
| **PowerBulkhead**      | 1 partition (baseline)                |      25.76 |     776,414 |  (new) |
| **PowerBulkhead**      | 2 partitions (critical vs background) |      25.66 |     779,411 |  (new) |
| **PowerBatch**         | individual dispatch (maxSize=1)       |      43.47 |   2,300,369 |  (new) |
| **PowerBatch**         | coalesced dispatch (maxSize=ops)      |      10.55 |   9,474,508 |  (new) |
| **PowerBackpressure**  | no pressure (capacity >> ops)         |       2.49 |  12,032,705 |  (new) |
| **PowerBackpressure**  | with pressure (capacity=100)          |       9.70 |   3,091,810 |  (new) |
| **PowerTTLMap**        | long TTL (60 s, no eviction)          |      20.42 |   4,897,859 |  (new) |
| **PowerTTLMap**        | short TTL (1 ms, high eviction)       |      20.57 |   4,861,425 |  (new) |
| **PowerEventBus**      | 1 subscriber                          |       6.31 |  15,841,260 |  (new) |
| **PowerEventBus**      | 10 subscribers                        |      12.95 |   7,723,233 |  (new) |
| **PowerEventBus**      | 50 subscribers                        |      41.36 |   2,418,056 |  (new) |
| **PowerEventBus**      | 100 subscribers                       |      78.04 |   1,281,426 |  (new) |
| **PowerDeadline**      | success (task within deadline)        |      12.58 |     397,559 |  (new) |
| **PowerDeadline**      | abort (task exceeds 1 ms deadline)    |    5417.13 |         923 |  (new) |
| **PowerSlidingWindow** | under capacity (all pass)             |      11.53 |   8,669,674 |  (new) |
| **PowerSlidingWindow** | at capacity (~50% reject)             |      10.30 |   9,706,911 |  (new) |
| **PowerQueue**         | push x100000 + shift x100000          |       3.34 |  29,938,874 |  (new) |
| **PowerQueue**         | interleaved push+shift (steady state) |       0.57 | 175,194,247 |  (new) |
| **PowerCache**         | get x100000 (all hits)                |      12.64 |   7,912,025 |  (new) |
| **PowerCache**         | set x100000 (all misses)              |      24.35 |   4,106,802 |  (new) |
| **PowerThrottle**      | tryConsume x100000 (all granted)      |       5.04 |  19,846,519 |  (new) |

## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

### Regressions

| Key                                             | prev (ms) | current (ms) |            Δ |
| :---------------------------------------------- | --------: | -----------: | -----------: |
| profiles/0% variable/autoscalePool/1            |     39.74 |      3523.31 | **+8765.0%** |
| scenarios/I/O bound/autoscalePool/1             |     94.13 |      8229.86 | **+8642.6%** |
| profiles/75% variable/pool/1                    |     27.51 |      2307.69 | **+8287.1%** |
| profiles/0% variable/pool/1                     |     39.43 |      3238.32 | **+8112.0%** |
| scenarios/Variable payload sizes/pool/1         |     31.83 |      2421.01 | **+7505.8%** |
| scenarios/Mixed task sizes/pool/1               |     37.39 |      2444.63 | **+6438.2%** |
| scenarios/Mixed task sizes/autoscalePool/1      |     39.21 |      2472.66 | **+6205.7%** |
| scenarios/Cache hit ratio 50%/autoscalePool/1   |     37.39 |      2339.82 | **+6157.2%** |
| profiles/100% variable/autoscaleOptimizedPool/1 |     38.50 |      2380.49 | **+6083.5%** |
| scenarios/Thundering herd/autoscalePool/1       |     39.35 |      2382.94 | **+5955.5%** |
| scenarios/Cache hit ratio 10%/autoscalePool/1   |     38.43 |      2315.54 | **+5925.7%** |
| scenarios/Cache hit ratio 90%/pool/1            |     38.35 |      2303.09 | **+5905.0%** |
| profiles/100% variable/autoscalePool/1          |     38.47 |      2301.95 | **+5884.0%** |
| profiles/100% variable/optimizedPool/1          |     39.19 |      2342.80 | **+5877.8%** |
| scenarios/Cache hit ratio 50%/pool/1            |     38.35 |      2284.94 | **+5858.6%** |
| scenarios/Cache hit ratio 90%/autoscalePool/1   |     38.60 |      2298.96 | **+5856.1%** |
| scenarios/Cache hit ratio 10%/pool/1            |     38.70 |      2302.86 | **+5850.7%** |
| profiles/100% variable/pool/1                   |     38.76 |      2297.63 | **+5828.0%** |
| profiles/50% variable/autoscalePool/1           |     40.18 |      2354.04 | **+5759.1%** |
| scenarios/Thundering herd/pool/1                |     39.61 |      2300.02 | **+5707.3%** |
