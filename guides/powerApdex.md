# PowerApdex

APDEX (Application Performance Index) scoring over three integer counters.

`PowerApdex` compresses a latency stream into one number in `[0, 1]`:

```
score = (satisfied + tolerating / 2) / total
```

A sample is **satisfied** at or below `target` (T), **tolerating** between `target` and `tolerance` (F), and **frustrated** above it. The convention is `F = 4T`, which is a convention and not a law — pass `tolerance` explicitly when your SLO says otherwise.

```sh
npm install performance-helpers/powerApdex
```

```js
import { PowerApdex } from 'performance-helpers/powerApdex';

const apdex = new PowerApdex({ target: 100 });

const started = nowMs();
await handle(request);
apdex.record(nowMs() - started);

apdex.score(); // 0..1
apdex.stats(); // { target, tolerance, satisfied, tolerating, frustrated, total, score }
```

## Constructor

| Option          |                   Type |      Default | Description                                                                                                    |
| --------------- | ---------------------: | -----------: | -------------------------------------------------------------------------------------------------------------- |
| `target`        |               `number` |   _required_ | The SLO, in the same unit `record()` takes. There is no default — see below.                                   |
| `tolerance`     |               `number` | `4 * target` | Upper bound of the tolerating class. Must be `>= target`.                                                      |
| `observability` | `boolean` or collector |      `false` | `true` registers in the shared collector, or pass your own `MetricsCollector`. See [`metrics.md`](metrics.md). |

`target` is required because there is no honest default. A guessed threshold scores against the wrong line and still looks like a real number, which is the failure this library refuses everywhere else. `0` is refused for the same reason: it is almost always an uninitialised variable, and it would silently frustrate every request.

A numeric string is accepted, the way every other duration option here accepts one — `'100'` from an environment variable is a reasonable thing to pass.

## API

- `record(ms)` — Record one completed request's latency. Returns `this`, so a stream of records chains. Throws `TypeError` for `NaN` and for a negative; accepts `+Infinity`, which lands in **frustrated**.
- `score()` — The score in `[0, 1]`, or `undefined` when nothing has been recorded. `undefined` rather than `0` and rather than `1`: an empty scorer has no score, and both of those read as a measurement.
- `merge(other)` — Add another scorer's counts. Exact, and requires the same `target` and `tolerance`.
- `reset()` / `clear()` — Zero the counts. The thresholds are configuration and survive.
- `stats()` / `getStats()` — Counters plus the thresholds they were taken against.
- `target`, `tolerance`, `satisfied`, `tolerating`, `frustrated`, `total` — Getters.
- `dispose()`, `[Symbol.dispose]()`, `[Symbol.asyncDispose]()` — Detach from metrics and zero the counts. A **state reset**, not a teardown: this helper owns no timer and no listener registry, so there is nothing to cancel. The interface exists so it takes part in `using` / `await using` like every other long-lived helper here.

## Why this is not derived from `PowerHistogram`

