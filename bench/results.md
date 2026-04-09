# Benchmark Results

Generated: 2026-04-09T19:07:44.613Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1589.53 ms
- Single-threaded avg per task: 1.59 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2298.36 | 2299.66 | 6.00 | 1.00 | 2.27 | 0.82 | 0.00 |
| 2 | 818.62 | 819.65 | 4.00 | 1.00 | 1.58 | 0.52 | 0.00 |
| 4 | 443.94 | 445.82 | 3.00 | 1.00 | 1.60 | 0.52 | 0.00 |
| 8 | 311.47 | 314.47 | 4.00 | 1.00 | 1.89 | 0.63 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1564.95 ms
- Single-threaded avg per task: 1.56 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2260.58 | 2261.15 | 5.00 | 0.00 | 2.24 | 1.06 | 0.00 |
| 2 | 811.55 | 812.46 | 4.00 | 0.00 | 1.56 | 0.62 | 0.00 |
| 4 | 435.81 | 436.58 | 5.00 | 0.00 | 1.57 | 0.64 | 0.00 |
| 8 | 311.62 | 313.39 | 5.00 | 0.00 | 1.85 | 0.78 | 0.00 |

## Cache benchmark
- Miss total: 2.79 ms
- Hit total (5 reps): 1.81 ms
- Keys tested: 1000