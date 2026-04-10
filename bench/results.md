# Benchmark Results

Generated: 2026-04-10T10:15:05.206Z

## Configuration

- MODE: all
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8
- LOAD_PROFILES: 0% variable, 25% variable, 50% variable, 75% variable, 100% variable

## Load profile: 0% variable
- Single-threaded total: 1529.42 ms
- Worker-thread total: 2292.31 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2701.40 | 993.97 | 527.29 | 358.50 |
| Pool + Autoscale | 2735.89 | 1041.36 | 527.29 | 333.18 |
| Pool + Cache | 23.70 | **`18.36`** | 30.72 | 25.30 |
| Pool + Cache + Autoscale | 27.53 | 30.58 | 21.47 | 27.29 |

## Load profile: 25% variable
- Single-threaded total: 1629.95 ms
- Worker-thread total: 2363.46 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2359.27 | 875.23 | 449.92 | 323.95 |
| Pool + Autoscale | 2364.13 | 865.45 | 491.59 | 312.60 |
| Pool + Cache | 426.77 | 253.34 | 138.50 | 112.00 |
| Pool + Cache + Autoscale | 421.02 | 242.64 | 144.28 | **`102.34`** |

## Load profile: 50% variable
- Single-threaded total: 1578.03 ms
- Worker-thread total: 2299.66 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2298.38 | 832.04 | 452.34 | 321.72 |
| Pool + Autoscale | 2356.93 | 836.28 | 468.17 | 285.77 |
| Pool + Cache | 819.57 | 441.30 | 255.37 | 179.39 |
| Pool + Cache + Autoscale | 827.10 | 452.39 | 255.05 | **`170.88`** |

## Load profile: 75% variable
- Single-threaded total: 1886.32 ms
- Worker-thread total: 2209.13 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2219.49 | 817.23 | 411.33 | 302.35 |
| Pool + Autoscale | 2197.73 | 793.08 | 429.34 | 274.99 |
| Pool + Cache | 1579.95 | 618.91 | 335.52 | 246.59 |
| Pool + Cache + Autoscale | 1523.11 | 616.27 | 333.67 | **`230.86`** |

## Load profile: 100% variable
- Single-threaded total: 1516.77 ms
- Worker-thread total: 2243.40 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2277.71 | 800.38 | 518.67 | 309.92 |
| Pool + Autoscale | 2294.51 | 820.85 | 429.90 | **`280.96`** |
| Pool + Cache | 2235.43 | 802.52 | 454.29 | 313.05 |
| Pool + Cache + Autoscale | 2230.93 | 804.57 | 434.19 | 285.20 |

## Cache benchmark

- Miss total: 2.32 ms
- Hit total (5 reps): 1.38 ms
- Keys tested: 1000

- Cache getOrSetAsync dedupe total: 15.82 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10

- PowerMemoizer total: 16.80 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10
