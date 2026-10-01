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

The "is it an Error" test is `isError()` rather than `instanceof`, because
this is the one place in the library where getting it wrong *replaces* the
caller's value. A caller in another realm who aborts with their own
`TypeError` had it discarded and replaced by the generic `AbortError` below,
and the caller-visible symptom was a rejection carrying the wrong `name` and a
message they never wrote.

## Parameters

### signal

`AbortSignal`

## Returns

`Error`
