[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/errors](../README.md) / normalizeError

# Function: normalizeError()

> **normalizeError**(`err`, `defaultCode?`): `object`

Normalize various error shapes into a canonical error object used
across helpers.

If `err` is falsy or not an object a minimal error object is returned
with the provided `defaultCode` and the stringified value as the
`message` when available.

## Parameters

### err

`any`

The incoming error value (Error instance, object, or any).

### defaultCode?

`string` = `'ERR_ITEM'`

Fallback error code when none present.

## Returns

`object`

### code

> **code**: `string`

### error

> **error**: `true`

### message

> **message**: `string` \| `undefined`

### stack

> **stack**: `string` \| `undefined`
