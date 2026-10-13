# Benchmark Results

Generated: 2026-10-13T17:02:07.580Z

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
- Noise floor: **27.43%** median min/max spread across 25 timed variants (p95 165.17%, max 179.99% at `noPresMs`)
  - Any claimed delta smaller than this is **not measurable at this sample count** — raise `BENCH_RUNS` before believing it.

Learn more about the benchmarks [here](README.md)

## Synthetic scenario benchmarks

### Load profile: 0% variable

- Single-threaded total: 2340.79 ms | throughput: 427 tasks/s | p50: 2.27 ms | p95: 2.84 ms | p99: 3.02 ms
- Worker-thread total: 3883.29 ms

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                8 | Speedup |
| :----------------------- | ----------------: | ----------------: | ----------------: | ---------------: | ------: |
| Pool                     | 3337.39 _(+3.1%)_ | 1282.13 _(+0.7%)_ |  653.52 _(+0.6%)_ | 406.15 _(+7.5%)_ |   5.76x |
| Pool + Autoscale         | 3533.46 _(+0.3%)_ | 1290.00 _(-0.1%)_ | 614.78 _(+26.8%)_ | 325.79 _(-0.5%)_ |   7.18x |
| Pool + Cache             |   55.02 _(+1.1%)_ |   44.13 _(+2.8%)_ | `41.58` _(-3.1%)_ | 55.45 _(+11.9%)_ |  56.30x |
| Pool + Cache + Autoscale |   55.92 _(+0.0%)_ |   44.59 _(+1.3%)_ |   46.77 _(-4.8%)_ | 48.11 _(-10.3%)_ |  52.49x |

### Load profile: 25% variable

- Single-threaded total: 1405.18 ms | throughput: 712 tasks/s | p50: 1.40 ms | p95: 2.00 ms | p99: 2.66 ms
- Worker-thread total: 2034.10 ms

| Pattern \ Pool size      |                 1 |                2 |                 4 |                   8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ----------------: | ------------------: | ------: |
| Pool                     | 2032.07 _(+0.5%)_ | 757.44 _(+0.5%)_ |  428.47 _(+9.6%)_ |    366.11 _(+4.5%)_ |   3.84x |
| Pool + Autoscale         | 2089.58 _(-0.7%)_ | 761.91 _(+1.9%)_ |  427.00 _(+5.9%)_ |    289.51 _(-0.3%)_ |   4.85x |
| Pool + Cache             |  457.27 _(+4.1%)_ | 238.58 _(+4.3%)_ | 241.94 _(+55.0%)_ |    154.70 _(+7.7%)_ |   9.08x |
| Pool + Cache + Autoscale |  454.25 _(+3.6%)_ | 239.72 _(+0.2%)_ |  146.45 _(+3.6%)_ | `104.12` _(-10.1%)_ |  13.50x |

### Load profile: 50% variable

- Single-threaded total: 1547.91 ms | throughput: 646 tasks/s | p50: 1.54 ms | p95: 2.16 ms | p99: 2.47 ms
- Worker-thread total: 2393.94 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: | ------: |
| Pool                     | 2323.10 _(+4.1%)_ | 839.76 _(+2.4%)_ | 476.09 _(+6.4%)_ |   356.77 _(+2.2%)_ |   4.34x |
| Pool + Autoscale         | 2301.51 _(-2.2%)_ | 834.07 _(+2.6%)_ | 445.62 _(+0.1%)_ |   316.57 _(-1.2%)_ |   4.89x |
| Pool + Cache             |  888.70 _(+5.8%)_ | 449.10 _(+3.4%)_ | 245.93 _(-2.0%)_ |   225.71 _(+7.6%)_ |   6.86x |
| Pool + Cache + Autoscale |  870.92 _(-0.1%)_ | 437.82 _(-0.0%)_ | 255.63 _(+1.4%)_ | `171.98` _(-8.9%)_ |   9.00x |

### Load profile: 75% variable

- Single-threaded total: 2000.34 ms | throughput: 500 tasks/s | p50: 1.76 ms | p95: 3.73 ms | p99: 4.32 ms
- Worker-thread total: 2364.24 ms

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: | ------: |
| Pool                     | 2326.06 _(+0.8%)_ | 853.58 _(+3.5%)_ | 465.37 _(+3.1%)_ |   385.09 _(+3.7%)_ |   5.19x |
| Pool + Autoscale         | 2342.67 _(+1.2%)_ | 854.76 _(+1.9%)_ | 468.51 _(+4.7%)_ |   306.41 _(-5.0%)_ |   6.53x |
| Pool + Cache             | 1617.17 _(+0.8%)_ | 688.32 _(+5.0%)_ | 367.71 _(+3.9%)_ |  336.87 _(+13.3%)_ |   5.94x |
| Pool + Cache + Autoscale | 1626.19 _(-2.5%)_ | 671.92 _(+4.2%)_ | 361.21 _(+0.6%)_ | `227.65` _(-3.0%)_ |   8.79x |

