[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerOperationContext](../README.md) / getOperationContext

# Function: getOperationContext()

> **getOperationContext**(): `any`

Read the operation context bound to the current async execution, if any.

## Returns

`any`

The current context, or `undefined` when none is bound (or when
  `AsyncLocalStorage` is unavailable).
