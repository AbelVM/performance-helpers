# Benchmark Results

Generated: 2026-10-18T21:45:38.610Z

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
- Noise floor: **15.73%** median min/max spread across 25 timed variants (p95 112.57%, max 136.04% at `pushShiftMs`)
  - Any claimed delta smaller than this is **not measurable at this sample count** — raise `BENCH_RUNS` before believing it.

Learn more about the benchmarks [here](README.md)

## Synthetic scenario benchmarks

### Load profile: 0% variable

- Single-threaded total: 2940.63 ms | throughput: 340 tasks/s | p50: 3.19 ms | p95: 3.36 ms | p99: 3.52 ms
- Worker-thread total: 3067.57 ms

| Pattern \ Pool size      |                 1 |                 2 |                4 |                8 | Speedup |
| :----------------------- | ----------------: | ----------------: | ---------------: | ---------------: | ------: |
| Pool                     | 2344.83 _(-0.3%)_ |  841.29 _(-1.5%)_ | 461.87 _(+0.3%)_ | 374.13 _(-5.5%)_ |   7.86x |
| Pool + Autoscale         | 2369.82 _(-0.7%)_ |  851.39 _(-0.6%)_ | 455.10 _(-0.7%)_ | 330.49 _(+0.5%)_ |   8.90x |
| Pool + Cache             |  36.87 _(-12.7%)_ | `31.91` _(-4.3%)_ |  38.12 _(+1.0%)_ |  50.40 _(-4.5%)_ |  92.15x |
| Pool + Cache + Autoscale |   48.34 _(+8.1%)_ |   38.43 _(-4.6%)_ | 44.41 _(+10.1%)_ |  54.18 _(-2.0%)_ |  76.52x |

### Load profile: 25% variable

- Single-threaded total: 1353.35 ms | throughput: 739 tasks/s | p50: 1.32 ms | p95: 1.89 ms | p99: 2.13 ms
- Worker-thread total: 2033.80 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: | ------: |
| Pool                     | 2005.76 _(-2.4%)_ | 732.63 _(-1.8%)_ | 402.95 _(+2.1%)_ |   326.95 _(-3.1%)_ |   4.14x |
| Pool + Autoscale         | 2049.44 _(-1.2%)_ | 752.27 _(+1.4%)_ | 395.53 _(-1.1%)_ |   291.99 _(+1.7%)_ |   4.63x |
| Pool + Cache             |  441.26 _(-1.3%)_ | 242.09 _(+1.2%)_ | 146.61 _(-6.1%)_ |  130.20 _(-15.7%)_ |  10.39x |
| Pool + Cache + Autoscale |  442.05 _(-2.1%)_ | 240.74 _(+0.6%)_ | 148.31 _(-2.4%)_ | `115.08` _(+0.1%)_ |  11.76x |

### Load profile: 50% variable

- Single-threaded total: 1569.50 ms | throughput: 637 tasks/s | p50: 1.53 ms | p95: 2.23 ms | p99: 3.11 ms
- Worker-thread total: 2234.00 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                   8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | ------------------: | ------: |
| Pool                     | 2230.03 _(-0.6%)_ | 813.03 _(-1.1%)_ | 428.90 _(-2.6%)_ |    352.44 _(-2.0%)_ |   4.45x |
| Pool + Autoscale         | 2275.47 _(-0.6%)_ | 815.31 _(+0.0%)_ | 435.31 _(-1.2%)_ |    321.34 _(+1.6%)_ |   4.88x |
| Pool + Cache             |  834.64 _(-1.0%)_ | 430.09 _(-1.2%)_ | 258.09 _(+1.3%)_ |    204.74 _(-9.9%)_ |   7.67x |
| Pool + Cache + Autoscale |  842.97 _(+0.1%)_ | 437.91 _(-2.3%)_ | 239.02 _(-2.8%)_ | `185.50` _(+11.1%)_ |   8.46x |

### Load profile: 75% variable

- Single-threaded total: 1933.24 ms | throughput: 517 tasks/s | p50: 1.74 ms | p95: 3.58 ms | p99: 4.08 ms
- Worker-thread total: 2311.14 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                   8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | ------------------: | ------: |
| Pool                     | 2287.98 _(+0.1%)_ | 834.82 _(-0.9%)_ | 444.18 _(+1.9%)_ |    353.97 _(-2.3%)_ |   5.46x |
| Pool + Autoscale         | 2309.14 _(-0.1%)_ | 834.55 _(+0.2%)_ | 457.43 _(-0.4%)_ |    321.38 _(-2.1%)_ |   6.02x |
| Pool + Cache             | 1584.02 _(-0.9%)_ | 636.89 _(-0.7%)_ | 362.33 _(-0.1%)_ |    291.44 _(-6.8%)_ |   6.63x |
| Pool + Cache + Autoscale | 1638.57 _(+0.9%)_ | 643.69 _(+0.0%)_ | 347.15 _(-3.7%)_ | `253.89` _(+12.7%)_ |   7.61x |

