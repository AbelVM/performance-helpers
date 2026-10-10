# Observability

Helpers that tell you what your process is actually doing, rather than what you asked it to do.

- [PowerEventLoopMonitor: Event-loop delay and utilization](../guides/powerEventLoopMonitor.md). Timer-drift histogram (fed to `PowerHistogram`) plus Node's `eventLoopUtilization()`, so a latency regression can be attributed to the host rather than guessed at. Its `stats()` also reports the milliseconds blocked beside the count of blocked ticks, the readings it refused, and the share of wall-clock time it actually sampled — so a period it was not running is visible.
- [PowerLogger: Gated logging](../guides/powerLogger.md). Runtime debug gate and in-memory counters, useful for pairing with the above.
- [PowerHistogram: Percentile estimates](../guides/powerHistogram.md). Lock-free DDSketch; the sketch behind most of these numbers, and usable on its own for latency telemetry.
- [PowerApdex: SLO attainment scoring](../guides/powerApdex.md). One number in `[0, 1]` from three integer counters — not derived from a histogram, because `bench/claims.js apdex` measures the derived version reading 0.625 where the truth is 0.950 when the mass sits at the threshold.
- [Metrics: A stable shape over the numbers above](../guides/metrics.md). A versioned, flat snapshot of any helper's `stats()` — `cache.hitRate` beside `loop.p99` without knowing which helper produced either. `createObservation()` adds sampling metadata and `diffObservation()` computes guarded numeric deltas. Adds no counters; every number it reports already exists.
- [Stats naming](../guides/stats-naming.md). Use canonical `stats()` methods, understand the `getStats()` compatibility alias, and check which helpers support each spelling.
