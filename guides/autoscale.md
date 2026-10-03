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
    intervalMs: 1000, // how often the pool evaluates scale decisions (ms)
    targetMs: 50, // target latency (ms) the pool tries to maintain
    alpha: 0.2, // EWMA smoothing factor (0..1)
    cooldownMs: 5000, // minimum time between scale actions (ms)
    hysteresis: 0.2, // fractional hysteresis to avoid flapping (0..1)
  },
});
```

## How it works

- The pool maintains a pool-level EWMA (exponentially-weighted moving average) of recent task durations.
- Every `intervalMs` the pool evaluates whether to `add` or `remove` a single worker:
  - Scale up when EWMA > `targetMs * (1 + hysteresis)` or when queue length indicates sustained pressure.
  - Scale down when EWMA < `targetMs * (1 - hysteresis)` and the queue is empty.
- `cooldownMs` prevents repeated scaling decisions in rapid succession (debounce).

### Concurrency policies (`policy`)

### How big a step

The **direction** is a heuristic — one EWMA compared against a fixed `targetMs`,
with a hysteresis band and a queue-pressure check. The **size** of the step is
closed-loop. `PowerServo` runs a PI controller on the relative error
(`ewma / targetMs`, against a setpoint of `1`), so the further over target the
pool is, the more of `stepUp` it adds in one tick; and the integral term is what
converges the last stretch, which a fixed step cannot do.

Two consequences worth knowing:

- **At the default `stepUp: 1` nothing changes.** A ceiling of one worker is one
  worker whatever the controller says, and the controller is not even constructed.
  Raise `stepUp` above `1` to let the error decide how much of that budget to use.
- **The integral is dropped whenever a tick decides to do nothing**, so a burst's
  accumulated error is not paid back during the next quiet period, and it is
  clamped to the ceiling so a long overshoot cannot exceed `stepUp`.

What the controller does _not_ do is change when the pool scales. The hysteresis
band, the queue-pressure check, the cooldown and the backoff multiplier are all
untouched — this sizes an action that has already been decided on, it does not
decide one.

`autoScale.policy` is a separate and different mechanism: it swaps in a
concurrency-window controller whose limit is **reported and not enforced** (see
below).

| policy        | signal it steers on                                                                     |
| ------------- | --------------------------------------------------------------------------------------- |
| `'ewma'`      | _(default)_ none. Worker-count scaling only, as described above.                        |
| `'aimd'`      | Short RTT rising above the long-window RTT — additive increase, `aimdBeta` cut.         |
| `'vegas'`     | `limit * (1 - minRtt / currentRtt)` — an estimate of the bottleneck queue.              |
| `'gradient2'` | Ratio of long-window to short-window RTT, held between `0.5` and `1`, plus queue depth. |

**None of these is enforced.** The limit they compute is published as `getStats().performance.concurrencyLimit` and read by nothing on the dispatch path, so they change what that field _says_ and nothing else.

```js
autoScale: { policy: 'gradient2', limitMin: 1, limitMax: 16, longWindowAlpha: 0.05 }
```

Two things to know before choosing one:

- **`'ewma'` is the default and it is not a controller.** It reads like one, and
  `concurrencyLimit` in `getStats().performance` is `null` for exactly that
  reason. Leaving the option alone gets you worker-count scaling and no
  concurrency control.
- **None of the four is enforced, including the other three.** The limit they
  compute is written and then read by `getStats()` — nothing on the dispatch path
  reads it, so they change what `concurrencyLimit` _reports_ and nothing else.
  Measured: indistinguishable throughput across the four policies, and applying
  the limit to a real gate measured **−3.7 %** against the best hand-picked
  constant cap. Treat `policy` as a reported diagnostic for now, not as a
  concurrency limit.
- **The signal is end-to-end task latency, while Netflix's controllers track
  queueing delay.** The two are the same only for a uniform workload. On a pool
  whose tasks vary in cost, a heavier task looks to `vegas` and `aimd` like
  queueing appeared, and the controller cuts concurrency for work that was merely
  expensive. Uniform-cost workloads are the case these were written for.

Full option list and observability fields: [pool guide → Adaptive concurrency
policies](powerPool.md#adaptive-concurrency-policies). `PowerBackpressure`'s
adaptive refill is a different loop on a different signal, and the two are not
interchangeable — it is loss-based because a permit gate has no round trip to
measure.

### New options (multi-step scaling & backoff)

- `stepUp` (number, default `1`): **ceiling** on workers added per tick. The step is sized by the controller above, so this is the most it will add in one tick, not what it always adds. `1` reproduces fixed-step behaviour.
- `stepDown` (number, default `1`): ceiling on workers removed per tick, sized the same way.
- `backoffFactor` (number, default `1`): multiplicative factor applied to the `cooldownMs` after each scale action to reduce oscillation. Values > 1 increase the cooldown multiplier.
- `backoffMaxMultiplier` (number, default `8`): upper bound for the backoff multiplier.
- `backoffResetMs` (ms, default `cooldownMs * 4`): time without scale actions after which the backoff multiplier resets to `1`.

## Tuning Recommendations

- `targetMs`: set to the latency you consider acceptable for a single task. If tasks are expected to be long (hundreds of ms), raise `targetMs` accordingly.
- `alpha`: lower values (e.g. 0.05) smooth the EWMA more and react slowly to spikes; higher values (e.g. 0.3) react faster but may be noisy.
- `cooldownMs`: prevents flapping. Start at 5s for many workloads, reduce to 1s for highly dynamic short-lived workloads.
- `hysteresis`: 0.1–0.3 is a sensible range to avoid oscillation.

### Multi-step scaling

- Use `stepUp` / `stepDown` when you want the pool to more rapidly change capacity in response to sustained pressure. `stepUp: 3` lets the autoscaler add **up to** 3 workers in one tick (bounded by `maxSize`); how many of those 3 it actually uses depends on how far over `targetMs` the pool is, so a marginal overshoot still adds one and a large one adds three.

### Backoff

- `backoffFactor` helps prevent repeated scale actions from quickly bouncing the pool size back and forth. After each scale event the effective cooldown is multiplied by `backoffFactor` (capped by `backoffMaxMultiplier`). The multiplier decays back to `1` after `backoffResetMs` without further scale actions.

Example: `autoScale: { intervalMs: 1000, targetMs: 20, cooldownMs: 1000, backoffFactor: 2, backoffMaxMultiplier: 8 }` will double the cooldown after a scale event (1s -> 2s), then 4s, up to 8x.

## Example: keep latency near 20ms

```js
const pool = new PowerPool(WorkerScript, {
  minSize: 1,
  maxSize: 16,
  autoScale: { intervalMs: 1000, targetMs: 20, alpha: 0.15, cooldownMs: 3000, hysteresis: 0.25 },
});

// Use pool as usual
pool.postMessage({ work: 'doit' });
```

## Notes & Limitations

- Autoscale may change multiple workers per tick when `stepUp`/`stepDown` are configured. If you need rapid scaling, reduce `intervalMs` but be mindful of `cooldownMs`, backoff, and system limits.
- Autoscale is heuristic: for best control consider combining with external metrics or custom scaling logic.
- The pool will never shrink below `minSize` or grow above `maxSize`.

For anything beyond that — predictive scaling, or a controller driven by a metric this pool does not measure — implement a custom controller that calls `pool._addWorkerInstance()` / `pool.terminate()` as appropriate (these are internal helpers; a public `resize()` API may be added later). Check `autoScale.policy` first, though: three of its four values are already feedback loops, and reaching for private methods before trying them skips the supported path.
