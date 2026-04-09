# Benchmark Results

Generated: 2026-04-09T21:25:02.334Z

## Configuration

- TASKS: 1000
- ITERS: 1000000
- POOL_SIZES: 1, 2, 4, 8

## Constant-load benchmark

- Single-threaded total: 1512.90 ms
- Single-threaded avg per task: 1.51 ms
- Worker-thread total: 2292.01 ms
- Worker-thread avg per task: 2.29 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2296.65 | 2297.51 | 5.01 | 1.47 | 2.27 | 0.75 | 0.00 |
| 2 | 803.35 | 805.00 | 3.83 | 1.47 | 1.56 | 0.16 | 0.00 |
| 4 | 428.96 | 430.90 | 3.64 | 1.49 | 1.59 | 0.17 | 0.00 |
| 8 | 311.78 | 315.09 | 5.17 | 1.48 | 1.92 | 0.45 | 0.00 |

## Variable-load benchmark

- Single-threaded total: 1552.28 ms
- Single-threaded avg per task: 1.55 ms
- Worker-thread total: 2321.68 ms
- Worker-thread avg per task: 2.32 ms

| Pool Size | T Total | T Pool | T Max | T Min | T Avg | T Std | % Slow |
| ----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| 1 | 2324.11 | 2324.45 | 6.61 | 0.22 | 2.29 | 1.04 | 0.00 |
| 2 | 836.36 | 836.98 | 3.75 | 0.10 | 1.61 | 0.50 | 0.00 |
| 4 | 436.35 | 437.77 | 3.69 | 0.12 | 1.59 | 0.48 | 0.00 |
| 8 | 337.18 | 339.50 | 4.86 | 0.12 | 1.98 | 0.73 | 0.00 |

## Cache benchmark

- Miss total: 3.65 ms
- Hit total (5 reps): 1.71 ms
- Keys tested: 1000
