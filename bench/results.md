# Benchmark Results

Generated: 2026-04-04T23:52:13.285Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1580.84 ms
- Single-threaded avg per task: 1.58 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2278.05 | 2279.32 | 5.00 | 1.00 | 2.24 | 0.80 | 0.00 |
| 2 | 818.17 | 818.93 | 5.00 | 1.00 | 1.57 | 0.54 | 0.00 |
| 4 | 472.86 | 474.16 | 3.00 | 1.00 | 1.63 | 0.55 | 0.00 |
| 8 | 308.95 | 311.76 | 4.00 | 1.00 | 1.89 | 0.64 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1552.12 ms
- Single-threaded avg per task: 1.55 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2249.70 | 2250.30 | 5.00 | 0.00 | 2.22 | 1.06 | 0.00 |
| 2 | 829.78 | 830.99 | 4.00 | 0.00 | 1.58 | 0.67 | 0.00 |
| 4 | 498.43 | 499.48 | 5.00 | 0.00 | 1.76 | 0.76 | 0.00 |
| 8 | 293.85 | 296.81 | 4.00 | 0.00 | 1.83 | 0.77 | 0.00 |

## Cache benchmark
- Miss total: 2.51 ms
- Hit total (5 reps): 0.76 ms
- Keys tested: 1000