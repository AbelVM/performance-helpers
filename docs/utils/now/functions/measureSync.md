[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/now](../README.md) / measureSync

# Function: measureSync()

> **measureSync**(`fn`): `object`

Measure a synchronous function's execution duration.

If `fn` is a function it will be invoked synchronously; otherwise the
provided value is treated as the result and returned immediately. The
returned object contains the `result` plus `ms`, `start`, and `end`
timestamps measured with `nowMs()`.

If the invoked function throws, the thrown error will be augmented with
a `durationMs` property (elapsed time until the throw) before being
re-thrown to the caller.

## Parameters

### fn

`any`

Function to execute or a direct value.

## Returns

`object`

The result and timing.

### end

> **end**: `number`

### ms

> **ms**: `number`

### result

> **result**: `any`

### start

> **start**: `number`

## Throws

Re-throws any error thrown by `fn` after attaching `durationMs`.
