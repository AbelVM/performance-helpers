---
'performance-helpers': minor
---

Add `maxCatchUp` cap and `overlap` option to `PowerCron`.

- `maxCatchUp` (default `Infinity`) caps the `catch-up` replay loop so a
  large backlog does not become a synchronous burst. Measured: a 10 ms cron
  that fell ~600 periods behind replayed all 600 in one tick, extrapolating
  to ~8.6 M invocations for 24 h. The refused periods are reported as
  `missed` by the following run, so they are not silently dropped.
- `overlap` (default `false`) blocks a tick while a task is in flight.
  Measured: a 50 ms task on a 20 ms interval fired 15 times with 15
  concurrent runs before this option existed. `runNow()` is out of band
  and ungated.
