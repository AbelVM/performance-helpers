[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/now](../README.md) / nowMs

# Function: nowMs()

> **nowMs**(): `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher resolution
timestamps. On Node.js it uses `process.hrtime.bigint()` with an epoch offset
when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

**The wall-clock cross-check is what makes this clock movable, and that is
sometimes required.** It is what lets a test harness that fakes `Date.now()`
drive a helper's notion of time, and it is why `PowerCron.nextRunAt` can be
documented as epoch milliseconds. The price is that a helper which only ever
*subtracts* inherits the wall clock's ability to jump - see
[monoMs](monoMs.md) for the measurement and for the four helpers that use it
instead.

## Returns

`number`

Milliseconds since epoch (floating point for higher resolution).
