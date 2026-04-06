# Benchmark Results

Generated: 2026-04-06T11:14:34.893Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1552.51 ms
- Single-threaded avg per task: 1.55 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2278.49 | 2280.37 | 4.00 | 1.00 | 2.26 | 0.78 | 0.00 |
| 2 | 849.11 | 850.22 | 4.00 | 1.00 | 1.62 | 0.54 | 0.00 |
| 4 | 455.82 | 458.00 | 4.00 | 1.00 | 1.68 | 0.56 | 0.00 |
| 8 | 305.60 | 310.03 | 4.00 | 1.00 | 1.96 | 0.62 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1542.19 ms
- Single-threaded avg per task: 1.54 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2275.05 | 2275.78 | 6.00 | 0.00 | 2.25 | 1.06 | 0.00 |
| 2 | 840.55 | 841.99 | 5.00 | 0.00 | 1.61 | 0.64 | 0.00 |
| 4 | 457.56 | 458.71 | 4.00 | 0.00 | 1.66 | 0.69 | 0.00 |
| 8 | 324.33 | 327.76 | 5.00 | 0.00 | 2.01 | 0.85 | 0.00 |

## Cache benchmark
- Miss total: 3.29 ms
- Hit total (5 reps): 1.09 ms
- Keys tested: 1000