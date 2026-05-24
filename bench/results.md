# Benchmark Results

Generated: 2026-05-24T10:17:53.466Z

## Configuration

- MODE: all
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8
- LOAD_PROFILES: 0% variable, 25% variable, 50% variable, 75% variable, 100% variable
- BENCH_RUNS: 5
- POOL_RUNS: 3
- HELPER_OPS: 100000

Learn more about the benchmarks [here](README.md)


## Synthetic scenario benchmarks


### Load profile: 0% variable
- Single-threaded total: 1556.54 ms | throughput: 642 tasks/s | p50: 1.51 ms | p95: 1.73 ms | p99: 1.80 ms
- Worker-thread total: 2373.79 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2412.47 *(+3.0%)* | 847.38 *(-3.2%)* | 606.93 *(+32.0%)* | 332.19 *(+2.3%)* | 4.69x |
| Pool + Autoscale | 2409.33 *(+0.5%)* | 840.92 *(-2.8%)* | 457.56 *(-0.9%)* | 299.51 *(+1.4%)* | 5.20x |
| Pool + Cache | 52.16 *(+21.6%)* | 45.31 *(+25.0%)* | 45.08 *(+31.1%)* | 44.26 *(+6.8%)* | 35.17x |
| Pool + Cache + Autoscale | 36.80 *(+11.6%)* | 41.97 *(+30.7%)* | `31.15` *(-9.1%)* | 39.07 *(+3.8%)* | 49.97x |

### Load profile: 25% variable
- Single-threaded total: 1526.08 ms | throughput: 655 tasks/s | p50: 1.48 ms | p95: 2.15 ms | p99: 2.59 ms
- Worker-thread total: 2337.10 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2246.98 *(-5.7%)* | 851.21 *(-1.9%)* | 510.95 *(+3.2%)* | 405.20 *(+20.0%)* | 3.77x |
| Pool + Autoscale | 2337.47 *(-2.1%)* | 867.35 *(-0.9%)* | 565.02 *(+18.7%)* | 292.62 *(-4.2%)* | 5.22x |
| Pool + Cache | 444.48 *(+2.3%)* | 265.03 *(+7.5%)* | 198.99 *(+23.0%)* | 151.22 *(+26.2%)* | 10.09x |
| Pool + Cache + Autoscale | 433.06 *(-2.5%)* | 239.28 *(-3.9%)* | 165.41 *(+11.9%)* | `105.41` *(-1.5%)* | 14.48x |

### Load profile: 50% variable
- Single-threaded total: 1612.28 ms | throughput: 620 tasks/s | p50: 1.54 ms | p95: 2.43 ms | p99: 2.67 ms
- Worker-thread total: 2278.63 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2282.03 *(+17.9%)* | 850.29 *(+15.0%)* | 463.29 *(+18.1%)* | 390.05 *(+38.3%)* | 4.13x |
| Pool + Autoscale | 2309.16 *(+15.3%)* | 826.22 *(+15.1%)* | 445.38 *(+15.5%)* | 312.57 *(+28.2%)* | 5.16x |
| Pool + Cache | 812.42 *(+2.5%)* | 422.91 *(+3.2%)* | 341.00 *(+49.3%)* | 219.21 *(+25.8%)* | 7.35x |
| Pool + Cache + Autoscale | 825.96 *(+2.3%)* | 429.78 *(+1.1%)* | 287.14 *(+19.1%)* | `159.00` *(-0.5%)* | 10.14x |

### Load profile: 75% variable
- Single-threaded total: 2005.35 ms | throughput: 499 tasks/s | p50: 1.82 ms | p95: 3.67 ms | p99: 4.19 ms
- Worker-thread total: 2369.50 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2333.88 *(+3.5%)* | 880.26 *(+8.2%)* | 589.68 *(+34.0%)* | 392.07 *(+31.2%)* | 5.11x |
| Pool + Autoscale | 2364.28 *(+2.9%)* | 917.54 *(+13.0%)* | 465.50 *(+2.1%)* | 309.09 *(+12.6%)* | 6.49x |
| Pool + Cache | 1598.53 *(+5.7%)* | 640.16 *(+3.6%)* | 487.87 *(+48.3%)* | 300.78 *(+20.6%)* | 6.67x |
| Pool + Cache + Autoscale | 1620.00 *(+5.7%)* | 715.28 *(+16.0%)* | 356.30 *(+7.2%)* | `218.82` *(+0.4%)* | 9.16x |

