# PowerEventLoopMonitor

Event-loop delay histogram, plus Node's `eventLoopUtilization()` when the runtime has it.

## Why you need it

Every latency number in this library is a measurement of _your_ operation. None of them can tell you whether the host was busy while it was measured. A `PowerCache.get()` that goes from 0.1 ms to 40 ms looks identical whether the cache regressed or something else took the thread for 40 ms — and the fix is completely different.

`PowerEventLoopMonitor` measures the second thing directly.

## How the measurement works

Timer drift. A probe is scheduled `intervalMs` into the future; when it actually runs, the gap is the event loop having been unavailable.

```
scheduledFor = now() + intervalMs
setTimeout(() => record(now() - scheduledFor), intervalMs)
```

This is the technique Node's own diagnostics use, and it catches the case that matters most — a synchronous block — because the timer simply cannot fire until the block finishes. What it deliberately does **not** tell you is _which_ code blocked; for that you want `async_hooks`, a profile, or `--cpu-prof`.

Two consequences worth internalising:

- **You are sampling a maximum, not an average.** `intervalMs: 20` means "the worst block that happened between two probes 20 ms apart", capped by the interval itself. Shorter intervals catch shorter blocks and cost more.
- **The readings are estimates.** `p99` comes from a [DDSketch](powerHistogram.md) with a `relativeAccuracy` bound, not from sorting raw samples. `max`, `mean` and `last` are exact.

## Constructor

| Option                |               Type | Default | Description                                                                                                                             |
| --------------------- | -----------------: | ------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| `intervalMs`          |           `number` |    `20` | Probe period. Must be a finite number `>= 1`.                                                                                           |
| `relativeAccuracy`    |           `number` |  `0.01` | Target relative error for the drift histogram's quantiles. Forwarded to `PowerHistogram`.                                               |
| `onDrift`             | `function`\|`null` |  `null` | Called with each sample in ms, for hook-based alerting. A throwing hook is swallowed.                                                   |
| `keepProcessAlive`    |          `boolean` | `false` | The internal timer is `unref()`d by default, so a monitor you forget to dispose cannot hang a CLI. Set `true` to hold the process open. |
| `utilizationProvider` | `function`\|`null` |  `null` | Supplies `utilization()` instead of resolving Node's `perf_hooks`. See below.                                                           |

## API

- `start()` / `stop()` — Begin and end sampling. Both are idempotent, both return `this`. `stop()` keeps recorded history, so a stop/start cycle does not lose it.
- `reset()` — Clear all samples without stopping. Use this when you want percentiles over the last window rather than since start.
- `histogram()` — The underlying `PowerHistogram`. Treat it as owned: `reset()` the monitor, not the histogram, or the two will disagree.
- `lastDelay()` — The most recent sample in ms, `0` before the first.
- `stats()` — Serializable snapshot, below.
- `utilization()` — Node's `eventLoopUtilization()` **cumulative** reading, or `null`.
- `utilizationSince(previous)` — the same reading as a **delta** over an interval, or `null`. See below.
- `dispose()` / `[Symbol.dispose]` — Stop sampling and release the timer. `dispose()` is safe to call twice.

## `stats()`

```js
{
  active: true,          // currently sampling
  intervalMs: 20,
  samples: 248,          // probes that have completed
  last: 1.8,             // ms
  max: 63.4,             // ms, exact
  mean: 2.1,             // ms, exact
  p50: 0.7,              // ms, estimated
  p99: 41.2,             // ms, estimated
  p99_9: 61.0,           // ms, estimated
  blockedOver10ms: 3,    // count, not a rate
}
```

`mean`, `p50`, `p99` and `p99_9` are **`null` before the first sample**, not `0`, so a consumer cannot mistake "not measured yet" for "no delay". `blockedOver10ms` is a count rather than a verdict because the threshold that matters is workload-specific.

## `utilization()`

```js
const m = new PowerEventLoopMonitor();
await m.ready;
const u = m.utilization(); // { active, idle, utilization } on Node >= 14.5
```

Returns `null` where the runtime cannot measure it. **`null` is a real answer, not a zero** — reporting `0` outside Node would read as a perfectly idle loop, which is a claim the runtime cannot support.