### Load profile: 100% variable

- Single-threaded total: 1563.39 ms | throughput: 640 tasks/s | p50: 1.57 ms | p95: 2.25 ms | p99: 2.52 ms
- Worker-thread total: 2312.40 ms

| Pattern \ Pool size      |                 1 |                  2 |                4 |                  8 | Speedup |
| :----------------------- | ----------------: | -----------------: | ---------------: | -----------------: | ------: |
| Pool                     | 2278.26 _(-0.4%)_ |   840.42 _(-0.8%)_ | 493.59 _(+5.8%)_ |  489.11 _(+30.3%)_ |   3.20x |
| Pool + Autoscale         | 2320.77 _(-0.7%)_ |   855.60 _(+2.1%)_ | 466.89 _(+1.6%)_ |  286.35 _(-11.6%)_ |   5.46x |
| Pool + Cache             | 2285.13 _(-0.8%)_ |   832.10 _(-0.6%)_ | 490.80 _(+6.1%)_ |   363.76 _(-7.5%)_ |   4.30x |
| Pool + Cache + Autoscale | 2321.22 _(-0.7%)_ | 1008.71 _(+20.6%)_ | 475.41 _(+2.1%)_ | `285.04` _(-1.2%)_ |   5.48x |

## Realistic scenario benchmarks

### Load profile: Burstiness

| Pattern \ Pool size      |                 1 |                2 |                 4 |                8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | ---------------: |
| Pool                     | 2303.82 _(-3.0%)_ | 838.07 _(+1.8%)_ |  462.25 _(+2.5%)_ | 387.64 _(-3.0%)_ |
| Pool + Autoscale         | 2309.11 _(-1.2%)_ | 838.03 _(-2.8%)_ |  441.76 _(-3.3%)_ | 317.87 _(+2.4%)_ |
| Pool + Cache             |  54.87 _(-12.2%)_ |  51.36 _(+1.3%)_ | `51.16` _(+2.8%)_ |  55.60 _(-4.1%)_ |
| Pool + Cache + Autoscale |   61.15 _(+0.5%)_ |  52.03 _(+2.4%)_ |   51.41 _(+0.9%)_ |  55.58 _(+1.9%)_ |

### Load profile: Mixed task sizes

| Pattern \ Pool size      |                 1 |                  2 |                4 |                8 |
| :----------------------- | ----------------: | -----------------: | ---------------: | ---------------: |
| Pool                     | 2393.13 _(+0.0%)_ |   880.68 _(-0.2%)_ | 485.47 _(+2.3%)_ | 385.75 _(-4.5%)_ |
| Pool + Autoscale         | 2446.12 _(-0.8%)_ |   864.07 _(+0.1%)_ | 466.67 _(+0.3%)_ | 336.19 _(+1.3%)_ |
| Pool + Cache             |  65.87 _(+12.0%)_ |    46.32 _(-0.4%)_ |  60.38 _(+9.6%)_ | 59.76 _(+18.2%)_ |
| Pool + Cache + Autoscale |   62.95 _(+3.7%)_ | `45.92` _(-41.2%)_ | 53.53 _(+22.8%)_ |  53.97 _(-3.2%)_ |

### Load profile: Ramp traffic

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: |
| Pool                     | 2281.33 _(-0.9%)_ | 822.60 _(-3.5%)_ | 461.94 _(+2.9%)_ |   396.43 _(-2.6%)_ |
| Pool + Autoscale         | 2304.39 _(-3.1%)_ | 833.94 _(+0.2%)_ | 470.56 _(+1.8%)_ |   331.86 _(+2.8%)_ |
| Pool + Cache             |  106.15 _(-0.1%)_ | 105.92 _(+0.4%)_ | 105.77 _(-1.2%)_ | `105.13` _(-1.5%)_ |
| Pool + Cache + Autoscale |  105.50 _(-1.2%)_ | 105.21 _(-0.6%)_ | 106.73 _(-0.7%)_ |   106.01 _(+0.6%)_ |

### Load profile: Variable payload sizes

| Pattern \ Pool size      |                 1 |                2 |                  4 |                8 |
| :----------------------- | ----------------: | ---------------: | -----------------: | ---------------: |
| Pool                     | 2257.52 _(-2.8%)_ | 839.42 _(-2.7%)_ |   447.32 _(-0.5%)_ | 398.89 _(+2.3%)_ |
| Pool + Autoscale         | 2298.10 _(-2.3%)_ | 856.10 _(+1.4%)_ |   443.39 _(-3.2%)_ | 322.95 _(-1.7%)_ |
| Pool + Cache             |   65.14 _(+4.2%)_ | 52.51 _(+35.6%)_ |   53.76 _(+15.4%)_ |  53.80 _(+0.9%)_ |
| Pool + Cache + Autoscale |   54.81 _(-5.4%)_ | 44.26 _(+17.5%)_ | `42.30` _(-12.3%)_ |  49.94 _(-6.8%)_ |

