# Benchmark Results

Generated: 2026-04-06T18:08:50.247Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1572.44 ms
- Single-threaded avg per task: 1.57 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2363.22 | 2365.07 | 5.00 | 1.00 | 2.34 | 0.86 | 0.00 |
| 2 | 828.68 | 829.74 | 4.00 | 1.00 | 1.61 | 0.51 | 0.00 |
| 4 | 442.71 | 444.38 | 3.00 | 1.00 | 1.64 | 0.51 | 0.00 |
| 8 | 332.40 | 335.13 | 5.00 | 1.00 | 1.98 | 0.64 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1555.75 ms
- Single-threaded avg per task: 1.56 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2297.07 | 2297.66 | 6.00 | 0.00 | 2.26 | 1.07 | 0.00 |
| 2 | 845.69 | 846.59 | 5.00 | 0.00 | 1.60 | 0.65 | 0.00 |
| 4 | 427.49 | 428.31 | 3.00 | 0.00 | 1.60 | 0.63 | 0.00 |
| 8 | 303.54 | 305.57 | 5.00 | 0.00 | 1.86 | 0.80 | 0.00 |

## Cache benchmark
- Miss total: 2.50 ms
- Hit total (5 reps): 1.18 ms
- Keys tested: 1000