### Load profile: 100% variable

- Single-threaded total: 1606.90 ms | throughput: 622 tasks/s | p50: 1.60 ms | p95: 2.29 ms | p99: 2.66 ms
- Worker-thread total: 2397.75 ms

| Pattern \ Pool size      |                 1 |                2 |                 4 |                  8 | Speedup |
| :----------------------- | ----------------: | ---------------: | ----------------: | -----------------: | ------: |
| Pool                     | 2366.93 _(+3.0%)_ | 879.67 _(+4.6%)_ | 539.18 _(+16.2%)_ |   424.68 _(+3.0%)_ |   3.78x |
| Pool + Autoscale         | 2352.63 _(+2.2%)_ | 867.96 _(+4.1%)_ |  460.55 _(-7.5%)_ |  320.73 _(+10.1%)_ |   5.01x |
| Pool + Cache             | 2378.95 _(+1.5%)_ | 851.43 _(+2.2%)_ |  500.24 _(+5.5%)_ |  415.59 _(+24.1%)_ |   3.87x |
| Pool + Cache + Autoscale | 2402.21 _(+0.9%)_ | 884.16 _(+2.7%)_ |  472.70 _(+1.6%)_ | `284.17` _(-1.8%)_ |   5.65x |

## Realistic scenario benchmarks

### Load profile: Burstiness

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                 8 |
| :----------------------- | ----------------: | ----------------: | ----------------: | ----------------: |
| Pool                     | 2331.55 _(+1.1%)_ |  877.35 _(-0.2%)_ | 457.93 _(-10.5%)_ | 373.66 _(+13.5%)_ |
| Pool + Autoscale         | 2454.43 _(-1.5%)_ |  881.23 _(-3.8%)_ | 453.44 _(-10.0%)_ |  311.44 _(+2.0%)_ |
| Pool + Cache             |  67.96 _(+24.6%)_ | `50.05` _(-3.4%)_ |   50.99 _(-1.8%)_ |  57.22 _(+15.0%)_ |
| Pool + Cache + Autoscale |  70.04 _(+26.6%)_ |  50.60 _(-31.6%)_ |  61.49 _(+21.1%)_ |   54.77 _(+9.5%)_ |

### Load profile: Mixed task sizes

| Pattern \ Pool size      |                 1 |                 2 |                4 |                8 |
| :----------------------- | ----------------: | ----------------: | ---------------: | ---------------: |
| Pool                     | 2494.57 _(+2.0%)_ |  917.18 _(+3.4%)_ | 483.67 _(-0.7%)_ | 441.75 _(+8.3%)_ |
| Pool + Autoscale         | 2551.53 _(+3.2%)_ |  867.04 _(-5.1%)_ | 456.89 _(-7.8%)_ | 338.01 _(+3.4%)_ |
| Pool + Cache             |  56.44 _(-11.6%)_ |  68.06 _(+46.2%)_ | 51.95 _(+15.0%)_ | 61.18 _(+14.9%)_ |
| Pool + Cache + Autoscale |   61.90 _(-0.0%)_ | `44.77` _(+5.4%)_ | 51.25 _(+27.2%)_ |  61.45 _(+5.8%)_ |

### Load profile: Ramp traffic

| Pattern \ Pool size      |                 1 |                2 |                  4 |                8 |
| :----------------------- | ----------------: | ---------------: | -----------------: | ---------------: |
| Pool                     | 2326.08 _(+1.6%)_ | 863.31 _(+0.9%)_ |   480.43 _(+4.7%)_ | 355.61 _(-1.1%)_ |
| Pool + Autoscale         | 2355.12 _(-0.3%)_ | 866.68 _(-1.4%)_ |   462.65 _(+2.5%)_ | 337.41 _(+0.8%)_ |
| Pool + Cache             |  106.68 _(+0.3%)_ | 105.92 _(-0.9%)_ | `104.89` _(-1.1%)_ | 107.42 _(+1.1%)_ |
| Pool + Cache + Autoscale |  106.12 _(+1.2%)_ | 105.70 _(+0.6%)_ |   106.11 _(+0.9%)_ | 105.29 _(-1.5%)_ |

### Load profile: Variable payload sizes

