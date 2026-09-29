---
'performance-helpers': minor
---

Adds `observability: true` to the helpers that report stats.

Since 2.1.0 a helper can register its own `stats()` with a metrics collector,
so the three-line setup from the previous release is now one option:

```js
import { defaultMetrics } from 'performance-helpers/metrics';

const cache = new PowerCache({ observability: true });
const pool = new PowerPool(workerPath, { observability: true });

defaultMetrics.snapshot().series; // { 'cache.hitRate': …, 'pool.activeTasks': … }
```

Or pass your own collector, with an optional prefix so several processes' helpers
stay apart:

```js
const metrics = new MetricsCollector({ prefix: 'worker-3.' });
new PowerCache({ observability: metrics });
```

Available on `PowerCache`, `PowerPool`, `PowerBulkhead`, `PowerGCRA`,
`PowerEventLoopMonitor`, `PowerRealtimeHub`, `PowerSocketAdapter`,
`PowerWebSocketClient` and `PowerRetryBudget`.

**Off by default on every one of them**, so the common case allocates nothing
and no closure is created. Declared in each helper's options type, so a typo is a
type error rather than a silent no-op.

**`PowerRetry` deliberately does not respond.** It has no counters of its own —
the `PowerRetryBudget` it holds is the thing with numbers — and an always-zero
series would read as "this helper is idle", which is a different and wrong
claim. Use `new PowerRetryBudget({ observability: true })`.

**Helpers detach on teardown.** A disposed, stopped or terminated helper
removes its own registration, because a collector that keeps sampling a dead
helper is worse than one that never had it: `terminate()` on a pool still
answers `getStats()`, so a leaked registration keeps reporting a dead pool
forever and nothing fails visibly while the series quietly stops moving.
