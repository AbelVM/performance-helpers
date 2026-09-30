[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / defaultMetrics

# Variable: defaultMetrics

> `const` **defaultMetrics**: [`MetricsCollector`](../classes/MetricsCollector.md)

A process-wide collector, used by `observability: true`.

Deliberately shared rather than per-helper: a caller who opts nine helpers
in wants nine series in _one_ snapshot, not nine snapshots they have to
merge. The default is off everywhere, so a process that never asks for this
never allocates a collector or a closure.
