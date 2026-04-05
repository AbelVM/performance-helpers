# Benchmark Results

Generated: 2026-04-05T22:19:02.524Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1587.59 ms
- Single-threaded avg per task: 1.59 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2337.31 | 2338.98 | 4.00 | 1.00 | 2.31 | 0.80 | 0.00 |
| 2 | 847.01 | 848.00 | 5.00 | 1.00 | 1.62 | 0.54 | 0.00 |
| 4 | 472.41 | 474.09 | 4.00 | 1.00 | 1.66 | 0.54 | 0.00 |
| 8 | 330.11 | 332.57 | 4.00 | 1.00 | 2.01 | 0.64 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1553.27 ms
- Single-threaded avg per task: 1.55 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2353.53 | 2354.42 | 8.00 | 0.00 | 2.32 | 1.15 | 0.00 |
| 2 | 837.29 | 838.50 | 5.00 | 0.00 | 1.60 | 0.65 | 0.00 |
| 4 | 434.40 | 435.58 | 3.00 | 0.00 | 1.60 | 0.65 | 0.00 |
| 8 | 323.14 | 325.06 | 5.00 | 0.00 | 1.93 | 0.82 | 0.00 |

## Cache benchmark
- Miss total: 3.66 ms
- Hit total (5 reps): 0.70 ms
- Keys tested: 1000