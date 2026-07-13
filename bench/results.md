# Benchmark Results

Generated: 2026-07-13T18:12:40.961Z

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
- Single-threaded total: 1590.95 ms | throughput: 629 tasks/s | p50: 1.56 ms | p95: 1.74 ms | p99: 1.81 ms
- Worker-thread total: 2343.21 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2306.34 *(+8.5%)* | 841.10 *(+9.9%)* | 543.71 *(+7.2%)* | 331.43 *(+14.0%)* | 4.80x |
| Pool + Autoscale | 2350.28 *(+8.7%)* | 844.99 *(+8.8%)* | 481.31 *(+7.7%)* | 293.67 *(+10.9%)* | 5.42x |
| Pool + Cache | 35.64 *(-4.2%)* | 30.29 *(-7.9%)* | 36.10 *(+9.6%)* | 41.03 *(+3.7%)* | 52.53x |
| Pool + Cache + Autoscale | 38.55 *(+3.8%)* | `29.85` *(-7.9%)* | 32.75 *(+0.5%)* | 40.13 *(+2.5%)* | 53.31x |

### Load profile: 25% variable
- Single-threaded total: 1602.56 ms | throughput: 624 tasks/s | p50: 1.54 ms | p95: 2.49 ms | p99: 2.65 ms
- Worker-thread total: 2410.79 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2448.59 *(+3.8%)* | 914.12 *(+9.3%)* | 580.92 *(+5.3%)* | 336.30 *(+3.0%)* | 4.77x |
| Pool + Autoscale | 2435.26 *(+0.8%)* | 903.71 *(+7.1%)* | 492.62 *(+2.7%)* | 296.08 *(+4.9%)* | 5.41x |
| Pool + Cache | 454.23 *(+0.6%)* | 290.39 *(+21.7%)* | 167.09 *(-1.0%)* | 121.35 *(+4.9%)* | 13.21x |
| Pool + Cache + Autoscale | 455.99 *(+0.7%)* | 241.96 *(-0.7%)* | 148.56 *(+1.3%)* | `103.69` *(+5.2%)* | 15.45x |

### Load profile: 50% variable
- Single-threaded total: 1586.74 ms | throughput: 630 tasks/s | p50: 1.61 ms | p95: 2.18 ms | p99: 2.80 ms
- Worker-thread total: 2306.27 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2317.06 *(-3.5%)* | 818.61 *(-5.3%)* | 536.14 *(-7.9%)* | 314.42 *(-6.8%)* | 5.05x |
| Pool + Autoscale | 2336.67 *(-9.3%)* | 826.94 *(-3.2%)* | 463.35 *(-3.4%)* | 285.78 *(-3.7%)* | 5.55x |
| Pool + Cache | 826.20 *(-0.8%)* | 440.61 *(-3.1%)* | 286.80 *(-0.7%)* | 177.70 *(-3.5%)* | 8.93x |
| Pool + Cache + Autoscale | 849.90 *(-2.0%)* | 425.97 *(-3.5%)* | 255.51 *(-0.7%)* | `159.78` *(-7.8%)* | 9.93x |

### Load profile: 75% variable
- Single-threaded total: 1989.48 ms | throughput: 503 tasks/s | p50: 1.76 ms | p95: 3.84 ms | p99: 4.16 ms
- Worker-thread total: 2331.88 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2340.69 *(+3.7%)* | 846.31 *(-3.1%)* | 557.15 *(+2.6%)* | 335.18 *(+5.7%)* | 5.94x |
| Pool + Autoscale | 2408.35 *(+0.7%)* | 868.78 *(+4.9%)* | 482.83 *(+0.4%)* | 297.39 *(+2.1%)* | 6.69x |
| Pool + Cache | 1570.64 *(-5.0%)* | 625.82 *(-3.0%)* | 416.73 *(-2.2%)* | 253.65 *(+4.3%)* | 7.84x |
| Pool + Cache + Autoscale | 1576.60 *(-1.1%)* | 629.84 *(+0.2%)* | 368.72 *(+0.0%)* | `229.85` *(+7.1%)* | 8.66x |

