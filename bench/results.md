# Benchmark Results

Generated: 2026-04-10T15:43:35.965Z

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
- Single-threaded total: 1577.94 ms | throughput: 634 tasks/s | p50: 1.50 ms | p95: 1.77 ms | p99: 2.55 ms
- Worker-thread total: 2237.89 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2343.06 *(+4.3%)* | 875.79 *(+12.4%)* | 459.94 *(+10.3%)* | 324.84 *(+5.3%)* | 4.86x |
| Pool + Autoscale | 2397.76 *(+8.7%)* | 865.34 *(+9.3%)* | 461.56 *(+11.5%)* | 295.40 *(+8.5%)* | 5.34x |
| Pool + Cache | 42.89 *(+22.5%)* | 36.25 *(+22.2%)* | 34.38 *(+3.3%)* | 41.44 *(+15.4%)* | 45.90x |
| Pool + Cache + Autoscale | 32.97 *(-1.9%)* | `32.12` *(-7.4%)* | 34.25 *(+19.5%)* | 37.65 *(+6.5%)* | 49.13x |

### Load profile: 25% variable
- Single-threaded total: 1612.17 ms | throughput: 620 tasks/s | p50: 1.65 ms | p95: 2.00 ms | p99: 2.24 ms
- Worker-thread total: 2430.94 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2383.17 *(-3.7%)* | 867.65 *(-1.8%)* | 495.19 *(-0.2%)* | 337.64 *(+4.5%)* | 4.77x |
| Pool + Autoscale | 2387.20 *(-3.7%)* | 875.63 *(+1.2%)* | 476.12 *(+1.8%)* | 305.36 *(+0.2%)* | 5.28x |
| Pool + Cache | 434.59 *(-2.2%)* | 246.52 *(+7.6%)* | 161.75 *(+23.0%)* | 119.79 *(+9.8%)* | 13.46x |
| Pool + Cache + Autoscale | 443.94 *(-0.1%)* | 248.89 *(-1.0%)* | 147.86 *(+6.7%)* | `107.05` *(+6.9%)* | 15.06x |

### Load profile: 50% variable
- Single-threaded total: 1376.89 ms | throughput: 726 tasks/s | p50: 1.45 ms | p95: 2.15 ms | p99: 2.36 ms
- Worker-thread total: 1970.16 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 1935.63 *(-9.4%)* | 739.17 *(-7.1%)* | 392.23 *(-10.4%)* | 282.08 *(-8.3%)* | 4.88x |
| Pool + Autoscale | 2002.47 *(-8.4%)* | 717.99 *(-7.4%)* | 385.74 *(-10.6%)* | 243.75 *(-11.5%)* | 5.65x |
| Pool + Cache | 792.73 *(-1.8%)* | 409.96 *(-5.2%)* | 228.45 *(-13.5%)* | 174.32 *(+0.2%)* | 7.90x |
| Pool + Cache + Autoscale | 807.61 *(-2.4%)* | 425.25 *(+2.8%)* | 241.02 *(+3.9%)* | `159.86` *(+1.9%)* | 8.61x |

### Load profile: 75% variable
- Single-threaded total: 1936.35 ms | throughput: 516 tasks/s | p50: 1.74 ms | p95: 3.61 ms | p99: 4.17 ms
- Worker-thread total: 2269.71 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2254.53 *(-3.1%)* | 813.34 *(-4.8%)* | 440.13 *(-4.2%)* | 298.85 *(-12.8%)* | 6.48x |
| Pool + Autoscale | 2297.49 *(-3.1%)* | 812.14 *(-5.3%)* | 456.06 *(-2.0%)* | 274.49 *(-14.7%)* | 7.05x |
| Pool + Cache | 1511.73 *(-2.0%)* | 618.15 *(-3.0%)* | 329.05 *(-9.6%)* | 249.32 *(-0.5%)* | 7.77x |
| Pool + Cache + Autoscale | 1533.07 *(-3.6%)* | 616.75 *(-5.6%)* | 332.24 *(-5.8%)* | `217.93` *(-3.7%)* | 8.89x |

### Load profile: 100% variable
- Single-threaded total: 1596.12 ms | throughput: 627 tasks/s | p50: 1.59 ms | p95: 2.26 ms | p99: 2.48 ms
- Worker-thread total: 2229.34 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2241.90 *(-2.9%)* | 828.16 *(+0.4%)* | 448.75 *(+1.4%)* | 332.92 *(+1.4%)* | 4.79x |
| Pool + Autoscale | 2292.29 *(-1.2%)* | 838.59 *(+1.1%)* | 453.09 *(+0.7%)* | `285.69` *(-3.8%)* | 5.59x |
| Pool + Cache | 2256.27 *(-0.9%)* | 836.90 *(+0.0%)* | 445.96 *(-1.6%)* | 316.87 *(-3.8%)* | 5.04x |
| Pool + Cache + Autoscale | 2312.00 *(-0.5%)* | 902.92 *(+9.1%)* | 453.89 *(-0.3%)* | 293.96 *(+1.7%)* | 5.43x |

