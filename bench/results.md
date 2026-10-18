# Benchmark Results

Generated: 2026-10-18T16:59:39.236Z

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
- Noise floor: **15.69%** median min/max spread across 25 timed variants (p95 116.84%, max 211.28% at `noPresMs`)
  - Any claimed delta smaller than this is **not measurable at this sample count** — raise `BENCH_RUNS` before believing it.

Learn more about the benchmarks [here](README.md)

## Synthetic scenario benchmarks

### Load profile: 0% variable

- Single-threaded total: 1665.33 ms | throughput: 600 tasks/s | p50: 1.54 ms | p95: 3.18 ms | p99: 3.34 ms
- Worker-thread total: 2306.43 ms

| Pattern \ Pool size      |                  1 |                  2 |                 4 |                8 | Speedup |
| :----------------------- | -----------------: | -----------------: | ----------------: | ---------------: | ------: |
| Pool                     | 2350.81 _(-29.6%)_ |  854.19 _(-33.4%)_ | 460.66 _(-29.5%)_ | 396.08 _(-2.5%)_ |   4.20x |
| Pool + Autoscale         | 2387.71 _(-32.4%)_ |  856.61 _(-33.6%)_ | 458.25 _(-25.5%)_ | 328.77 _(+0.9%)_ |   5.07x |
| Pool + Cache             |   42.25 _(-23.2%)_ | `33.34` _(-24.5%)_ |   37.74 _(-9.2%)_ |  52.78 _(-4.8%)_ |  49.95x |
| Pool + Cache + Autoscale |   44.73 _(-20.0%)_ |    40.27 _(-9.7%)_ |  40.35 _(-13.7%)_ | 55.26 _(+14.9%)_ |  41.35x |

### Load profile: 25% variable

- Single-threaded total: 1366.64 ms | throughput: 732 tasks/s | p50: 1.32 ms | p95: 1.91 ms | p99: 2.29 ms
- Worker-thread total: 2040.17 ms

| Pattern \ Pool size      |                 1 |                2 |                 4 |                   8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ----------------: | ------------------: | ------: |
| Pool                     | 2055.40 _(+1.1%)_ | 746.33 _(-1.5%)_ |  394.53 _(-7.9%)_ |    337.33 _(-7.9%)_ |   4.05x |
| Pool + Autoscale         | 2075.01 _(-0.7%)_ | 742.05 _(-2.6%)_ |  400.03 _(-6.3%)_ |    287.01 _(-0.9%)_ |   4.76x |
| Pool + Cache             |  447.00 _(-2.2%)_ | 239.23 _(+0.3%)_ | 156.18 _(-35.4%)_ |    154.39 _(-0.2%)_ |   8.85x |
| Pool + Cache + Autoscale |  451.44 _(-0.6%)_ | 239.30 _(-0.2%)_ |  151.95 _(+3.8%)_ | `114.97` _(+10.4%)_ |  11.89x |

### Load profile: 50% variable

- Single-threaded total: 1544.10 ms | throughput: 648 tasks/s | p50: 1.53 ms | p95: 2.18 ms | p99: 2.57 ms
- Worker-thread total: 2252.79 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: | ------: |
| Pool                     | 2243.55 _(-3.4%)_ | 821.76 _(-2.1%)_ | 440.49 _(-7.5%)_ |   359.50 _(+0.8%)_ |   4.30x |
| Pool + Autoscale         | 2290.05 _(-0.5%)_ | 815.11 _(-2.3%)_ | 440.79 _(-1.1%)_ |   316.12 _(-0.1%)_ |   4.88x |
| Pool + Cache             |  842.80 _(-5.2%)_ | 435.11 _(-3.1%)_ | 254.74 _(+3.6%)_ |   227.30 _(+0.7%)_ |   6.79x |
| Pool + Cache + Autoscale |  842.13 _(-3.3%)_ | 448.18 _(+2.4%)_ | 245.89 _(-3.8%)_ | `167.02` _(-2.9%)_ |   9.25x |

### Load profile: 75% variable

- Single-threaded total: 1992.23 ms | throughput: 502 tasks/s | p50: 1.77 ms | p95: 3.68 ms | p99: 4.25 ms
- Worker-thread total: 2290.51 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: | ------: |
| Pool                     | 2284.94 _(-1.8%)_ | 842.16 _(-1.3%)_ | 436.03 _(-6.3%)_ |   362.33 _(-5.9%)_ |   5.50x |
| Pool + Autoscale         | 2310.97 _(-1.4%)_ | 832.51 _(-2.6%)_ | 459.35 _(-2.0%)_ |   328.15 _(+7.1%)_ |   6.07x |
| Pool + Cache             | 1598.84 _(-1.1%)_ | 641.16 _(-6.9%)_ | 362.76 _(-1.3%)_ |   312.67 _(-7.2%)_ |   6.37x |
| Pool + Cache + Autoscale | 1623.99 _(-0.1%)_ | 643.51 _(-4.2%)_ | 360.43 _(-0.2%)_ | `225.31` _(-1.0%)_ |   8.84x |