### Load profile: 100% variable
- Single-threaded total: 1626.28 ms | throughput: 615 tasks/s | p50: 1.63 ms | p95: 2.32 ms | p99: 2.57 ms
- Worker-thread total: 2330.18 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 | Speedup |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Pool | 2348.76 *(+0.9%)* | 860.09 *(+4.2%)* | 551.37 *(-1.7%)* | 328.81 *(+2.1%)* | 4.95x |
| Pool + Autoscale | 2416.57 *(+2.4%)* | 845.34 *(+1.5%)* | 481.95 *(+2.0%)* | 290.90 *(-4.1%)* | 5.59x |
| Pool + Cache | 2370.94 *(+2.3%)* | 858.20 *(+3.4%)* | 526.41 *(-4.9%)* | 319.44 *(-1.8%)* | 5.09x |
| Pool + Cache + Autoscale | 2457.73 *(+5.2%)* | 869.50 *(+2.8%)* | 470.57 *(-0.9%)* | `288.62` *(+0.0%)* | 5.63x |

## Realistic scenario benchmarks


### Load profile: Burstiness

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2360.71 *(+0.8%)* | 854.00 *(+3.7%)* | 454.77 *(-15.9%)* | 320.84 *(-1.8%)* |
| Pool + Autoscale | 2407.94 *(+1.8%)* | 841.18 *(-0.0%)* | 466.24 *(-1.6%)* | 295.22 *(-0.0%)* |
| Pool + Cache | 55.60 *(+4.0%)* | `50.34` *(-0.9%)* | 51.07 *(+1.4%)* | 50.35 *(-1.2%)* |
| Pool + Cache + Autoscale | 53.61 *(-10.9%)* | 50.73 *(+0.2%)* | 52.43 *(+2.8%)* | 50.57 *(-0.3%)* |

### Load profile: Mixed task sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2464.96 *(+0.1%)* | 897.58 *(+1.3%)* | 564.99 *(-2.4%)* | 358.96 *(+1.7%)* |
| Pool + Autoscale | 2544.12 *(-5.1%)* | 897.43 *(+2.8%)* | 486.02 *(-2.4%)* | 303.76 *(+5.7%)* |
| Pool + Cache | 57.90 *(-15.1%)* | 43.62 *(+4.9%)* | 38.89 *(+10.0%)* | 41.24 *(+2.3%)* |
| Pool + Cache + Autoscale | 71.67 *(+32.9%)* | `38.63` *(-3.9%)* | 40.09 *(+10.8%)* | 40.02 *(-0.0%)* |

### Load profile: Ramp traffic

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2359.31 *(+1.5%)* | 852.81 *(-8.7%)* | 547.08 *(+10.1%)* | 312.74 *(-3.3%)* |
| Pool + Autoscale | 2432.59 *(+1.6%)* | 881.99 *(+4.6%)* | 526.38 *(+7.3%)* | 325.83 *(+10.6%)* |
| Pool + Cache | 105.70 *(-1.1%)* | 105.99 *(-0.1%)* | 107.67 *(+0.4%)* | 105.74 *(-1.2%)* |
| Pool + Cache + Autoscale | 105.39 *(+0.2%)* | 106.42 *(+0.9%)* | `105.22` *(+0.1%)* | 105.24 *(-0.2%)* |

### Load profile: Variable payload sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2419.15 *(+5.1%)* | 829.66 *(-11.1%)* | 550.96 *(-8.6%)* | 334.39 *(+1.3%)* |
| Pool + Autoscale | 2433.82 *(-2.7%)* | 845.62 *(-10.6%)* | 508.34 *(+3.9%)* | 298.41 *(-2.6%)* |
| Pool + Cache | 54.41 *(-4.2%)* | 41.46 *(+4.2%)* | `38.12` *(-5.9%)* | 45.53 *(+10.0%)* |
| Pool + Cache + Autoscale | 55.25 *(+5.3%)* | 39.52 *(-30.0%)* | 42.70 *(+5.7%)* | 45.94 *(+16.1%)* |