### Load profile: 100% variable
- Single-threaded total: 1598.47 ms | throughput: 626 tasks/s | p50: 1.57 ms | p95: 2.41 ms | p99: 3.02 ms
- Worker-thread total: 2250.99 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2255.82 *(+0.6%)* | 818.44 *(-1.2%)* | 449.43 *(+0.2%)* | 362.96 *(+9.0%)* | 4.40x |
| Pool + Autoscale | 2370.93 *(+3.4%)* | 824.49 *(-1.7%)* | 466.45 *(+2.9%)* | 333.78 *(+16.8%)* | 4.79x |
| Pool + Cache | 2249.15 *(-0.3%)* | 850.60 *(+1.6%)* | 482.69 *(+8.2%)* | 363.49 *(+14.7%)* | 4.40x |
| Pool + Cache + Autoscale | 2341.48 *(+1.3%)* | 812.72 *(-10.0%)* | 480.52 *(+5.9%)* | `287.38` *(-2.2%)* | 5.56x |

## Realistic scenario benchmarks


### Load profile: Burstiness

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2287.49 *(+0.2%)* | 825.06 *(-0.3%)* | 605.82 *(+28.9%)* | 347.29 *(+10.3%)* |
| Pool + Autoscale | 2324.63 *(+0.9%)* | 841.44 *(+0.3%)* | 436.25 *(+1.3%)* | 315.40 *(+13.6%)* |
| Pool + Cache | 57.68 *(-5.6%)* | 50.70 *(-0.0%)* | 53.89 *(+5.5%)* | 51.18 *(+2.9%)* |
| Pool + Cache + Autoscale | 52.00 *(+1.3%)* | 62.57 *(+23.7%)* | 50.59 *(-0.6%)* | `50.42` *(-1.5%)* |

### Load profile: Mixed task sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2354.04 *(+0.0%)* | 853.47 *(-1.6%)* | 483.17 *(+7.9%)* | 396.13 *(+24.3%)* |
| Pool + Autoscale | 2391.16 *(+0.7%)* | 852.72 *(+0.3%)* | 496.16 *(+12.8%)* | 328.42 *(+14.7%)* |
| Pool + Cache | 62.91 *(+9.3%)* | 63.90 *(+56.0%)* | 58.92 *(+51.0%)* | `43.57` *(+10.8%)* |
| Pool + Cache + Autoscale | 70.96 *(+34.5%)* | 45.28 *(+6.2%)* | 50.78 *(+46.0%)* | 58.40 *(+38.3%)* |

### Load profile: Ramp traffic

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2273.03 *(+0.7%)* | 849.36 *(-1.1%)* | 448.15 *(+3.2%)* | 346.96 *(+15.2%)* |
| Pool + Autoscale | 2330.33 *(+1.3%)* | 880.16 *(+7.1%)* | 464.78 *(+5.7%)* | 304.24 *(+8.1%)* |
| Pool + Cache | 107.88 *(+1.1%)* | `105.98` *(-0.6%)* | 106.68 *(+1.8%)* | 106.02 *(+0.5%)* |
| Pool + Cache + Autoscale | 106.52 *(+1.2%)* | 106.52 *(+1.0%)* | 106.18 *(-0.5%)* | 106.25 *(+0.9%)* |