### Load profile: 100% variable

- Single-threaded total: 1576.93 ms | throughput: 634 tasks/s | p50: 1.58 ms | p95: 2.28 ms | p99: 2.51 ms
- Worker-thread total: 2296.63 ms

| Pattern \ Pool size      |                 1 |                2 |                 4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ----------------: | -----------------: | ------: |
| Pool                     | 2288.41 _(-3.3%)_ | 846.84 _(-3.7%)_ | 466.57 _(-13.5%)_ |  375.37 _(-11.6%)_ |   4.20x |
| Pool + Autoscale         | 2337.02 _(-0.7%)_ | 837.88 _(-3.5%)_ |  459.51 _(-0.2%)_ |   323.82 _(+1.0%)_ |   4.87x |
| Pool + Cache             | 2303.32 _(-3.2%)_ | 836.80 _(-1.7%)_ |  462.67 _(-7.5%)_ |   393.26 _(-5.4%)_ |   4.01x |
| Pool + Cache + Autoscale | 2337.20 _(-2.7%)_ | 836.69 _(-5.4%)_ |  465.57 _(-1.5%)_ | `288.44` _(+1.5%)_ |   5.47x |

## Realistic scenario benchmarks

### Load profile: Burstiness

| Pattern \ Pool size      |                 1 |                2 |                 4 |                8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | ---------------: |
| Pool                     | 2374.10 _(+1.8%)_ | 823.54 _(-6.1%)_ |  451.01 _(-1.5%)_ | 399.52 _(+6.9%)_ |
| Pool + Autoscale         | 2337.47 _(-4.8%)_ | 862.22 _(-2.2%)_ |  456.65 _(+0.7%)_ | 310.31 _(-0.4%)_ |
| Pool + Cache             |   62.48 _(-8.1%)_ |  50.69 _(+1.3%)_ | `49.79` _(-2.4%)_ |  57.95 _(+1.3%)_ |
| Pool + Cache + Autoscale |  60.87 _(-13.1%)_ |  50.80 _(+0.4%)_ |  50.95 _(-17.1%)_ |  54.56 _(-0.4%)_ |

### Load profile: Mixed task sizes

| Pattern \ Pool size      |                 1 |                2 |                  4 |                8 |
| :----------------------- | ----------------: | ---------------: | -----------------: | ---------------: |
| Pool                     | 2392.90 _(-4.1%)_ | 882.13 _(-3.8%)_ |   474.57 _(-1.9%)_ | 403.87 _(-8.6%)_ |
| Pool + Autoscale         | 2465.29 _(-3.4%)_ | 863.46 _(-0.4%)_ |   465.24 _(+1.8%)_ | 331.95 _(-1.8%)_ |
| Pool + Cache             |   58.82 _(+4.2%)_ | 46.53 _(-31.6%)_ |    55.08 _(+6.0%)_ | 50.55 _(-17.4%)_ |
| Pool + Cache + Autoscale |   60.71 _(-1.9%)_ | 78.09 _(+74.4%)_ | `43.58` _(-15.0%)_ |  55.74 _(-9.3%)_ |

### Load profile: Ramp traffic

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: |
| Pool                     | 2301.06 _(-1.1%)_ | 852.35 _(-1.3%)_ | 449.06 _(-6.5%)_ |  407.12 _(+14.5%)_ |
| Pool + Autoscale         | 2377.06 _(+0.9%)_ | 832.59 _(-3.9%)_ | 462.25 _(-0.1%)_ |   322.84 _(-4.3%)_ |
| Pool + Cache             |  106.30 _(-0.4%)_ | 105.51 _(-0.4%)_ | 107.10 _(+2.1%)_ |   106.71 _(-0.7%)_ |
| Pool + Cache + Autoscale |  106.84 _(+0.7%)_ | 105.84 _(+0.1%)_ | 107.44 _(+1.3%)_ | `105.36` _(+0.1%)_ |

### Load profile: Variable payload sizes