### Load profile: I/O bound

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2380.76 *(-0.9%)* | 832.41 *(-2.6%)* | 599.33 *(+32.8%)* | 339.94 *(+2.1%)* |
| Pool + Autoscale | 7298.34 *(-1.1%)* | 3658.93 *(+0.1%)* | 1825.23 *(-0.2%)* | 933.18 *(-3.9%)* |
| Pool + Cache | 63.21 *(+5.2%)* | 49.29 *(-13.3%)* | `43.93` *(+7.9%)* | 47.45 *(+2.4%)* |
| Pool + Cache + Autoscale | 169.18 *(-6.6%)* | 104.09 *(+0.4%)* | 65.56 *(+3.1%)* | 56.63 *(+6.9%)* |

### Load profile: Thundering herd

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2414.93 *(+4.0%)* | 848.61 *(+1.9%)* | 594.79 *(+14.2%)* | 333.28 *(+5.3%)* |
| Pool + Autoscale | 2607.80 *(+11.8%)* | 854.51 *(+1.6%)* | 494.50 *(+10.1%)* | 301.74 *(+2.6%)* |
| Pool + Cache | `20.55` *(-14.8%)* | 27.12 *(+25.6%)* | 24.91 *(-16.1%)* | 27.99 *(-20.7%)* |
| Pool + Cache + Autoscale | 26.18 *(+4.5%)* | 21.23 *(-13.9%)* | 25.53 *(+3.4%)* | 26.11 *(-11.5%)* |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2381.66 *(+3.7%)* | 878.71 *(+4.5%)* | 567.36 *(+1.6%)* | 327.78 *(-0.1%)* |
| Pool + Autoscale | 2448.00 *(+4.6%)* | 857.35 *(+2.5%)* | 488.75 *(+1.1%)* | 295.63 *(+1.8%)* |
| Pool + Cache | 2132.60 *(+5.0%)* | 764.39 *(+2.5%)* | 443.29 *(-12.2%)* | 303.35 *(+1.4%)* |
| Pool + Cache + Autoscale | 2198.42 *(+4.3%)* | 782.77 *(+3.2%)* | 447.75 *(+3.6%)* | `271.61` *(+6.0%)* |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2422.90 *(+1.1%)* | 867.94 *(+2.1%)* | 579.40 *(+2.9%)* | 353.25 *(+13.2%)* |
| Pool + Autoscale | 2591.11 *(+5.1%)* | 855.30 *(-0.8%)* | 491.41 *(+4.7%)* | 352.12 *(+23.0%)* |
| Pool + Cache | 954.66 *(+1.9%)* | 490.64 *(+5.9%)* | 322.62 *(+4.1%)* | 222.93 *(+14.5%)* |
| Pool + Cache + Autoscale | 1014.32 *(-3.8%)* | 481.26 *(+2.8%)* | 323.85 *(+15.8%)* | `198.10` *(+10.6%)* |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2370.81 *(+2.8%)* | 857.53 *(+4.0%)* | 554.24 *(-2.5%)* | 323.20 *(+2.9%)* |
| Pool + Autoscale | 2423.54 *(+1.2%)* | 899.79 *(+5.6%)* | 450.61 *(-8.7%)* | 300.31 *(+9.4%)* |
| Pool + Cache | 264.22 *(+1.2%)* | 145.36 *(+4.2%)* | 110.36 *(+4.4%)* | 82.45 *(+6.7%)* |
| Pool + Cache + Autoscale | 267.82 *(-0.2%)* | 158.60 *(-11.2%)* | 86.54 *(-5.5%)* | `75.10` *(+7.5%)* |

## Cache benchmark

- Miss total: 3.42 ms
- Hit total (5 reps): 1.58 ms
- Keys tested: 1000

### Cache eviction under pressure

- maxEntries: 200 (20% of 1000 unique keys)
- Miss pass total: 3.59 ms
- Hit pass under eviction: 0.27 ms

### Serial vs concurrent getOrSetAsync (in-flight deduplication)

