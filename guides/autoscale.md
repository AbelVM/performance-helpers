# PowerPool Autoscaling

PowerPool supports an optional autoscaling mode to grow or shrink the worker pool based on recent observed task latency (EWMA) and queue pressure.

## Enabling

Pass an `autoScale` object in `PowerPool` options:

```js
import WorkerScript from './worker.js?worker&inline';

const pool = new PowerPool(WorkerScript, {
  size: 2,
  minSize: 1,
  maxSize: 8,
  // When autoscaling is enabled, the pool defaults to a soft worker capacity
  // of 1 task per worker unless `maxTasksPerWorker` is explicitly set.
  autoScale: {
    intervalMs: 1000,   // how often the pool evaluates scale decisions (ms)
    targetMs: 50,       // target latency (ms) the pool tries to maintain
    alpha: 0.2,         // EWMA smoothing factor (0..1)
    cooldownMs: 5000,   // minimum time between scale actions (ms)
    hysteresis: 0.2     // fractional hysteresis to avoid flapping (0..1)
  }
});
```

## How it works

- The pool maintains a pool-level EWMA (exponentially-weighted moving average) of recent task durations.
- Every `intervalMs` the pool evaluates whether to `add` or `remove` a single worker:
  - Scale up when EWMA > `targetMs * (1 + hysteresis)` or when queue length indicates sustained pressure.
  - Scale down when EWMA < `targetMs * (1 - hysteresis)` and the queue is empty.
- `cooldownMs` prevents repeated scaling decisions in rapid succession (debounce).

### New options (multi-step scaling & backoff)

- `stepUp` (number, default `1`): add up to `stepUp` workers in a single autoscale tick when scaling up.
- `stepDown` (number, default `1`): remove up to `stepDown` workers in a single autoscale tick when scaling down.
- `backoffFactor` (number, default `1`): multiplicative factor applied to the `cooldownMs` after each scale action to reduce oscillation. Values > 1 increase the cooldown multiplier.
- `backoffMaxMultiplier` (number, default `8`): upper bound for the backoff multiplier.
- `backoffResetMs` (ms, default `cooldownMs * 4`): time without scale actions after which the backoff multiplier resets to `1`.

## Tuning Recommendations

- `targetMs`: set to the latency you consider acceptable for a single task. If tasks are expected to be long (hundreds of ms), raise `targetMs` accordingly.
- `alpha`: lower values (e.g. 0.05) smooth the EWMA more and react slowly to spikes; higher values (e.g. 0.3) react faster but may be noisy.
- `cooldownMs`: prevents flapping. Start at 5s for many workloads, reduce to 1s for highly dynamic short-lived workloads.
- `hysteresis`: 0.1–0.3 is a sensible range to avoid oscillation.

### Multi-step scaling

- Use `stepUp` / `stepDown` when you want the pool to more rapidly change capacity in response to sustained pressure. For example, `stepUp: 3` allows the autoscaler to add up to 3 workers in one tick (bounded by `maxSize`).

### Backoff

- `backoffFactor` helps prevent repeated scale actions from quickly bouncing the pool size back and forth. After each scale event the effective cooldown is multiplied by `backoffFactor` (capped by `backoffMaxMultiplier`). The multiplier decays back to `1` after `backoffResetMs` without further scale actions.

Example: `autoScale: { intervalMs: 1000, targetMs: 20, cooldownMs: 1000, backoffFactor: 2, backoffMaxMultiplier: 8 }` will double the cooldown after a scale event (1s -> 2s), then 4s, up to 8x.

## Example: keep latency near 20ms

```js
const pool = new PowerPool(WorkerScript, {
  minSize: 1,
  maxSize: 16,
  autoScale: { intervalMs: 1000, targetMs: 20, alpha: 0.15, cooldownMs: 3000, hysteresis: 0.25 }
});

// Use pool as usual
pool.postMessage({ work: 'doit' });
```

## Notes & Limitations

- Autoscale may change multiple workers per tick when `stepUp`/`stepDown` are configured. If you need rapid scaling, reduce `intervalMs` but be mindful of `cooldownMs`, backoff, and system limits.
- Autoscale is heuristic: for best control consider combining with external metrics or custom scaling logic.
- The pool will never shrink below `minSize` or grow above `maxSize`.

For more advanced policies (e.g. multi-step scaling, predictive scaling, or integration with external metrics) consider implementing a custom controller that calls `pool._addWorkerInstance()` / `pool.terminate()` as appropriate (these are internal helpers; a public `resize()` API may be added later).