[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/now](../README.md) / monoMs

# Function: monoMs()

> **monoMs**(): `number`

A **monotonic** high-resolution timestamp in milliseconds since the epoch.

Same ladder, same sources, same epoch mapping as [nowMs](nowMs.md) - and one
difference: `Date.now()` is never read, so the value cannot be moved by a
wall-clock adjustment. The epoch offset is captured once at module load, so
the result is a real epoch timestamp that only ever increases.

Use it for **delta arithmetic**, where only the difference between two
readings is ever used: rate limiters, circuit-breaker windows, token-bucket
refill. Use [nowMs](nowMs.md) for anything a caller will read as an instant -
`PowerCron.nextRunAt`, a log line, an HTTP `Retry-After`.

**Why, measured.** `nowMs()` is two clock reads, and the second exists only to detect
a divergence. Within a second of wall time the guard passes and the value
tracks `performance`, so the limiter's elapsed-time arithmetic is sound -
but a clock adjusted by more than a second fails the guard, and from that
moment the helper silently reads `Date.now()`. Two measurements of the
consequence, both with **zero** real milliseconds elapsed:

- `PowerGCRA({rate: 10, per: 1000, burst: 1})` saturated at `available() ===
  0` reported `available() === 2` and admitted after the wall clock stepped
  forward 5 s. `2` is `_ceiling()`, so that is the whole burst, granted.
- `PowerCircuit({threshold: 1, timeout: 60000})` reported `half-open` after a
  60 s forward step, so a dependency that had been failing for 1 ms was
  offered a trial call.

Both are **forward** steps, which is worth stating because the obvious
reading is backwards: a backward step is harmless to these helpers, because
`PowerGCRA`'s `Math.max(now, _tat)` clamp and `PowerCircuit`'s `nowMs() -
_openedAt < _openWindowMs` comparison both keep interpreting an earlier
reading as "not much time has passed". It is the jump forward that hands out
budget nobody spent.

**The cost, stated rather than hidden.** A consumer who fakes `Date.now()` to
drive a limiter's clock will stop doing so - the four helpers using this
clock ignore it. The supported injection point is a limiter's `now` option,
which has always been authoritative (`resolveLimiterNow` gives it precedence
over everything, including a per-call value). `PowerCircuit` has no `now`
option, so for that class a faked `Date.now()` was never a documented way in
and is not one now.

**The guarantee is by source, not by clamping.** Both sources this can reach -
`performance.now()` and `process.hrtime.bigint()` - are monotonic by
specification, and the epoch offsets (`performance.timeOrigin`,
`_hrtimeEpochOffset`) are fixed for the module's lifetime. A last-value floor
was considered and rejected: it would prevent the value going *backwards*
while still permitting the forward jumps that are the actual defect, so it
would cost a branch on the hot path and a module-level mutable to fix the
wrong direction. The `Date.now()` fallback is reached only on a platform
offering neither high-resolution clock, where nothing monotonic exists to use.

## Returns

`number`

Milliseconds since epoch (floating point), non-decreasing.