## Realistic scenario benchmarks


### Load profile: Burstiness

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2283.05 *(+1.3%)* | 827.72 *(-1.9%)* | 469.81 *(+7.5%)* | 314.75 *(+1.9%)* |
| Pool + Autoscale | 2303.37 *(+0.2%)* | 838.99 *(+2.4%)* | 430.56 *(-3.7%)* | 277.57 *(-9.4%)* |
| Pool + Cache | 61.10 *(+18.6%)* | 50.70 *(-2.1%)* | 51.10 *(+0.4%)* | `49.73` *(-3.7%)* |
| Pool + Cache + Autoscale | 51.35 *(+2.0%)* | 50.58 *(+0.4%)* | 50.88 *(+0.5%)* | 51.20 *(+1.6%)* |

### Load profile: Mixed task sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2353.29 *(-0.7%)* | 867.60 *(+0.4%)* | 447.59 *(-5.6%)* | 318.77 *(-4.4%)* |
| Pool + Autoscale | 2374.03 *(-1.1%)* | 849.98 *(-2.1%)* | 439.66 *(-2.7%)* | 286.32 *(-3.7%)* |
| Pool + Cache | 57.57 *(-0.2%)* | 40.97 *(+6.8%)* | 39.02 *(-6.4%)* | 39.33 *(+5.3%)* |
| Pool + Cache + Autoscale | 52.78 *(+1.7%)* | 42.62 *(+24.7%)* | `34.78` *(-6.3%)* | 42.22 *(+5.9%)* |

### Load profile: Ramp traffic

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2256.29 *(-0.3%)* | 859.07 *(+5.4%)* | 434.38 *(-3.2%)* | 301.28 *(-4.8%)* |
| Pool + Autoscale | 2300.12 *(-0.9%)* | 822.03 *(+0.1%)* | 439.56 *(-4.8%)* | 281.51 *(+1.2%)* |
| Pool + Cache | 106.74 *(+0.6%)* | 106.64 *(+1.4%)* | `104.81` *(-1.5%)* | 105.49 *(-0.6%)* |
| Pool + Cache + Autoscale | 105.29 *(-1.4%)* | 105.49 *(-0.8%)* | 106.71 *(+1.4%)* | 105.31 *(-0.5%)* |

### Load profile: Variable payload sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2242.06 *(+1.5%)* | 813.73 *(-0.3%)* | 428.94 *(-3.4%)* | 301.80 *(-5.5%)* |
| Pool + Autoscale | 2305.47 *(+0.9%)* | 837.27 *(+3.1%)* | 433.90 *(-1.0%)* | 282.89 *(-1.9%)* |
| Pool + Cache | 52.09 *(-8.2%)* | 40.77 *(+1.8%)* | 39.01 *(-2.5%)* | 41.64 *(+16.9%)* |
| Pool + Cache + Autoscale | 54.66 *(-0.5%)* | 40.07 *(-14.5%)* | 37.97 *(-4.0%)* | `33.47` *(-18.4%)* |

### Load profile: I/O bound

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2214.04 *(-2.7%)* | 838.15 *(+0.7%)* | 447.68 *(-10.9%)* | 317.35 *(+2.3%)* |
| Pool + Autoscale | 7783.08 *(-2.3%)* | 3866.12 *(-1.0%)* | 1794.82 *(-4.1%)* | 907.10 *(-5.2%)* |
| Pool + Cache | 54.68 *(-20.9%)* | 53.24 *(-2.9%)* | 44.79 *(+3.9%)* | `42.70` *(+1.3%)* |
| Pool + Cache + Autoscale | 171.80 *(-15.4%)* | 97.46 *(+3.8%)* | 68.64 *(-3.3%)* | 51.58 *(+4.8%)* |