Node's built-in is resolved through an **opaque dynamic import** (`new Function('return import("node:perf_hooks")')()`), so a bundler never tries to resolve a Node built-in for a browser build. `m.ready` resolves once that lookup settles and never rejects.

To supply the reading yourself — a browser measurement, a shim, or a test double — pass `utilizationProvider`. A provider that throws yields `null` rather than taking the monitor down; the drift histogram is the primary output and does not depend on it.

**That reading is cumulative.** `active` and `idle` grow for the life of the process, so `utilization()` answers _"how busy has this process been since it started"_ — a lifetime average that barely moves. What makes the built-in worth reaching for is that it is **defined over a measured interval**, and you subtract two readings to get that.

## `utilizationSince(previous)`

```js
const m = new PowerEventLoopMonitor();
await m.ready;

let mark = m.utilization();
setInterval(() => {
  const w = m.utilizationSince(mark);
  mark = m.utilization();
  if (w && w.active > 100) console.warn('blocked for', w.active.toFixed(0), 'ms');
}, 1000);
```

Returns `{ active, idle, utilization, ratio, elapsed }` for the interval, or `null` when there is no previous reading, the runtime cannot measure, or the counters went backwards (a replaced provider, a reset process) — a negative interval would read as a large stall in the other direction.

`ratio` is `active / elapsed`, and is `0` rather than `NaN` for an empty interval, so a caller polling faster than the loop ticks does not poison every comparison.

**Why the interval is not a nicety.** Measured on this machine:

| What happened                  | `utilizationSince` delta                       |
| ------------------------------ | ---------------------------------------------- |
| 1 s of synchronous blocking    | `active` +1000 ms, `idle` +20 ms → ratio 0.98  |
| 200 ms of awaiting a timer     | `active` +0.3 ms, `idle` +200 ms → ratio 0.001 |
| 300 ms of synchronous blocking | `active` +300 ms, `idle` +20 ms → ratio 0.94   |

A cumulative reading reports the same lifetime average for all three. And the
sensitivity is not academic: the _same_ 500 ms block read at a different moment in
the process's life reported **+0.2 ms** of active time, because ELU's counters are
refreshed by the loop and a reading taken at the wrong moment misses the interval
entirely. Handing back a cumulative number and hoping callers space their reads is
how that goes wrong.

**The two outputs answer different questions and both are worth having.** The
histogram is the percentile layer the platform does not provide, and a stall large
enough to starve the timer is precisely the case only one of the two can see.

## Example: alerting on a blocked loop

```js
import { PowerEventLoopMonitor } from 'performance-helpers/powerEventLoopMonitor';

const monitor = new PowerEventLoopMonitor({
  intervalMs: 20,
  onDrift: (drift) => {
    if (drift > 100) metrics.increment('eventloop.blocked', { ms: Math.round(drift) });
  },
});

monitor.start();

// elsewhere, on a metrics scrape interval
setInterval(() => {
  const s = monitor.stats();
  metrics.gauge('eventloop.p99', s.p99 ?? 0);
  metrics.gauge('eventloop.max', s.max);
}, 15_000);
```

## Using it with `using`

```js
{
  using monitor = new PowerEventLoopMonitor({ intervalMs: 20 });
  monitor.start();
  await runWorkload();
  console.log(monitor.stats().p99);
} // disposed here, timer released
```

## Notes and limits

- **A negative reading is dropped, not recorded.** A backwards clock step (NTP correction, a suspended laptop) would otherwise poison the histogram's invariants. The gap goes unreported rather than being reported wrong.
- **Memory is bounded by the number of _distinct_ drift values, not by sample count.** `PowerHistogram` is a sparse DDSketch, so a long-running monitor with a stable delay allocates a stable number of buckets. There is no cap option because none is needed.
- **This is not a profiler.** It answers "was the loop blocked, and how long for". It cannot tell you which code blocked it.
- **Zero dependencies, both runtimes.** Nothing Node-specific is imported unless you ask for it, and the monitor works in a browser or a worker with `utilization()` returning `null`.

## See also

- [`PowerHistogram`](powerHistogram.md) — the sketch behind the quantiles.
- [`PowerLogger`](powerLogger.md) — gated logging and in-memory counters, for pairing with these numbers.
- [`now`](now.md) — the clock both use.
