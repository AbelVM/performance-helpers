# Benchmark Results

Generated: 2026-04-08T20:40:22.930Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1536.86 ms
- Single-threaded avg per task: 1.54 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2262.75 | 2264.51 | 5.00 | 1.00 | 2.23 | 0.81 | 0.00 |
| 2 | 828.18 | 829.06 | 4.00 | 1.00 | 1.60 | 0.53 | 0.00 |
| 4 | 453.65 | 455.23 | 4.00 | 1.00 | 1.65 | 0.56 | 0.00 |
| 8 | 308.94 | 311.66 | 4.00 | 1.00 | 1.90 | 0.64 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1528.51 ms
- Single-threaded avg per task: 1.53 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2236.75 | 2237.33 | 6.00 | 0.00 | 2.21 | 1.06 | 0.00 |
| 2 | 807.82 | 808.78 | 4.00 | 0.00 | 1.55 | 0.63 | 0.00 |
| 4 | 475.87 | 476.42 | 5.00 | 0.00 | 1.67 | 0.69 | 0.00 |
| 8 | 319.09 | 322.80 | 6.00 | 0.00 | 1.99 | 0.86 | 0.00 |

## Cache benchmark
- Miss total: 2.48 ms
- Hit total (5 reps): 0.72 ms
- Keys tested: 1000