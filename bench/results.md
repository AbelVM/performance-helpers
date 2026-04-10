# Benchmark Results

Generated: 2026-04-10T10:25:11.767Z

## Configuration

- MODE: all
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8
- LOAD_PROFILES: 0% variable, 25% variable, 50% variable, 75% variable, 100% variable

Learn more about the benchmarks [here](bench/README.md)


## Load profile: 0% variable
- Single-threaded total: 1573.95 ms
- Worker-thread total: 2263.44 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2936.09 | 1025.56 | 564.29 | 392.10 |
| Pool + Autoscale | 2975.39 | 1028.57 | 539.40 | 348.80 |
| Pool + Cache | `25.83` | 27.91 | 29.27 | 32.91 |
| Pool + Cache + Autoscale | 28.05 | 37.48 | 28.00 | 29.18 |

## Load profile: 25% variable
- Single-threaded total: 1490.69 ms
- Worker-thread total: 2333.46 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2286.85 | 830.88 | 430.07 | 317.95 |
| Pool + Autoscale | 2390.09 | 818.27 | 439.92 | 276.81 |
| Pool + Cache | 426.55 | 231.40 | 139.37 | 115.98 |
| Pool + Cache + Autoscale | 455.53 | 240.30 | 137.10 | `105.08` |

## Load profile: 50% variable
- Single-threaded total: 1637.54 ms
- Worker-thread total: 2464.22 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2465.48 | 861.70 | 508.88 | 336.01 |
| Pool + Autoscale | 2475.24 | 875.91 | 489.64 | 307.81 |
| Pool + Cache | 854.22 | 458.85 | 254.49 | 187.08 |
| Pool + Cache + Autoscale | 864.79 | 441.73 | 252.23 | `160.34` |

## Load profile: 75% variable
- Single-threaded total: 1859.27 ms
- Worker-thread total: 2280.91 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2272.27 | 877.23 | 511.26 | 316.71 |
| Pool + Autoscale | 2279.06 | 810.55 | 450.99 | 276.58 |
| Pool + Cache | 1547.77 | 632.02 | 428.82 | 251.60 |
| Pool + Cache + Autoscale | 1548.55 | 626.82 | 361.50 | `229.68` |

## Load profile: 100% variable
- Single-threaded total: 1567.64 ms
- Worker-thread total: 2312.10 ms

| Pattern \ Pool size  | 1 | 2 | 4 | 8 |
| :--- | ---: | ---: | ---: | ---: |
| Pool | 2306.77 | 841.54 | 443.11 | 324.03 |
| Pool + Autoscale | 2340.40 | 890.85 | 447.43 | 279.50 |
| Pool + Cache | 2317.78 | 824.15 | 436.80 | 322.73 |
| Pool + Cache + Autoscale | 2315.57 | 828.55 | 495.60 | `277.06` |

## Cache benchmark

- Miss total: 3.25 ms
- Hit total (5 reps): 1.55 ms
- Keys tested: 1000

- Cache getOrSetAsync dedupe total: 16.30 ms
- Cache getOrSetAsync avg per task: 0.02 ms
- Cache getOrSetAsync duplicate keys: 10

- PowerMemoizer total: 16.07 ms
- PowerMemoizer avg per call: 0.02 ms
- PowerMemoizer duplicate keys: 10