### Load profile: I/O bound

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                 8 |
| :----------------------- | ----------------: | ----------------: | ----------------: | ----------------: |
| Pool                     | 2244.76 _(-0.9%)_ | 1133.24 _(-1.6%)_ |  633.43 _(-1.3%)_ |  428.30 _(-2.3%)_ |
| Pool + Autoscale         | 7913.23 _(+1.8%)_ | 4028.46 _(+3.6%)_ | 1970.49 _(+0.6%)_ | 1056.53 _(+2.2%)_ |
| Pool + Cache             |  67.91 _(+14.3%)_ |   64.46 _(+8.0%)_ | `57.96` _(-5.3%)_ |   64.08 _(+4.4%)_ |
| Pool + Cache + Autoscale |  196.90 _(+5.4%)_ |  112.88 _(-8.1%)_ |   77.69 _(-0.5%)_ |   64.46 _(-1.7%)_ |

### Load profile: Thundering herd

| Pattern \ Pool size      |                 1 |                  2 |                 4 |                 8 |
| :----------------------- | ----------------: | -----------------: | ----------------: | ----------------: |
| Pool                     | 2404.30 _(+2.9%)_ |   887.76 _(+1.7%)_ | 671.22 _(+39.7%)_ | 326.08 _(-15.5%)_ |
| Pool + Autoscale         | 2315.58 _(-1.6%)_ | 1052.11 _(+26.5%)_ |  460.42 _(+2.4%)_ | 285.62 _(-14.9%)_ |
| Pool + Cache             |  32.31 _(+21.0%)_ |   31.90 _(+25.2%)_ |  36.09 _(+47.4%)_ | `22.97` _(-7.8%)_ |
| Pool + Cache + Autoscale |  34.36 _(+15.1%)_ |    25.90 _(-2.0%)_ |   26.61 _(+4.6%)_ |  24.50 _(-35.2%)_ |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size      |                 1 |                2 |                 4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | -----------------: |
| Pool                     | 2546.51 _(+9.9%)_ | 832.42 _(-1.6%)_ |  442.83 _(+0.5%)_ |   409.75 _(+4.0%)_ |
| Pool + Autoscale         | 2321.63 _(+0.1%)_ | 830.10 _(+0.0%)_ |  455.03 _(-1.3%)_ |   318.04 _(-5.8%)_ |
| Pool + Cache             | 2018.17 _(+0.3%)_ | 757.29 _(-0.6%)_ | 551.87 _(+29.8%)_ |  320.75 _(-15.1%)_ |
| Pool + Cache + Autoscale | 2047.36 _(-1.2%)_ | 773.31 _(+0.1%)_ |  438.60 _(+2.5%)_ | `290.75` _(+0.3%)_ |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: |
| Pool                     | 2270.15 _(-1.1%)_ | 818.90 _(-1.5%)_ | 453.76 _(-6.2%)_ |   378.70 _(+2.0%)_ |
| Pool + Autoscale         | 2386.05 _(+3.2%)_ | 833.23 _(-0.4%)_ | 442.09 _(+1.0%)_ |   321.93 _(+2.9%)_ |
| Pool + Cache             |  933.32 _(-1.0%)_ | 459.55 _(-9.8%)_ | 263.71 _(-4.0%)_ |   234.06 _(+2.2%)_ |
| Pool + Cache + Autoscale |  942.80 _(-3.4%)_ | 466.29 _(-0.7%)_ | 253.78 _(-5.4%)_ | `204.36` _(+2.9%)_ |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                 8 |
| :----------------------- | ----------------: | ----------------: | ----------------: | ----------------: |
| Pool                     | 2279.74 _(-1.6%)_ |  840.31 _(+0.6%)_ | 447.75 _(-11.0%)_ |  360.43 _(-8.8%)_ |
| Pool + Autoscale         | 2295.53 _(-0.8%)_ |  848.30 _(-3.6%)_ |  465.84 _(-0.4%)_ |  323.25 _(+4.2%)_ |
| Pool + Cache             |  270.91 _(-2.1%)_ |  141.69 _(-0.9%)_ |  102.73 _(+8.5%)_ |   99.49 _(-6.8%)_ |
| Pool + Cache + Autoscale |  264.62 _(-3.5%)_ | 145.43 _(-10.1%)_ |  98.92 _(-18.1%)_ | `88.07` _(+6.2%)_ |

## Cache benchmark