### Load profile: Thundering herd

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2364.49 *(+5.1%)* | 808.02 *(-0.2%)* | 439.85 *(-5.9%)* | 304.33 *(-0.1%)* |
| Pool + Autoscale | 2286.78 *(-1.4%)* | 846.26 *(+1.9%)* | 502.54 *(+12.5%)* | 276.90 *(+1.2%)* |
| Pool + Cache | 26.45 *(+22.1%)* | 28.90 *(+51.2%)* | 30.40 *(+29.0%)* | 28.86 *(+1.1%)* |
| Pool + Cache + Autoscale | 21.01 *(-25.0%)* | 30.84 *(+9.1%)* | `19.81` *(-28.2%)* | 29.67 *(+28.2%)* |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2274.52 *(+0.8%)* | 806.12 *(-2.4%)* | 418.92 *(-2.4%)* | 309.95 *(-0.4%)* |
| Pool + Autoscale | 2290.89 *(+0.7%)* | 813.45 *(-2.4%)* | 439.40 *(+1.0%)* | 283.26 *(+2.0%)* |
| Pool + Cache | 1982.23 *(-3.0%)* | 736.75 *(-2.9%)* | 387.88 *(-14.4%)* | 306.82 *(+0.4%)* |
| Pool + Cache + Autoscale | 2041.72 *(+1.1%)* | 764.39 *(+1.9%)* | 390.41 *(-8.0%)* | `261.86` *(-1.2%)* |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2260.67 *(-3.7%)* | 821.89 *(+1.1%)* | 467.33 *(+8.2%)* | 321.76 *(+1.6%)* |
| Pool + Autoscale | 2285.72 *(-4.6%)* | 858.44 *(+1.5%)* | 447.27 *(-0.3%)* | 270.65 *(+0.5%)* |
| Pool + Cache | 912.54 *(-3.8%)* | 455.78 *(-0.3%)* | 269.53 *(+9.6%)* | 198.97 *(+6.6%)* |
| Pool + Cache + Autoscale | 948.54 *(+0.4%)* | 472.62 *(-1.5%)* | 254.66 *(-0.9%)* | `181.50` *(+4.3%)* |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2342.29 *(+3.2%)* | 823.22 *(+2.0%)* | 448.98 *(-2.3%)* | 323.21 *(+2.6%)* |
| Pool + Autoscale | 2330.49 *(+2.9%)* | 822.07 *(+0.9%)* | 455.63 *(+3.1%)* | 288.37 *(-0.2%)* |
| Pool + Cache | 254.17 *(-2.9%)* | 157.29 *(+14.3%)* | 105.66 *(+25.8%)* | 75.56 *(-1.2%)* |
| Pool + Cache + Autoscale | 271.25 *(-0.6%)* | 154.49 *(+1.8%)* | 89.79 *(+0.2%)* | `67.60` *(-7.4%)* |

## Cache benchmark

- Miss total: 3.64 ms
- Hit total (5 reps): 1.49 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 3.38 ms
- Hit pass under eviction: 0.27 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 10.30 ms
- Concurrent (dedup): 1.48 ms (85.6% faster)

- Cache getOrSetAsync dedupe total: 15.78 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10


## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 32.20 ms
- Warm-start total: 0.23 ms

- PowerMemoizer total: 16.54 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10


## Helper micro-benchmarks

_100,000 ops per variant, median of 5 runs_

| Helper | Variant | Total (ms) | ops/sec | Δ prev |
| :--- | :--- | ---: | ---: | ---: |
| **PowerRateLimit** | under rate (all pass) | 19.76 | 5,060,900 | -0.5% |
| **PowerRateLimit** | over rate (~50% reject) | 14.85 | 6,735,604 | +0.3% |
| **PowerCircuit** | closed (happy path) | 1.45 | 13,754,212 | -11.3% |
| **PowerCircuit** | open (fast-fail) | 40.21 | 497,449 | -1.8% |
| **PowerRetry** | 1 attempt (no retry) | 1.08 | 9,255,154 | -24.6% |
| **PowerRetry** | 2 attempts (1 retry, baseDelay=0) | 10849.06 | 922 | -0.5% |
| **PowerSemaphore** | limit=1 (exclusive lock, serial) | 5.04 | 9,922,797 | -3.1% |
| **PowerSemaphore** | limit=8 (concurrent pool) | 20.95 | 2,386,079 | -17.2% |
| **PowerBulkhead** | 1 partition (baseline) | 17.78 | 1,125,023 | +1.1% |
| **PowerBulkhead** | 2 partitions (critical vs background) | 18.37 | 1,088,494 | +10.5% |
| **PowerBatch** | individual dispatch (maxSize=1) | 33.96 | 2,944,420 | +16.3% |
| **PowerBatch** | coalesced dispatch (maxSize=ops) | 6.64 | 15,059,858 | -1.8% |
| **PowerBackpressure** | no pressure (capacity >> ops) | 2.02 | 14,851,309 | +44.9% |
| **PowerBackpressure** | with pressure (capacity=100) | 7.19 | 4,170,700 | +66.5% |
| **PowerTTLMap** | long TTL (60 s, no eviction) | 24.63 | 4,060,904 | -4.7% |
| **PowerTTLMap** | short TTL (1 ms, high eviction) | 24.61 | 4,063,041 | +1.7% |
| **PowerEventBus** | 1 subscriber | 1.65 | 60,554,644 | +1.1% |
| **PowerEventBus** | 10 subscribers | 6.04 | 16,556,286 | +1.9% |
| **PowerEventBus** | 50 subscribers | 26.36 | 3,793,868 | +2.7% |
| **PowerEventBus** | 100 subscribers | 49.23 | 2,031,457 | +0.2% |
| **PowerDeadline** | success (task within deadline) | 6.24 | 801,553 | +11.4% |
| **PowerDeadline** | abort (task exceeds 1 ms deadline) | 5516.23 | 906 | +3.0% |
| **PowerSlidingWindow** | under capacity (all pass) | 11.14 | 8,973,321 | +1.8% |
| **PowerSlidingWindow** | at capacity (~50% reject) | 10.54 | 9,488,115 | +2.6% |
| **PowerQueue** | push x100000 + shift x100000 | 0.99 | 100,811,228 | -4.7% |
| **PowerQueue** | interleaved push+shift (steady state) | 0.42 | 239,725,945 | +0.7% |


## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

_All results within thresholds — no significant changes detected._
