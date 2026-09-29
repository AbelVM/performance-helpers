# Metrics

A stable shape over the numbers the helpers already report.

Every helper that reports anything does it through its own `stats()`, and those
shapes are not merely different — they are different _kinds_ of thing:

| Helper                  | What `stats()` is                                                                 |
| ----------------------- | --------------------------------------------------------------------------------- |
| `PowerCache`            | counters (`hits`, `misses`, `evictions`)                                          |
| `PowerGCRA`             | mostly **configuration** (`rate`, `per`, `burst`) plus one state variable (`tat`) |
| `PowerEventLoopMonitor` | **measurements** (`mean`, `p99`, `max`)                                           |
| `PowerPool`             | counters **plus a nested array** of per-worker objects                            |

Plotting "cache hit rate" beside "event-loop p99" means knowing all of that,
and re-learning it whenever a helper's internals move. This module is the
stable name for those numbers.

```sh
npm install performance-helpers/metrics
```

## It adds no counters

Every number reported here already exists in some helper's `stats()`. The job is
a **shape**, not a measurement — a second source of truth would drift from the
first, and the drift is invisible until a dashboard is quietly wrong.

```js
import { MetricsCollector } from 'performance-helpers/metrics';

const cache = new PowerCache();
const pool = new PowerPool(workerPath);

const metrics = new MetricsCollector();
metrics.register('cache', () => cache.stats());
metrics.register('pool', () => pool.getStats());

const { version, collectedAt, series } = metrics.snapshot();

series['cache.hitRate']; // 0.97
series['pool.activeTasks'];
series['cache.timePerTask.p99'];
```

## The snapshot

```js
{
  version: 1,          // bump when the *shape* changes, not when a key is added
  collectedAt: 1756…,  // Date.now() at collection
  sources: ['cache', 'pool'],
  series: { 'cache.size': 412, 'cache.hitRate': 0.97, … },
  errors: {},          // a source that threw, by name
}
```

`snapshot()` is explicit and pull-based. A sink that fires on every operation
becomes a performance problem, and a timer that does it for you is one you
cannot turn off. **You** decide how often to sample, which is also what lets one
collector cover a pool sampled every request and a cache sampled every minute.

## Flat keys, and what that costs

`series` is a flat map of scalars, so `cache.hitRate` and `loop.p99` are
addressable without knowing which helper produced them. Two consequences worth
knowing before you rely on it:

- **Arrays are omitted.** `getStats().status` is one entry per worker; joining
  it into a key would put an unbounded number of series in the map, and
  collapsing it would hide the detail you came for. Per-worker data stays on
  `pool.getStats()`.
- **`null` is kept, not dropped.** `gcra.tat` is null until the first call, and
  "never called" must not look like "not reported".
- **`Infinity` and `NaN` become strings.** `Infinity` is how a rate limit says
  "unlimited"; coercing it to 0 would read as a measurement.

## Errors do not blank the sink

A source that throws is recorded under `errors` and the rest is still
collected. A metrics sink that goes blank because one helper misbehaved is
worse than one missing exactly the broken thing.

```js
const { series, errors } = metrics.snapshot();
if (errors.cache) console.warn('cache stats failed:', errors.cache);
// series still has pool.*
```

## What is not here yet

`observability: true` on the individual helpers — one option that wires a helper
into a collector for you. It is deliberately not in this release: there are
nine helpers with `stats()`, and shipping the option for a subset would make
`observability: true` mean three different things depending on which helper you
passed it to. Until it lands for all nine, register the sources yourself; that
is three lines, and it keeps the sampling decision yours.

## See also

- [`powerPool.md`](powerPool.md) — `getStats()` in full
- [`powerCache.md`](powerCache.md) — the counters this flattens
- [`metaGuide.md`](metaGuide.md) — picking a helper