- Tasks: 1000 | Unique keys: 10
- Serial (no dedup): 10.44 ms
- Concurrent (dedup): 1.69 ms (83.8% faster)

- Cache getOrSetAsync dedupe total: 24.46 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10


## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 40.20 ms
- Warm-start total: 0.26 ms

- PowerMemoizer total: 24.30 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10


## Helper micro-benchmarks

_100,000 ops per variant, median of 5 runs_

| Helper | Variant | Total (ms) | ops/sec | Δ prev |
| :--- | :--- | ---: | ---: | ---: |
| **PowerRateLimit** | under rate (all pass) | 20.25 | 4,938,104 | -1.9% |
| **PowerRateLimit** | over rate (~50% reject) | 15.61 | 6,405,632 | +3.8% |
| **PowerCircuit** | closed (happy path) | 1.56 | 12,860,893 | -3.6% |
| **PowerCircuit** | open (fast-fail) | 50.33 | 397,368 | +20.0% |
| **PowerRetry** | 1 attempt (no retry) | 1.72 | 5,801,884 | +39.2% |
| **PowerRetry** | 2 attempts (1 retry, baseDelay=0) | 10632.17 | 941 | -0.1% |
| **PowerSemaphore** | limit=1 (exclusive lock, serial) | 5.56 | 8,990,059 | -1.4% |
| **PowerSemaphore** | limit=8 (concurrent pool) | 26.74 | 1,869,579 | -7.6% |
| **PowerBulkhead** | 1 partition (baseline) | 21.50 | 930,277 | -11.6% |
| **PowerBulkhead** | 2 partitions (critical vs background) | 22.96 | 870,908 | -0.2% |
| **PowerBatch** | individual dispatch (maxSize=1) | 34.02 | 2,939,460 | -21.5% |
| **PowerBatch** | coalesced dispatch (maxSize=ops) | 9.08 | 11,012,876 | +7.3% |
| **PowerBackpressure** | no pressure (capacity >> ops) | 2.02 | 14,878,679 | +24.4% |
| **PowerBackpressure** | with pressure (capacity=100) | 7.23 | 4,148,933 | -9.0% |
| **PowerTTLMap** | long TTL (60 s, no eviction) | 27.70 | 3,609,498 | +7.6% |
| **PowerTTLMap** | short TTL (1 ms, high eviction) | 26.47 | 3,777,181 | +7.0% |
| **PowerEventBus** | 1 subscriber | 1.76 | 56,739,810 | +4.6% |
| **PowerEventBus** | 10 subscribers | 6.05 | 16,523,518 | -0.3% |
| **PowerEventBus** | 50 subscribers | 28.69 | 3,485,962 | +9.0% |
| **PowerEventBus** | 100 subscribers | 52.10 | 1,919,540 | +1.9% |
| **PowerDeadline** | success (task within deadline) | 7.52 | 664,571 | +11.4% |
| **PowerDeadline** | abort (task exceeds 1 ms deadline) | 5343.44 | 936 | -0.1% |
| **PowerSlidingWindow** | under capacity (all pass) | 11.63 | 8,601,959 | -2.8% |
| **PowerSlidingWindow** | at capacity (~50% reject) | 10.65 | 9,388,129 | -2.2% |
| **PowerQueue** | push x100000 + shift x100000 | 1.00 | 99,624,813 | -17.1% |
| **PowerQueue** | interleaved push+shift (steady state) | 0.42 | 237,738,065 | +1.5% |


## Δ vs previous run

_Pool/scenario: flagged when >±35% AND >±50 ms. Helpers: flagged when >±20% AND >±8 ms._

### Regressions

| Key | prev (ms) | current (ms) | Δ |
| :--- | ---: | ---: | ---: |
| helpers/PowerCircuit/open (fast-fail) | 41.94 | 50.33 | **+20.0%** |

### Improvements

| Key | prev (ms) | current (ms) | Δ |
| :--- | ---: | ---: | ---: |
| helpers/PowerBatch/individual dispatch (maxSize=1) | 43.32 | 34.02 | -21.5% |