| Pattern \ Pool size      |                 1 |                 2 |                4 |                8 |
| :----------------------- | ----------------: | ----------------: | ---------------: | ---------------: |
| Pool                     | 2321.59 _(-5.2%)_ |  862.29 _(+0.9%)_ | 449.59 _(-6.2%)_ | 389.99 _(-3.6%)_ |
| Pool + Autoscale         | 2352.35 _(-1.0%)_ |  844.46 _(-1.3%)_ | 458.21 _(-4.6%)_ | 328.38 _(-1.6%)_ |
| Pool + Cache             |   62.52 _(-4.0%)_ |   38.71 _(-2.7%)_ | 46.59 _(+16.1%)_ |  53.31 _(-8.4%)_ |
| Pool + Cache + Autoscale |   57.92 _(-9.7%)_ | `37.68` _(-3.5%)_ |  48.23 _(-1.1%)_ | 53.61 _(-10.5%)_ |

### Load profile: I/O bound

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                  8 |
| :----------------------- | ----------------: | ----------------: | ----------------: | -----------------: |
| Pool                     | 2264.90 _(-2.4%)_ | 1151.79 _(+5.3%)_ |  641.76 _(-7.7%)_ |  438.35 _(+13.7%)_ |
| Pool + Autoscale         | 7776.10 _(-0.1%)_ | 3888.18 _(-0.8%)_ | 1959.34 _(+4.5%)_ | 1033.97 _(+10.5%)_ |
| Pool + Cache             | `59.43` _(-8.3%)_ |  59.67 _(+35.6%)_ |  61.23 _(-11.6%)_ |   61.36 _(-10.5%)_ |
| Pool + Cache + Autoscale |  186.75 _(+0.4%)_ | 122.85 _(+10.3%)_ |  78.09 _(+10.2%)_ |    65.54 _(+3.4%)_ |

### Load profile: Thundering herd

| Pattern \ Pool size      |                 1 |                2 |                  4 |                8 |
| :----------------------- | ----------------: | ---------------: | -----------------: | ---------------: |
| Pool                     | 2336.96 _(+0.6%)_ | 872.59 _(+0.5%)_ |   480.45 _(-8.4%)_ | 386.08 _(-6.6%)_ |
| Pool + Autoscale         | 2352.73 _(-1.3%)_ | 832.01 _(-2.1%)_ |   449.55 _(-1.3%)_ | 335.55 _(+4.8%)_ |
| Pool + Cache             |  26.70 _(-42.7%)_ |  25.48 _(-8.8%)_ | `24.48` _(-33.9%)_ | 24.91 _(-35.3%)_ |
| Pool + Cache + Autoscale |   29.84 _(+9.1%)_ |  26.43 _(-1.3%)_ |    25.44 _(+3.2%)_ |  37.80 _(+8.0%)_ |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size      |                 1 |                2 |                 4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | -----------------: |
| Pool                     | 2316.68 _(-2.2%)_ | 845.72 _(-2.0%)_ | 440.59 _(-13.6%)_ |   394.16 _(+4.8%)_ |
| Pool + Autoscale         | 2319.32 _(-2.6%)_ | 829.98 _(-1.6%)_ |  461.13 _(+1.6%)_ |   337.75 _(+7.7%)_ |
| Pool + Cache             | 2011.85 _(-2.2%)_ | 761.77 _(-0.7%)_ |  425.31 _(+5.1%)_ |   377.62 _(-3.6%)_ |
| Pool + Cache + Autoscale | 2073.14 _(-2.1%)_ | 772.45 _(-5.6%)_ |  428.00 _(+3.4%)_ | `289.80` _(-4.1%)_ |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size      |                 1 |                2 |                 4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | -----------------: |
| Pool                     | 2296.05 _(-6.3%)_ | 831.55 _(-5.0%)_ |  483.72 _(+4.1%)_ |   371.22 _(-3.4%)_ |
| Pool + Autoscale         | 2311.90 _(-1.8%)_ | 836.68 _(-3.7%)_ | 437.81 _(-14.5%)_ |   312.73 _(-2.1%)_ |
| Pool + Cache             |  942.35 _(-3.2%)_ | 509.47 _(+3.6%)_ |  274.71 _(-6.0%)_ |  228.95 _(-16.4%)_ |
| Pool + Cache + Autoscale |  975.77 _(+0.1%)_ | 469.77 _(-4.4%)_ |  268.15 _(-0.0%)_ | `198.64` _(+2.1%)_ |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                  8 |
| :----------------------- | ----------------: | ----------------: | ----------------: | -----------------: |
| Pool                     | 2316.65 _(-2.5%)_ |  835.02 _(-3.3%)_ |  503.13 _(+7.2%)_ |   395.07 _(+1.2%)_ |
| Pool + Autoscale         | 2313.56 _(-4.8%)_ |  880.08 _(+4.4%)_ |  467.48 _(+5.1%)_ |   310.25 _(-3.5%)_ |
| Pool + Cache             |  276.59 _(-6.4%)_ | 142.94 _(-24.2%)_ |   94.71 _(-9.3%)_ |   106.75 _(+0.8%)_ |
| Pool + Cache + Autoscale |  274.09 _(-7.9%)_ |  161.80 _(+1.8%)_ | 120.79 _(+26.9%)_ | `82.96` _(-22.5%)_ |

