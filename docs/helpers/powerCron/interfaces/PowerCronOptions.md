[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCron](../README.md) / PowerCronOptions

# Interface: PowerCronOptions

## Properties

### catchUp?

> `optional` **catchUp?**: [`CatchUpPolicy`](../type-aliases/CatchUpPolicy.md)

What to do about fires missed
  while the process was busy or asleep:
  - `'skip'` (default) run once, immediately, then resume the normal cadence.
  - `'catch-up'` replay every missed fire, in order, before resuming. Correct
    for jobs that must account for each period (billing, rollups).
  - `'run-once'` coalesce all missed fires into a single run.

***

### intervalMs?

> `optional` **intervalMs?**: `number`

Milliseconds between fires. Must be
  at least 10, so a typo cannot become a hot loop.

***

### jitter?

> `optional` **jitter?**: `number`

Random fraction (0–1) of the interval added
  to each fire, spreading a fleet's crons so they do not stampede a
  dependency on the same minute boundary.

***

### maxCatchUp?

> `optional` **maxCatchUp?**: `number`

Cap on how many missed periods
  `'catch-up'` replays in one timer tick. **`Infinity` is the default and the
  opt-out** — see the note below on why a default is not a floor. A finite
  value stops a backlog from becoming a synchronous burst: measured, a cron
  that fell ~600 periods behind on a 10 ms interval replayed all 600 in one
  tick, which extrapolates to ~8.6 M invocations for 24 h of drift.

***

### now?

> `optional` **now?**: () => `number`

Injected clock, as the limiters take
  (PERF-007). GEO-039: a cron's cadence is deadline arithmetic over `_nextAt`,
  so a frozen clock has to reach it or the catch-up policy cannot be
  exercised without real timers. Defaults to `nowMs()`.

#### Returns

`number`

***

### onError?

> `optional` **onError?**: (`err`) => `void`

Called when the task throws or
  rejects. Errors are swallowed by default so one bad run does not kill the
  schedule.

#### Parameters

##### err

`Error`

#### Returns

`void`

***

### onFire?

> `optional` **onFire?**: (`info`) => `void`

Called after each successful run
  with `{ scheduledFor, ranAt, driftMs, missed }`. **`missed` is the number of
  missed periods *this run* stands in for**, and it was always `0` before 2.0 —
  in the one payload a caller would use to see catch-up working. Under `catch-up`
  each replay reports `1` (it is that period being run) and the run that follows
  reports `0`, because the replays have already accounted for them. Under `skip`
  and `run-once` the single run reports how many periods were dropped or folded
  into it.

#### Parameters

##### info

`Object`

#### Returns

`void`

***

### overlap?

> `optional` **overlap?**: `boolean`

Whether a task may run again before the
  previous one finished. **Off by default**, because a cron is a schedule, not
  a fan-out: measured, a 50 ms task on a 20 ms interval fired 15 times with 15
  concurrent runs. With it on, the cadence is what drives the timer and the
  task is fire-and-forget; with it off, a run still in flight blocks the next
  fire and the blocked periods are reported as missed by the following tick.

***

### runOnStart?

> `optional` **runOnStart?**: `boolean`

Fire once immediately on `start()`,
  then follow the normal cadence.

***

### unref?

> `optional` **unref?**: `boolean`

Whether the pending timer is `unref`'d, so
  a running cron does not by itself keep a Node process alive.
