---
'performance-helpers': minor
---

Adds `performance-helpers/metrics`: a stable, versioned shape over the numbers
the helpers already report.

Every helper that reports anything does it through its own `stats()`, and those
shapes are not merely different — they are different _kinds_ of thing. A
`PowerCache` reports counters. A `PowerGCRA` reports mostly _configuration_
(`rate`, `per`, `burst`) plus one state variable. An `PowerEventLoopMonitor`
reports measurements. A `PowerPool` carries a _nested array_ of per-worker
objects. Plotting cache hit rate beside event-loop p99 means knowing all of
that, and re-learning it whenever a helper's internals move.

```js
import { MetricsCollector } from 'performance-helpers/metrics';

const metrics = new MetricsCollector();
metrics.register('cache', () => cache.stats());
metrics.register('pool', () => pool.getStats());

const { version, collectedAt, series } = metrics.snapshot();
series['cache.hitRate'];
series['pool.activeTasks'];
```

Three rules make a flat `series` map work across all four shapes, and each is a
decision rather than an implementation detail:

- **`null` is kept**, so "never called" and "not reported" stay distinguishable.
- **Arrays are omitted.** Joining them would put an unbounded number of series
  in the map; per-worker detail stays on `pool.getStats()`.
- **`Infinity` and `NaN` become strings.** `Infinity` is how a rate limit says
  "unlimited", and coercing it to 0 would read as a measurement.

Snapshotting is explicit and pull-based — a sink that fires on every operation
becomes a performance problem, and one that samples on a timer is a timer you
cannot turn off. A source that throws is recorded under `errors` and the rest is
still collected.

**This adds no counters.** Every number reported already exists in some
`stats()`; the module supplies a shape, and a second source of truth would
drift from the first.

Not included: an `observability: true` option on the individual helpers. There
are nine helpers with `stats()`, and shipping that option for a subset would
make `observability: true` mean three different things depending on which helper
you passed it to. Until it lands for all nine, register sources yourself.