| Pattern \ Pool size      |                 1 |                  2 |                4 |                 8 |
| :----------------------- | ----------------: | -----------------: | ---------------: | ----------------: |
| Pool                     | 2448.45 _(+1.1%)_ |   854.92 _(+2.2%)_ | 479.45 _(+2.5%)_ | 404.64 _(+10.6%)_ |
| Pool + Autoscale         | 2376.52 _(+1.9%)_ |   855.99 _(+1.6%)_ | 480.18 _(+4.4%)_ |  333.65 _(+3.9%)_ |
| Pool + Cache             |  65.12 _(+12.0%)_ |   39.77 _(-17.6%)_ | 40.15 _(-12.9%)_ |  58.21 _(+13.6%)_ |
| Pool + Cache + Autoscale |  64.11 _(+11.2%)_ | `39.05` _(-10.6%)_ | 48.77 _(+19.6%)_ |   59.87 _(+7.1%)_ |

### Load profile: I/O bound

| Pattern \ Pool size      |                 1 |                  2 |                 4 |                 8 |
| :----------------------- | ----------------: | -----------------: | ----------------: | ----------------: |
| Pool                     | 2321.16 _(+2.0%)_ |  1093.82 _(-6.8%)_ | 695.57 _(+13.7%)_ | 385.67 _(-11.0%)_ |
| Pool + Autoscale         | 7780.60 _(-5.5%)_ |  3920.38 _(-4.8%)_ | 1874.08 _(-7.3%)_ | 935.31 _(-11.0%)_ |
| Pool + Cache             |  64.78 _(+10.1%)_ | `44.01` _(-30.9%)_ |  69.29 _(+20.8%)_ |  68.56 _(+16.7%)_ |
| Pool + Cache + Autoscale | 186.04 _(-11.2%)_ |   111.34 _(-0.6%)_ |   70.86 _(-8.8%)_ |   63.40 _(-5.4%)_ |

### Load profile: Thundering herd

| Pattern \ Pool size      |                 1 |                2 |                 4 |                 8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | ----------------: |
| Pool                     | 2323.01 _(+1.0%)_ | 868.32 _(+4.9%)_ | 524.26 _(+14.5%)_ | 413.24 _(+14.6%)_ |
| Pool + Autoscale         | 2384.83 _(+0.1%)_ | 849.68 _(+1.4%)_ |  455.25 _(-0.2%)_ |  320.16 _(+1.9%)_ |
| Pool + Cache             |  46.61 _(+54.4%)_ | 27.92 _(-12.8%)_ |  37.01 _(+17.6%)_ |   38.47 _(+5.6%)_ |
| Pool + Cache + Autoscale |  27.36 _(+13.9%)_ |  26.77 _(+2.6%)_ | `24.66` _(+6.7%)_ |   34.99 _(-1.0%)_ |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size      |                 1 |                2 |                4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ---------------: | -----------------: |
| Pool                     | 2367.67 _(+2.8%)_ | 863.02 _(+4.5%)_ | 509.99 _(+9.1%)_ |   375.92 _(+0.2%)_ |
| Pool + Autoscale         | 2381.22 _(+2.8%)_ | 843.77 _(+0.9%)_ | 453.65 _(+3.4%)_ |   313.50 _(-1.7%)_ |
| Pool + Cache             | 2056.13 _(+1.3%)_ | 767.41 _(+2.3%)_ | 404.74 _(-0.2%)_ |  391.69 _(+19.7%)_ |
| Pool + Cache + Autoscale | 2117.57 _(-1.3%)_ | 817.98 _(+8.2%)_ | 414.06 _(+2.1%)_ | `302.07` _(+2.0%)_ |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size      |                 1 |                2 |                 4 |                  8 |
| :----------------------- | ----------------: | ---------------: | ----------------: | -----------------: |
| Pool                     | 2449.33 _(+7.2%)_ | 874.99 _(+6.1%)_ |  464.82 _(+3.9%)_ |   384.36 _(-3.3%)_ |
| Pool + Autoscale         | 2353.14 _(+0.6%)_ | 868.64 _(+3.7%)_ | 512.22 _(+15.2%)_ |   319.49 _(-0.4%)_ |
| Pool + Cache             |  973.34 _(+4.2%)_ | 491.57 _(+5.5%)_ |  292.29 _(-5.9%)_ |  273.73 _(+24.3%)_ |
| Pool + Cache + Autoscale |  975.27 _(+3.0%)_ | 491.59 _(+4.3%)_ |  268.18 _(-5.0%)_ | `194.60` _(+2.8%)_ |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size      |                 1 |                 2 |                 4 |                 8 |
| :----------------------- | ----------------: | ----------------: | ----------------: | ----------------: |
| Pool                     | 2375.34 _(+3.1%)_ |  863.46 _(+2.2%)_ |  469.55 _(-3.3%)_ |  390.55 _(+9.6%)_ |
| Pool + Autoscale         | 2429.90 _(+5.7%)_ |  843.07 _(+2.1%)_ |  444.65 _(-6.4%)_ |  321.37 _(-0.8%)_ |
| Pool + Cache             | 295.42 _(+12.6%)_ | 188.54 _(+21.9%)_ | 104.37 _(+17.8%)_ |  105.92 _(+7.8%)_ |
| Pool + Cache + Autoscale |  297.70 _(+9.4%)_ |  158.93 _(+6.1%)_ | `95.22` _(-3.6%)_ | 107.10 _(+36.9%)_ |

