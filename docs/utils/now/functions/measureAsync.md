[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/now](../README.md) / measureAsync

# Function: measureAsync()

> **measureAsync**(`fn`): `Promise`\<\{ `end`: `number`; `ms`: `number`; `result`: `any`; `start`: `number`; \}\>

Measure an async function or promise's execution duration.

If `fn` is a function it will be invoked and its returned Promise/value
awaited; if `fn` is already a Promise or a plain value it will be awaited
directly. Resolves with an object containing `result`, `ms`, `start`, and
`end` timestamps measured with `nowMs()`.

On rejection the thrown error will be augmented with `durationMs` and
re-thrown to the caller.

## Parameters

### fn

`any`

Async function, Promise, or direct value.

## Returns

`Promise`\<\{ `end`: `number`; `ms`: `number`; `result`: `any`; `start`: `number`; \}\>

Promise resolving to result and timing.

## Throws

Re-throws any rejection from `fn` after attaching `durationMs`.
