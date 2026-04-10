# Benchmark Results

Generated: 2026-04-10T11:01:52.944Z

## Configuration

- MODE: all
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8
- LOAD_PROFILES: 0% variable, 25% variable, 50% variable, 75% variable, 100% variable

Learn more about the benchmarks [here](README.md)


## Synthetic scenario benchmarks


### Load profile: 0% variable
- Single-threaded total: 1557.89 ms
- Worker-thread total: 2237.27 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2592.60 | 962.22 | 515.80 | 375.32 |
| Pool + Autoscale | 2643.93 | 919.29 | 488.38 | 320.76 |
| Pool + Cache | `20.10` | 23.15 | 26.32 | 33.48 |
| Pool + Cache + Autoscale | 26.29 | 27.58 | 21.07 | 25.43 |

### Load profile: 25% variable
- Single-threaded total: 1509.57 ms
- Worker-thread total: 2202.86 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2189.16 | 793.14 | 426.22 | 340.58 |
| Pool + Autoscale | 2351.49 | 797.45 | 446.44 | 289.11 |
| Pool + Cache | 433.29 | 231.24 | 141.92 | 113.66 |
| Pool + Cache + Autoscale | 452.53 | 238.60 | 144.87 | `109.03` |

### Load profile: 50% variable
- Single-threaded total: 1577.25 ms
- Worker-thread total: 2277.52 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2217.09 | 825.23 | 442.98 | 324.92 |
| Pool + Autoscale | 2269.40 | 822.08 | 442.86 | 293.94 |
| Pool + Cache | 812.23 | 424.47 | 232.95 | 201.58 |
| Pool + Cache + Autoscale | 879.43 | 424.32 | 233.82 | `157.94` |

### Load profile: 75% variable
- Single-threaded total: 1899.10 ms
- Worker-thread total: 2271.47 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2277.73 | 824.16 | 434.80 | 333.22 |
| Pool + Autoscale | 2274.93 | 815.42 | 443.24 | 286.21 |
| Pool + Cache | 1516.01 | 620.41 | 377.48 | 262.40 |
| Pool + Cache + Autoscale | 1550.40 | 615.96 | 343.68 | `216.39` |

### Load profile: 100% variable
- Single-threaded total: 1502.11 ms
- Worker-thread total: 2252.21 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2244.24 | 810.54 | 466.52 | 320.71 |
| Pool + Autoscale | 2240.81 | 831.03 | 446.40 | 278.96 |
| Pool + Cache | 2228.35 | 811.76 | 438.96 | 313.68 |
| Pool + Cache + Autoscale | 2255.88 | 819.76 | 433.44 | `274.49` |

## Realistic scenario benchmarks


### Load profile: Burstiness

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2290.80 | 863.44 | 455.72 | 320.42 |
| Pool + Autoscale | 2297.83 | 863.42 | 451.40 | 279.28 |
| Pool + Cache | 49.84 | 51.19 | 49.90 | 51.12 |
| Pool + Cache + Autoscale | 61.50 | 51.99 | `49.72` | 49.84 |

### Load profile: Mixed task sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2314.02 | 878.36 | 462.27 | 341.67 |
| Pool + Autoscale | 2367.19 | 850.53 | 467.60 | 301.50 |
| Pool + Cache | 75.42 | 49.93 | 43.07 | 60.33 |
| Pool + Cache + Autoscale | 61.96 | 45.88 | 45.05 | `41.73` |

### Load profile: Ramp traffic

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2280.66 | 832.04 | 428.71 | 313.08 |
| Pool + Autoscale | 2373.04 | 812.65 | 431.34 | 283.02 |
| Pool + Cache | 106.21 | 106.67 | 106.21 | 106.32 |
| Pool + Cache + Autoscale | 106.16 | 104.94 | 106.35 | `104.49` |

### Load profile: Variable payload sizes

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2254.93 | 829.37 | 608.44 | 323.39 |
| Pool + Autoscale | 2323.67 | 853.72 | 500.11 | 274.51 |
| Pool + Cache | 49.78 | 37.80 | 39.55 | 39.74 |
| Pool + Cache + Autoscale | 56.91 | 57.40 | 41.97 | `36.19` |

### Load profile: I/O bound

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2205.99 | 803.17 | 425.58 | 312.43 |
| Pool + Autoscale | 7802.84 | 3830.25 | 1812.96 | 956.24 |
| Pool + Cache | 61.40 | `37.89` | 44.46 | 40.57 |
| Pool + Cache + Autoscale | 165.37 | 91.64 | 66.74 | 48.21 |

### Load profile: Thundering herd

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2247.15 | 805.51 | 446.52 | 312.74 |
| Pool + Autoscale | 2284.79 | 855.85 | 455.58 | 291.70 |
| Pool + Cache | `20.62` | 27.27 | 30.02 | 30.71 |
| Pool + Cache + Autoscale | 24.89 | 20.84 | 23.28 | 26.58 |

### Load profile: Cache hit ratio 10%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2257.64 | 811.97 | 447.67 | 328.23 |
| Pool + Autoscale | 2278.17 | 836.28 | 447.13 | 280.10 |
| Pool + Cache | 1968.20 | 742.03 | 396.98 | 272.28 |
| Pool + Cache + Autoscale | 2038.31 | 765.03 | 415.93 | `257.45` |

### Load profile: Cache hit ratio 50%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2235.95 | 869.13 | 474.00 | 305.10 |
| Pool + Autoscale | 2394.68 | 819.00 | 453.88 | 298.77 |
| Pool + Cache | 967.32 | 481.16 | 283.30 | 185.64 |
| Pool + Cache + Autoscale | 935.26 | 491.46 | 251.43 | `178.22` |

### Load profile: Cache hit ratio 90%

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2289.36 | 828.71 | 469.72 | 315.12 |
| Pool + Autoscale | 2284.95 | 877.01 | 463.29 | 290.17 |
| Pool + Cache | 255.14 | 153.55 | 117.02 | `78.60` |
| Pool + Cache + Autoscale | 261.73 | 157.68 | 103.45 | 83.27 |

## Cache benchmark

- Miss total: 2.38 ms
- Hit total (5 reps): 1.03 ms
- Keys tested: 1000

- Cache getOrSetAsync dedupe total: 16.48 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10


## Cache warmup benchmark

- Keys tested: 20
- Cold-start total: 31.26 ms
- Warm-start total: 0.21 ms

- PowerMemoizer total: 16.23 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10