## Cache benchmark

- Miss total: 2.75 ms
- Hit total (5 reps): 1.21 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 2.63 ms
- Hit pass under eviction: 0.19 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 10.33 ms
- Concurrent (dedup): 1.50 ms (85.5% faster)

- Cache getOrSetAsync dedupe total: 15.68 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10

## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 32.60 ms
- Warm-start total: 0.24 ms

- PowerMemoizer total: 16.34 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10

## Helper micro-benchmarks

_100,000 ops per variant, median of 9 runs_

| Helper                 | Variant                               | Total (ms) |    ops/sec | Δ prev |
| :--------------------- | :------------------------------------ | ---------: | ---------: | -----: |
| **PowerRateLimit**     | under rate (all pass)                 |      14.86 |  6,730,670 |  +3.8% |
| **PowerRateLimit**     | over rate (~50% reject)               |      14.25 |  7,018,398 |  +0.2% |
| **PowerCircuit**       | closed (happy path)                   |       2.25 |  8,896,469 | +14.9% |
| **PowerCircuit**       | open (fast-fail)                      |      54.16 |    369,273 |  +4.3% |
| **PowerRetry**         | 1 attempt (no retry)                  |       4.96 |  2,017,622 |  -6.3% |
| **PowerRetry**         | 2 attempts (1 retry, baseDelay=0)     |   10828.10 |        924 |  +0.5% |
| **PowerSemaphore**     | limit=1 (exclusive lock, serial)      |       9.87 |  5,063,517 |  -7.1% |
| **PowerSemaphore**     | limit=8 (concurrent pool)             |      34.15 |  1,463,969 |  -4.9% |
| **PowerBulkhead**      | 1 partition (baseline)                |      25.99 |    769,387 |  -3.9% |
| **PowerBulkhead**      | 2 partitions (critical vs background) |      26.03 |    768,490 |  -3.4% |
| **PowerBatch**         | individual dispatch (maxSize=1)       |      43.01 |  2,324,946 |  -5.7% |
| **PowerBatch**         | coalesced dispatch (maxSize=ops)      |       9.99 | 10,006,892 |  +0.2% |
| **PowerBackpressure**  | no pressure (capacity >> ops)         |       2.34 | 12,817,079 | -12.0% |
| **PowerBackpressure**  | with pressure (capacity=100)          |      10.92 |  2,747,350 | +10.3% |
| **PowerTTLMap**        | long TTL (60 s, no eviction)          |      20.73 |  4,824,756 |  +0.7% |
| **PowerTTLMap**        | short TTL (1 ms, high eviction)       |      21.58 |  4,633,071 |  +2.6% |
| **PowerEventBus**      | 1 subscriber                          |       6.32 | 15,814,032 |  +1.7% |
| **PowerEventBus**      | 10 subscribers                        |      12.46 |  8,028,190 |  -9.9% |
| **PowerEventBus**      | 50 subscribers                        |      41.87 |  2,388,069 |  -1.8% |
| **PowerEventBus**      | 100 subscribers                       |      78.09 |  1,280,555 |  -3.0% |
| **PowerDeadline**      | success (task within deadline)        |      14.18 |    352,542 |  +4.9% |
| **PowerDeadline**      | abort (task exceeds 1 ms deadline)    |    5466.44 |        915 |  +1.0% |
| **PowerSlidingWindow** | under capacity (all pass)             |      10.19 |  9,813,222 |  +3.4% |
| **PowerSlidingWindow** | at capacity (~50% reject)             |       9.13 | 10,953,370 | -30.4% |
| **PowerQueue**         | push x100000 + shift x100000          |       4.09 | 24,441,123 | +31.1% |
| **PowerQueue**         | interleaved push+shift (steady state) |       1.74 | 57,555,845 | -15.3% |
| **PowerCache**         | get x100000 (all hits)                |      12.82 |  7,797,587 |  -0.1% |
| **PowerCache**         | set x100000 (all misses)              |      24.72 |  4,045,152 |  -2.8% |
| **PowerThrottle**      | tryConsume x100000 (all granted)      |       5.10 | 19,598,793 |  -2.0% |

## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

### Improvements

| Key                                   | prev (ms) | current (ms) |      Δ |
| :------------------------------------ | --------: | -----------: | -----: |
| profiles/25% variable/optimizedPool/4 |    241.94 |       156.18 | -35.4% |