- Miss total: 2.61 ms
- Hit total (5 reps): 1.31 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 2.44 ms
- Hit pass under eviction: 0.18 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 11.32 ms
- Concurrent (dedup): 1.46 ms (87.1% faster)

- Cache getOrSetAsync dedupe total: 15.85 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10

## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 31.39 ms
- Warm-start total: 0.28 ms

- PowerMemoizer total: 16.26 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10

## Helper micro-benchmarks

_100,000 ops per variant, median of 9 runs_

| Helper                 | Variant                               | Total (ms) |    ops/sec |  Δ prev |
| :--------------------- | :------------------------------------ | ---------: | ---------: | ------: |
| **PowerRateLimit**     | under rate (all pass)                 |      13.57 |  7,368,309 |   -8.7% |
| **PowerRateLimit**     | over rate (~50% reject)               |      13.71 |  7,296,348 |   -3.8% |
| **PowerCircuit**       | closed (happy path)                   |       2.95 |  6,783,368 |  +31.2% |
| **PowerCircuit**       | open (fast-fail)                      |      61.19 |    326,873 |  +13.0% |
| **PowerRetry**         | 1 attempt (no retry)                  |       5.00 |  1,998,510 |   +1.0% |
| **PowerRetry**         | 2 attempts (1 retry, baseDelay=0)     |   10858.32 |        921 |   +0.3% |
| **PowerSemaphore**     | limit=1 (exclusive lock, serial)      |      26.11 |  1,915,071 | +164.4% |
| **PowerSemaphore**     | limit=8 (concurrent pool)             |      47.93 |  1,043,135 |  +40.3% |
| **PowerBulkhead**      | 1 partition (baseline)                |      33.61 |    595,106 |  +29.3% |
| **PowerBulkhead**      | 2 partitions (critical vs background) |      34.42 |    581,029 |  +32.3% |
| **PowerBatch**         | individual dispatch (maxSize=1)       |      43.05 |  2,322,634 |   +0.1% |
| **PowerBatch**         | coalesced dispatch (maxSize=ops)      |       9.94 | 10,064,357 |   -0.6% |
| **PowerBackpressure**  | no pressure (capacity >> ops)         |      12.12 |  2,475,135 | +417.8% |
| **PowerBackpressure**  | with pressure (capacity=100)          |      17.93 |  1,673,337 |  +64.2% |
| **PowerTTLMap**        | long TTL (60 s, no eviction)          |      21.19 |  4,719,819 |   +2.2% |
| **PowerTTLMap**        | short TTL (1 ms, high eviction)       |      21.03 |  4,754,673 |   -2.6% |
| **PowerEventBus**      | 1 subscriber                          |       6.18 | 16,182,859 |   -2.3% |
| **PowerEventBus**      | 10 subscribers                        |      12.96 |  7,717,561 |   +4.0% |
| **PowerEventBus**      | 50 subscribers                        |      41.40 |  2,415,191 |   -1.1% |
| **PowerEventBus**      | 100 subscribers                       |      76.89 |  1,300,622 |   -1.5% |
| **PowerDeadline**      | success (task within deadline)        |      13.88 |    360,242 |   -2.1% |
| **PowerDeadline**      | abort (task exceeds 1 ms deadline)    |    5626.35 |        889 |   +2.9% |
| **PowerSlidingWindow** | under capacity (all pass)             |       9.68 | 10,329,793 |   -5.0% |
| **PowerSlidingWindow** | at capacity (~50% reject)             |       8.91 | 11,226,933 |   -2.4% |
| **PowerQueue**         | push x100000 + shift x100000          |       3.98 | 25,129,385 |   -2.7% |
| **PowerQueue**         | interleaved push+shift (steady state) |       1.79 | 55,910,588 |   +2.9% |
| **PowerCache**         | get x100000 (all hits)                |      12.47 |  8,019,076 |   -2.8% |
| **PowerCache**         | set x100000 (all misses)              |      25.51 |  3,920,419 |   +3.2% |
| **PowerThrottle**      | tryConsume x100000 (all granted)      |       4.97 | 20,113,197 |   -2.6% |

## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

### Regressions

| Key                                                         | prev (ms) | current (ms) |           Δ |
| :---------------------------------------------------------- | --------: | -----------: | ----------: |
| helpers/PowerBackpressure/no pressure (capacity >> ops)     |      2.34 |        12.12 | **+417.8%** |
| helpers/PowerSemaphore/limit=1 (exclusive lock, serial)     |      9.87 |        26.11 | **+164.4%** |
| helpers/PowerSemaphore/limit=8 (concurrent pool)            |     34.15 |        47.93 |  **+40.3%** |
| scenarios/Thundering herd/pool/4                            |    480.45 |       671.22 |  **+39.7%** |
| helpers/PowerBulkhead/2 partitions (critical vs background) |     26.03 |        34.42 |  **+32.3%** |
