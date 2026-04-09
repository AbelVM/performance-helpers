# Benchmark Results

Generated: 2026-04-09T17:27:44.833Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1568.45 ms
- Single-threaded avg per task: 1.57 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2257.72 | 2259.45 | 4.00 | 1.00 | 2.23 | 0.79 | 0.00 |
| 2 | 806.05 | 807.21 | 4.00 | 1.00 | 1.56 | 0.52 | 0.00 |
| 4 | 478.48 | 481.14 | 4.00 | 1.00 | 1.73 | 0.59 | 0.00 |
| 8 | 316.29 | 319.73 | 5.00 | 1.00 | 1.92 | 0.67 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1588.83 ms
- Single-threaded avg per task: 1.59 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2335.77 | 2336.30 | 7.00 | 0.00 | 2.31 | 1.09 | 0.00 |
| 2 | 854.41 | 855.16 | 5.00 | 0.00 | 1.63 | 0.68 | 0.00 |
| 4 | 431.45 | 432.48 | 3.00 | 0.00 | 1.59 | 0.60 | 0.00 |
| 8 | 317.71 | 319.73 | 5.00 | 0.00 | 1.91 | 0.79 | 0.00 |

## Cache benchmark
- Miss total: 3.40 ms
- Hit total (5 reps): 1.98 ms
- Keys tested: 1000