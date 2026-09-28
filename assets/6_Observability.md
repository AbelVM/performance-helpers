# Observability

Helpers that tell you what your process is actually doing, rather than what you asked it to do.

- [PowerEventLoopMonitor: Event-loop delay and utilization](../guides/powerEventLoopMonitor.md). Timer-drift histogram (fed to `PowerHistogram`) plus Node's `eventLoopUtilization()`, so a latency regression can be attributed to the host rather than guessed at.
- [PowerLogger: Gated logging](../guides/powerLogger.md). Runtime debug gate and in-memory counters, useful for pairing with the above.
- [PowerHistogram: Percentile estimates](../guides/powerHistogram.md). Lock-free DDSketch; the sketch behind most of these numbers, and usable on its own for latency telemetry.
