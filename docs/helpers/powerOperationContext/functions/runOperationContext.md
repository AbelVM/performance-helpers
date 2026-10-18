[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerOperationContext](../README.md) / runOperationContext

# Function: runOperationContext()

> **runOperationContext**(`context`, `fn`): `any`

Run `fn` with `context` as the current operation context for the duration of
the (possibly async) call. Nested calls shadow the outer context.

Falls back to running `fn` directly when `AsyncLocalStorage` is unavailable;
in that case `getOperationContext()` returns `undefined` outside the call.

## Parameters

### context

`any`

An operation context (typically from `createOperationContext`).

### fn

() => `any`

The function to run. May be async.

## Returns

`any`

The return value of `fn`.
