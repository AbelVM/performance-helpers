[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/now](../README.md) / nowMs

# Function: nowMs()

> **nowMs**(): `number`

Get a high-resolution timestamp in milliseconds since the epoch.

This function prefers `performance.timeOrigin + performance.now()` when
available and reasonably close to `Date.now()` to provide higher
resolution timestamps. On Node.js it uses `process.hrtime.bigint()` with
an epoch offset when available. Falls back to `Date.now()` if nothing
better is available or when offsets appear to diverge (e.g. in some
test harnesses).

## Returns

`number`

Milliseconds since epoch (floating point for higher resolution).