### Load profile: Variable payload sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2241.87 *(-0.0%)* | 866.69 *(+6.5%)* | 546.94 *(+27.5%)* | 402.52 *(+33.4%)* |
| Pool + Autoscale | 2260.21 *(-2.0%)* | 846.23 *(+1.1%)* | 506.68 *(+16.8%)* | 327.78 *(+15.9%)* |
| Pool + Cache | 50.47 *(-3.1%)* | 47.35 *(+16.1%)* | 53.51 *(+37.2%)* | 54.79 *(+31.6%)* |
| Pool + Cache + Autoscale | 62.54 *(+14.4%)* | 42.08 *(+5.0%)* | `36.04` *(-5.1%)* | 46.02 *(+37.5%)* |

### Load profile: I/O bound

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2246.73 *(+1.5%)* | 1126.45 *(+34.4%)* | 603.15 *(+34.7%)* | 425.98 *(+34.2%)* |
| Pool + Autoscale | 8050.49 *(+3.4%)* | 4071.11 *(+5.3%)* | 2029.22 *(+13.1%)* | 1038.53 *(+14.5%)* |
| Pool + Cache | 55.33 *(+1.2%)* | 62.15 *(+16.7%)* | `50.10` *(+11.8%)* | 57.43 *(+34.5%)* |
| Pool + Cache + Autoscale | 209.24 *(+21.8%)* | 112.95 *(+15.9%)* | 88.45 *(+28.9%)* | 67.30 *(+30.5%)* |

### Load profile: Thundering herd

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2358.36 *(-0.3%)* | 813.72 *(+0.7%)* | 452.97 *(+3.0%)* | 362.46 *(+19.1%)* |
| Pool + Autoscale | 2263.28 *(-1.0%)* | 808.86 *(-4.4%)* | 435.51 *(-13.3%)* | 320.65 *(+15.8%)* |
| Pool + Cache | 20.60 *(-22.1%)* | 26.34 *(-8.9%)* | 28.84 *(-5.1%)* | 39.55 *(+37.0%)* |
| Pool + Cache + Autoscale | `18.98` *(-9.7%)* | 44.30 *(+43.6%)* | 28.51 *(+44.0%)* | 28.80 *(-2.9%)* |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2237.71 *(-1.6%)* | 814.66 *(+1.1%)* | 445.57 *(+6.4%)* | 397.43 *(+28.2%)* |
| Pool + Autoscale | 2298.33 *(+0.3%)* | 904.13 *(+11.1%)* | 453.54 *(+3.2%)* | 314.69 *(+11.1%)* |
| Pool + Cache | 1976.34 *(-0.3%)* | 777.76 *(+5.6%)* | 409.45 *(+5.6%)* | 352.26 *(+14.8%)* |
| Pool + Cache + Autoscale | 2018.48 *(-1.1%)* | 756.18 *(-1.1%)* | 428.87 *(+9.9%)* | `312.29` *(+19.3%)* |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2388.05 *(+5.6%)* | 858.36 *(+4.4%)* | 484.45 *(+3.7%)* | 365.07 *(+13.5%)* |
| Pool + Autoscale | 2458.80 *(+7.6%)* | 827.91 *(-3.6%)* | 445.39 *(-0.4%)* | 354.28 *(+30.9%)* |
| Pool + Cache | 963.46 *(+5.6%)* | 464.53 *(+1.9%)* | 276.64 *(+2.6%)* | 240.50 *(+20.9%)* |
| Pool + Cache + Autoscale | 1028.79 *(+8.5%)* | 475.52 *(+0.6%)* | 330.61 *(+29.8%)* | `211.64` *(+16.6%)* |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2240.20 *(-4.4%)* | 848.33 *(+3.1%)* | 478.64 *(+6.6%)* | 372.02 *(+15.1%)* |
| Pool + Autoscale | 2287.06 *(-1.9%)* | 822.34 *(+0.0%)* | 469.45 *(+3.0%)* | 333.35 *(+15.6%)* |
| Pool + Cache | 270.45 *(+6.4%)* | 165.94 *(+5.5%)* | 110.52 *(+4.6%)* | 102.70 *(+35.9%)* |
| Pool + Cache + Autoscale | 273.03 *(+0.7%)* | 155.41 *(+0.6%)* | 103.08 *(+14.8%)* | `85.54` *(+26.5%)* |

