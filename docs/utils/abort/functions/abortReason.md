[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/abort](../README.md) / abortReason

# Function: abortReason()

> **abortReason**(`signal`): `Error`

The rejection value for an aborted wait.

Prefers `signal.reason` when it is an Error, so a caller that aborted with
`controller.abort(new MyError())` gets their own error back. Otherwise a
`DOMException` with `name: 'AbortError'`, which is what `err.name ===
'AbortError'` checks expect - and what a stripped runtime without
`DOMException` gets as a plain named Error.

## Parameters

### signal

`AbortSignal`

## Returns

`Error`