The obvious implementation is two rank queries over a sketch this library already ships. `PowerHistogram` answers `percentile(q)` — a value at a rank — and [`countAtOrBelow()`](powerHistogram.md#rank-queries-countatorbelow) is its inverse, a rank at a value. So a score is two calls and a division, with no new state at all.

It was built and measured, and it is wrong in the case that matters.

DDSketch bounds the **value** of a quantile to a relative error of `alpha`. It says nothing about the **rank** of a given value, and APDEX is a ratio of ranks taken at a threshold. Every sample in the bucket the threshold lands in is split by linear interpolation in log space, which is right when the mass is spread across that bucket and arbitrary when it is not.

`bench/claims.js apdex` scores the two against each other:

| Distribution                   |  Exact | Sketch | Delta (APDEX points) |
| ------------------------------ | -----: | -----: | -------------------: |
| lognormal, median at target    | 0.6117 | 0.6117 |                0.037 |
| bimodal, modes 10x apart       | 0.8000 | 0.8000 |                0.000 |
| pareto, heavy tail             | 0.9616 | 0.9617 |                0.025 |
| two-point, 90/10 in one bucket | 0.9500 | 0.6254 |          **324.583** |
| gaussian cluster in one bucket | 0.7503 | 0.6339 |          **116.411** |

The spread rows are excellent — under a twentieth of a point, below the resolution APDEX is quoted at. The clustered rows are not, and no value of `alpha` repairs them, because the mass is always placed inside one bucket. The error is not even monotonic in `alpha`: 0.665 points at `0.05`, 324 at `0.01`, 158 at `0.001`. It depends on where the threshold happens to fall inside the bucket, which is arbitrary, so a finer sketch is not a safer one.

The realistic version of the clustered case does not look adversarial. A service whose latency is a fixed cost, with the SLO set at that cost, puts a point mass exactly on the threshold — and a point mass at 100 ms is reported as roughly a quarter of itself, because the sketch cannot tell it from a spread across the bucket containing it.

A service operating at its own SLO boundary is exactly that distribution, which makes the derived score worst precisely where it is being watched. So this helper keeps three integers instead: exact, `O(1)` in memory, and measured at roughly a seventeenth of the per-sample cost of the sketch path.

The decision, and the rejected alternative, are recorded in [`adr/0014`](../adr/0014-apdex-counters-not-a-sketch.md).

## What a failed request is

Standard APDEX scores **completed** requests. A request that threw, or was aborted, is not a latency and has no place in the formula — count it in your error rate instead.

The one exception worth reaching for is a timeout you have already decided to treat as "as slow as possible": `record(Infinity)` lands in **frustrated**, which is the class it belongs to. It is counted in `total`, so it moves the score rather than being silently dropped from the denominator.

## What this cannot answer

APDEX is a score, not a distribution. It cannot tell you the p99, and it cannot tell you whether the tail moved or the whole curve shifted. If you want both, record into a [`PowerHistogram`](powerHistogram.md) as well — they answer different questions and neither substitutes for the other.

## Aggregating per-worker scorers

`merge()` is exact, so keep one scorer per worker or shard and fold them together for reporting:

```js
const perWorker = new Map();

pool.addEventListener('message', (e) => {
  const { workerId, durationMs } = e.data;
  let s = perWorker.get(workerId);
  if (!s) perWorker.set(workerId, (s = new PowerApdex({ target: 100 })));
  s.record(durationMs);
});

const fleet = new PowerApdex({ target: 100 });
for (const s of perWorker.values()) fleet.merge(s);
console.log('fleet apdex', fleet.score());
```

A threshold mismatch throws rather than averaging: counts taken against different thresholds are not the same measurement, and adding them produces a number that means nothing.

## Combining with other helpers

APDEX answers one question — "what share of requests met the SLO" — and it
answers it as a bounded ratio that saturates at `1.0`. That makes it a good
**gate** and a poor **control signal**, and the difference decides which helper
it belongs beside.

### Use it as a gate

A gate asks a yes/no question, and APDEX is exactly the right input for one:

```js
import { PowerApdex } from 'performance-helpers/powerApdex';
import { PowerBrownout } from 'performance-helpers/powerBrownout';

const apdex = new PowerApdex({ target: 100 });
const brownout = new PowerBrownout({ threshold: 0.9 });

// Every 60 s, shed optional work if the last window missed the SLO.
setInterval(() => {
  const score = apdex.score();
  brownout.setPressure(score !== undefined && score < 0.9 ? 1 : 0);
  apdex.reset();
}, 60_000);

if (brownout.allows('prefetch')) await prefetch();
```

`undefined` is handled explicitly rather than coerced: an empty window has no
score, and treating that as a miss would shed load from a service that has simply
not been called yet.

### Window it yourself

A cumulative-until-`reset()` scorer is a **lifetime** score, which is useless for
a live gate. Two instances and a periodic swap give you the last complete window
with no library support at all:

```js
let current = new PowerApdex({ target: 100 });
let previous = new PowerApdex({ target: 100 });

setInterval(() => {
  previous = current;
  current = new PowerApdex({ target: 100 });
}, 60_000);

// `previous.score()` is the last complete window; `current` is still filling.
```

### Score each route separately

One SLO rarely fits every endpoint, and a single blended score hides the route
that is actually failing:

```js
const perRoute = new Map();

function record(route, ms) {
  let a = perRoute.get(route);
  if (!a) perRoute.set(route, (a = new PowerApdex({ target: 100 })));
  a.record(ms);
}
```

### Record into a histogram as well

APDEX is a score, not a distribution. It cannot tell you the p99, and it cannot
tell you whether the tail moved or the whole curve shifted — so when you want
both, record into both:

```js
import { PowerHistogram } from 'performance-helpers/powerHistogram';

const apdex = new PowerApdex({ target: 100 });
const latency = new PowerHistogram({ relativeAccuracy: 0.01 });

function observe(ms) {
  apdex.record(ms);
  latency.record(ms);
}
```

## Do not use it as a control signal

This is the one thing not to do with `PowerApdex`, and it is worth stating
plainly because the obvious next step is the wrong one.

Every adaptive helper in this library takes a **signed, unbounded,
gradient-carrying** signal: `PowerServo` and `PowerFlowControl` are PID loops
over a `setpoint`, `PowerAdaptiveProposal.propose(signal)` reads a positive
signal as "decrease" and a negative one as "increase" with the _magnitude_
meaning how far to move, and `PowerPool`'s autoscale steers on an EWMA of task
latency in milliseconds.

APDEX is none of those things. It saturates at `1.0`, and at `1.0` it is blind:
when every request is under `target`, the distance to falling below `0.95` could
be 1% more load or 500% more load, and the score cannot tell them apart, because
the map from system state to APDEX is many-to-one and load-dependent. A
controller needs exactly that distinction — which is why the pool steers on
latency, which is monotonic in load and keeps moving.

So `score()` belongs on the **predicate** side of a decision ("are we meeting the
SLO?") and never on the **gradient** side ("how much should I adjust?"). If you
want an adaptive loop, feed it a latency percentile or a queue depth; if you want
to know whether to act at all, feed it `score()`.

## Metrics

With `observability: true` the scorer registers in the shared collector and reports its thresholds alongside its counts, so a series is never separated from the line it was measured against:

```js
const apdex = new PowerApdex({ target: 100, observability: true });
apdex.record(50);

defaultMetrics.snapshot().series;
// { 'apdex.target': 100, 'apdex.tolerance': 400, 'apdex.satisfied': 1,
//   'apdex.total': 1, 'apdex.score': 1 }
```

An unmeasured scorer reports `apdex.score` as `null` rather than dropping the key, so "no samples yet" is distinguishable from "scored zero".
