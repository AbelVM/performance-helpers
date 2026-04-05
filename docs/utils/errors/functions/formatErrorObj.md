[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/errors](../README.md) / formatErrorObj

# Function: formatErrorObj()

> **formatErrorObj**(`errObj`): `string`

Convert a normalized error object into a compact human-readable string.
If the value is not a normalized error it will be stringified.

Examples:
- `{ error: true, code: 'ERR_X', message: 'oops' }` -> `"ERR_X: oops"`
- any other value -> `String(value)`

## Parameters

### errObj

`any`

A normalized error object (or any value).

## Returns

`string`

Human readable error string.
