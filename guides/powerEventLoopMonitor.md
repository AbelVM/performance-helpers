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
  blockedMs: 1432.0,     // ms — the same ticks, weighed
  eventLoopPressure: 0.012, // fraction of observed probes over 10 ms
  droppedSamples: 0,     // readings refused: the clock moved backwards
  coverage: 0.041,       // fraction of wall-clock time this schedule accounts for
}
```

`mean`, `p50`, `p99` and `p99_9` are **`null` before the first sample**, not `0`, so a consumer cannot mistake "not measured yet" for "no delay". `blockedOver10ms` is a count rather than a verdict because the threshold that matters is workload-specific. `eventLoopPressure` is a bounded fraction from `0` to `1`; it is `0` before the first sample and counts only probes delayed beyond 10 ms.

### The three fields that describe what the monitor did _not_ see

Everything above is derived from samples that **fired**. That is the right thing to
measure, and it has one blind spot: time during which no probe ran at all. If the
monitor was stopped, never started, or the process was suspended past the timer, no
tick fires — so no drift is recorded, and the gap leaves no trace in `max`, `p99` or
either blocked field. These three fields are about that gap, and about the readings
the monitor refused outright.

#### `blockedMs` — the same ticks, weighed

A 30 s stall and a 12 ms hiccup are **both** `blockedOver10ms: 1`. The count is the
right shape for an alert _rate_ and the wrong shape for _severity_, which is the
question being asked when a loop is already in trouble. `blockedMs` is the same
population in milliseconds — `1432.0` above is those three ticks totalling 1.43 s. Read
the pair together: one is how _often_, the other is how _badly_.

Both come off a single `drift > 10` comparison, so they cannot drift apart onto
different thresholds.

#### `droppedSamples` — readings the clock refused

A drift reading of `-1` or `NaN` — NTP correction, a suspended laptop — is **dropped
rather than recorded**, because a negative sample would poison the histogram's
invariants. But a dropped sample is still an event, and an event with no counter is
indistinguishable from an event that did not happen. Non-zero means the drift figures
on this monitor came from a clock that was adjusted underneath them, which is worth
knowing before you trust a percentile.

A refused reading is not passed to `onDrift` either: a negative drift delivered to an
alerting hook would read as "the loop is 1 ms _ahead_", which is not a thing a loop does.

#### `coverage` — the only field that notices an unobserved gap

`coverage` is the fraction of wall-clock time since the monitor started that its own
sampling schedule accounts for: `((samples - 1) * intervalMs + totalDrift) / elapsed`.
It is the one number here that moves when time passed unobserved.

**Read it as a resolution statement, not a health statement.** It is a lifetime figure
and it trends _down_: a monitor at `intervalMs: 10` that has run for an hour covers
0.03 of it, and a loop that was perfectly responsive the whole time scores the same as
one that stalled for two minutes and recovered — because a stall _is_ accounted for,
the drift that produced it is in the numerator. So do not alert on it directly. It
answers a narrower and more useful question — _is my sampling resolution fine enough to
see what is happening to this process?_ — and a low figure is the honest answer to that.

What it is _for_ is the blind spot above, and there it is a drop rather than a ratio:

```js
import { PowerEventLoopMonitor } from 'performance-helpers/powerEventLoopMonitor';
import { MetricsCollector } from 'performance-helpers/metrics';

const monitor = new PowerEventLoopMonitor({ intervalMs: 20 });
const metrics = new MetricsCollector();

const s = monitor.stats();
if (s.coverage !== null && s.coverage < 0.5) {
  // A quarter of the wall clock went unsampled. Nothing else in this object can
  // tell you that: the sample count and the maximum are both unchanged.
  metrics.register('eventloop.coverage', () => s.coverage);
}
```

It is `null` rather than a number in three degenerate cases, and all three are one fact:
there is no window to take a fraction of. No samples yet; `elapsed === 0`; or
`elapsed < 0`, the clock stepping backwards. The `NaN` case matters most — `NaN`
compares false against _every_ threshold, so a ratio that evaluated to `NaN` would
silence the alert above while still looking like a number. `null` rather than `1` for
the same reason: "fully covered" is the one reading that switches it off.
`droppedSamples` is the tell that the clock is not to be trusted.

`reset()` re-bases the window along with the samples. Without that, a fresh sample
count would be divided by the monitor's whole life and report near-zero coverage for an
interval that is fully covered.

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
import { MetricsCollector } from 'performance-helpers/metrics';

let lastBlockedMs = 0;

const monitor = new PowerEventLoopMonitor({
  intervalMs: 20,
  onDrift: (drift) => {
    if (drift > 100) lastBlockedMs = Math.round(drift);
  },
});

const metrics = new MetricsCollector();
metrics.register('eventloop.blocked', () => ({ ms: lastBlockedMs }));

monitor.start();

// `register` takes a read function, so the series is pulled on each scrape
// rather than pushed on a timer of your own.
metrics.register('eventloop.p99', () => monitor.stats().p99 ?? 0);
metrics.register('eventloop.max', () => monitor.stats().max);
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

- **A negative reading is dropped, not recorded, and counted in `droppedSamples`.** A backwards clock step (NTP correction, a suspended laptop) would otherwise poison the histogram's invariants, so the reading is refused — and refused readings are counted, because one with no counter is indistinguishable from a sample that never happened. `onDrift` does not receive it.
- **Everything except `coverage` describes only the probes that fired.** A period when the monitor was not sampling is invisible in `max`, `p99` and both blocked fields. That is what `coverage` is for.
- **Memory is bounded by the number of _distinct_ drift values, not by sample count.** `PowerHistogram` is a sparse DDSketch, so a long-running monitor with a stable delay allocates a stable number of buckets. There is no cap option because none is needed.
- **This is not a profiler.** It answers "was the loop blocked, and how long for". It cannot tell you which code blocked it.
- **Zero dependencies, both runtimes.** Nothing Node-specific is imported unless you ask for it, and the monitor works in a browser or a worker with `utilization()` returning `null`.

## See also

- [`PowerHistogram`](powerHistogram.md) — the sketch behind the quantiles.
- [`PowerLogger`](powerLogger.md) — gated logging and in-memory counters, for pairing with these numbers.
- [`now`](now.md) — the clock both use.