## Cache benchmark

- Miss total: 2.17 ms
- Hit total (5 reps): 0.99 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 2.48 ms
- Hit pass under eviction: 0.27 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 11.29 ms
- Concurrent (dedup): 1.44 ms (87.2% faster)

- Cache getOrSetAsync dedupe total: 17.19 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10


## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 31.50 ms
- Warm-start total: 0.24 ms

- PowerMemoizer total: 16.64 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10


## Helper micro-benchmarks

_100,000 ops per variant, median of 5 runs_

| Helper | Variant | Total (ms) | ops/sec | Δ prev |
| :--- | :--- | ---: | ---: | ---: |
| **PowerRateLimit** | under rate (all pass) | 20.06 | 4,984,558 | +1.5% |
| **PowerRateLimit** | over rate (~50% reject) | 14.91 | 6,707,270 | +0.4% |
| **PowerCircuit** | closed (happy path) | 1.66 | 12,078,491 | +13.9% |
| **PowerCircuit** | open (fast-fail) | 40.69 | 491,521 | +1.2% |
| **PowerRetry** | 1 attempt (no retry) | 1.27 | 7,876,106 | +17.5% |
| **PowerRetry** | 2 attempts (1 retry, baseDelay=0) | 10785.72 | 927 | -0.6% |
| **PowerSemaphore** | limit=1 (exclusive lock, serial) | 7.31 | 6,837,670 | +45.1% |
| **PowerSemaphore** | limit=8 (concurrent pool) | 27.77 | 1,800,213 | +32.5% |
| **PowerBulkhead** | 1 partition (baseline) | 20.96 | 954,088 | +17.9% |
| **PowerBulkhead** | 2 partitions (critical vs background) | 23.67 | 844,973 | +28.8% |
| **PowerBatch** | individual dispatch (maxSize=1) | 41.48 | 2,410,756 | +22.1% |
| **PowerBatch** | coalesced dispatch (maxSize=ops) | 6.78 | 14,743,085 | +2.1% |
| **PowerBackpressure** | no pressure (capacity >> ops) | 1.46 | 20,603,221 | -27.9% |
| **PowerBackpressure** | with pressure (capacity=100) | 5.23 | 5,737,590 | -27.3% |
| **PowerTTLMap** | long TTL (60 s, no eviction) | 25.03 | 3,995,836 | +1.6% |
| **PowerTTLMap** | short TTL (1 ms, high eviction) | 24.06 | 4,156,272 | -2.2% |
| **PowerEventBus** | 1 subscriber | 1.68 | 59,359,898 | +2.0% |
| **PowerEventBus** | 10 subscribers | 5.91 | 16,910,614 | -2.1% |
| **PowerEventBus** | 50 subscribers | 25.74 | 3,885,535 | -2.4% |
| **PowerEventBus** | 100 subscribers | 49.37 | 2,025,339 | +0.3% |
| **PowerDeadline** | success (task within deadline) | 5.66 | 884,138 | -9.3% |
| **PowerDeadline** | abort (task exceeds 1 ms deadline) | 5361.75 | 933 | -2.8% |
| **PowerSlidingWindow** | under capacity (all pass) | 15.50 | 6,451,959 | +39.1% |
| **PowerSlidingWindow** | at capacity (~50% reject) | 14.38 | 6,955,753 | +36.4% |
| **PowerQueue** | push x100000 + shift x100000 | 1.35 | 74,073,306 | +36.1% |
| **PowerQueue** | interleaved push+shift (steady state) | 0.58 | 172,827,387 | +38.7% |


## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

### Regressions

| Key | prev (ms) | current (ms) | Δ |
| :--- | ---: | ---: | ---: |
| profiles/50% variable/optimizedPool/4 | 228.45 | 341.00 | **+49.3%** |
| profiles/75% variable/optimizedPool/4 | 329.05 | 487.87 | **+48.3%** |
| profiles/50% variable/pool/8 | 282.08 | 390.05 | **+38.3%** |
