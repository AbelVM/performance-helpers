---
'performance-helpers': patch
---

### Added

`PowerPool`'s `recordTiming` option — opt-in percentile telemetry.

```js
const pool = new PowerPool(WorkerScript, { recordTiming: true });
const perf = pool.getStats().performance;
perf.percentiles; // { p50, p90, p99, p999 } — task duration, ms
perf.queueWaitPercentiles; // { p50, p90, p99, p999 } — time spent queued, ms
perf.utilization; // 0..1 — fraction of pool lifetime with work in flight
```

**Why a sketch and not more counters.** `timePerTask` and `queueWait` already report
exact mean, stddev, min and max in O(1) memory, and `percentSlowTasks` counts exactly
against a threshold. None of those can answer "what does the tail look like" — a mean
of 12 ms is a different pool at p99 = 13 ms than at p99 = 400 ms, and only the second
one has a problem. `PowerHistogram` is a DDSketch, which bounds _relative_ error across
decades of magnitude, so a 3 ms task and a 3 s task land in the same sketch without one
swamping the other.

**It is `PowerHistogram`, not Piscina's histogram.** Piscina's is `node:perf_hooks`,
which does not exist in a browser; this pool runs in six realms. The class already
exists here and `bench/claims.js latency` already validates its quantile accuracy.

Three things to know:

- **Off by default, and the default path pays nothing.** With `recordTiming` off the
  two histograms are never allocated, and the two `record()` calls are a single boolean
  test each.
- **`percentiles` and `queueWaitPercentiles` are `null` when off, not zeros.** A pool
  that never opted in has no sketch, and `p50: 0` would read as "the median task took
  no time" rather than "nobody is measuring".
- **`utilization` is not gated.** It is two comparisons on transitions that already
  happen on every dispatch and every completion, so it costs nothing and is always
  reported. It is interval-based rather than sampled, because a sampled utilization is
  a function of the sampling rate: a pool busy for 1 ms in every 10 reads as idle at a
  100 ms sample and saturated at a 1 ms one.

**The Welford statistics are additive, not replaced.** `timePerTask`, `queueWait` and
`percentSlowTasks` keep their exact closed forms; the sketches add the tail shape
beside them. Cross-reference ADR 0014.

### Tests

6 new tests in `test/powerPool.stats.test.js`, pinning that the fields are `null` when
off rather than zero, that no histogram is allocated when off, that the percentiles are
ordered once tasks have completed, that queue wait is recorded only when work actually
queues, that the Welford statistics and `percentSlowTasks` stay exact, and that
`utilization` is consistent with the two numbers it is derived from.

Two existing tests caught real defects in the first draft, and both are worth recording.
`powerPool.batchClock.test.js` reported **2 clock reads where POOL-006 pins 1** — the
busy-interval open called `nowMs()` on the dispatch path, so it now reuses the
`startTime` the dispatch already read. And `types.optionsCoverage.test.js` reported that
`recordTiming` was destructured but absent from the published `PowerPoolOptions` type,
which is the test doing exactly the job it exists for.
