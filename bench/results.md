# Benchmark Results

Generated: 2026-04-05T12:33:09.094Z

## Configuration
- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark
- Single-threaded total: 1563.23 ms
- Single-threaded avg per task: 1.56 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2287.80 | 2289.25 | 6.00 | 1.00 | 2.27 | 0.80 | 0.00 |
| 2 | 828.95 | 830.25 | 5.00 | 1.00 | 1.59 | 0.53 | 0.00 |
| 4 | 445.19 | 446.53 | 3.00 | 1.00 | 1.61 | 0.52 | 0.00 |
| 8 | 325.85 | 327.87 | 4.00 | 1.00 | 1.99 | 0.64 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1580.00 ms
- Single-threaded avg per task: 1.58 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2255.56 | 2256.13 | 6.00 | 0.00 | 2.23 | 1.07 | 0.00 |
| 2 | 808.90 | 810.08 | 5.00 | 0.00 | 1.57 | 0.65 | 0.00 |
| 4 | 442.04 | 443.14 | 5.00 | 0.00 | 1.58 | 0.65 | 0.00 |
| 8 | 320.57 | 323.51 | 6.00 | 0.00 | 1.93 | 0.85 | 0.00 |

## Cache benchmark
- Miss total: 3.05 ms
- Hit total (5 reps): 0.80 ms
- Keys tested: 1000