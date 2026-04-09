# Benchmark Results

Generated: 2026-04-09T21:18:25.831Z

## Configuration

- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark

- Single-threaded total: 1537.82 ms
- Single-threaded avg per task: 1.54 ms
- Worker-thread total: 2263.14 ms
- Worker-thread avg per task: 2.26 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2264.70 | 2265.54 | 4.81 | 1.47 | 2.24 | 0.72 | 0.00 |
| 2 | 808.11 | 809.13 | 3.44 | 1.48 | 1.57 | 0.13 | 0.00 |
| 4 | 422.33 | 423.41 | 2.84 | 1.49 | 1.58 | 0.09 | 0.00 |
| 8 | 315.73 | 318.91 | 4.10 | 1.49 | 1.90 | 0.42 | 0.00 |

## Variable-load benchmark
- Single-threaded total: 1507.12 ms
- Single-threaded avg per task: 1.51 ms
- Worker-thread total: 2231.42 ms
- Worker-thread avg per task: 2.23 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2226.45 | 2226.93 | 5.94 | 0.00 | 2.20 | 1.00 | 0.00 |
| 2 | 798.87 | 799.65 | 3.82 | 0.00 | 1.55 | 0.49 | 0.00 |
| 4 | 440.34 | 441.89 | 4.29 | 0.00 | 1.58 | 0.52 | 0.00 |
| 8 | 309.96 | 313.23 | 5.38 | 0.00 | 1.84 | 0.71 | 0.00 |

## Cache benchmark
- Miss total: 2.58 ms
- Hit total (5 reps): 1.69 ms
- Keys tested: 1000