## Cache benchmark

- Miss total: 2.36 ms
- Hit total (5 reps): 1.13 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 2.42 ms
- Hit pass under eviction: 0.22 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 11.21 ms
- Concurrent (dedup): 1.40 ms (87.5% faster)

- Cache getOrSetAsync dedupe total: 15.71 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10

## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 32.72 ms
- Warm-start total: 0.24 ms

- PowerMemoizer total: 16.20 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10

## Helper micro-benchmarks

_100,000 ops per variant, median of 9 runs_

| Helper                 | Variant                               | Total (ms) |    ops/sec |  Δ prev |
| :--------------------- | :------------------------------------ | ---------: | ---------: | ------: |
| **PowerRateLimit**     | under rate (all pass)                 |      14.32 |  6,983,560 |   +8.2% |
| **PowerRateLimit**     | over rate (~50% reject)               |      14.22 |  7,030,695 |   +1.3% |
| **PowerCircuit**       | closed (happy path)                   |       1.96 | 10,225,508 |   +6.0% |
| **PowerCircuit**       | open (fast-fail)                      |      51.94 |    385,052 |   -1.5% |
| **PowerRetry**         | 1 attempt (no retry)                  |       5.29 |  1,889,834 |   +4.6% |
| **PowerRetry**         | 2 attempts (1 retry, baseDelay=0)     |   10776.23 |        928 |   -1.2% |
| **PowerSemaphore**     | limit=1 (exclusive lock, serial)      |      10.63 |  4,704,065 |   +1.0% |
| **PowerSemaphore**     | limit=8 (concurrent pool)             |      35.91 |  1,392,280 |   +3.6% |
| **PowerBulkhead**      | 1 partition (baseline)                |      27.06 |    739,159 |   +5.0% |
| **PowerBulkhead**      | 2 partitions (critical vs background) |      26.95 |    741,983 |   +5.0% |
| **PowerBatch**         | individual dispatch (maxSize=1)       |      45.59 |  2,193,243 |   +4.9% |
| **PowerBatch**         | coalesced dispatch (maxSize=ops)      |       9.97 | 10,031,799 |   -5.6% |
| **PowerBackpressure**  | no pressure (capacity >> ops)         |       2.66 | 11,284,631 |   +6.6% |
| **PowerBackpressure**  | with pressure (capacity=100)          |       9.90 |  3,031,136 |   +2.0% |
| **PowerTTLMap**        | long TTL (60 s, no eviction)          |      20.59 |  4,856,535 |   +0.9% |
| **PowerTTLMap**        | short TTL (1 ms, high eviction)       |      21.04 |  4,752,886 |   +2.3% |
| **PowerEventBus**      | 1 subscriber                          |       6.22 | 16,077,424 |   -1.5% |
| **PowerEventBus**      | 10 subscribers                        |      13.82 |  7,235,498 |   +6.7% |
| **PowerEventBus**      | 50 subscribers                        |      42.63 |  2,345,613 |   +3.1% |
| **PowerEventBus**      | 100 subscribers                       |      80.47 |  1,242,733 |   +3.1% |
| **PowerDeadline**      | success (task within deadline)        |      13.52 |    369,761 |   +7.5% |
| **PowerDeadline**      | abort (task exceeds 1 ms deadline)    |    5410.41 |        924 |   -0.1% |
| **PowerSlidingWindow** | under capacity (all pass)             |       9.86 | 10,146,928 |  -14.6% |
| **PowerSlidingWindow** | at capacity (~50% reject)             |      13.12 |  7,619,059 |  +27.4% |
| **PowerQueue**         | push x100000 + shift x100000          |       3.12 | 32,042,132 |   -6.6% |
| **PowerQueue**         | interleaved push+shift (steady state) |       2.05 | 48,762,148 | +259.3% |
| **PowerCache**         | get x100000 (all hits)                |      12.84 |  7,786,451 |   +1.6% |
| **PowerCache**         | set x100000 (all misses)              |      25.43 |  3,932,188 |   +4.4% |
| **PowerThrottle**      | tryConsume x100000 (all granted)      |       5.21 | 19,210,760 |   +3.3% |

## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

### Regressions

| Key                                   | prev (ms) | current (ms) |          Δ |
| :------------------------------------ | --------: | -----------: | ---------: |
| profiles/25% variable/optimizedPool/4 |    156.12 |       241.94 | **+55.0%** |
