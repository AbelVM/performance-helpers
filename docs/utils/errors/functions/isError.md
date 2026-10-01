[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/errors](../README.md) / isError

# Function: isError()

> **isError**(`value`): `value is Error`

Whether `value` is an `Error`, across realms where the platform can say so.

`instanceof` compares against *this realm's* `Error.prototype`, so it is
`false` for an error created in another `vm` context, another realm, or an
iframe - even though the value is exactly what the caller means. Every site
in this library that narrows with `instanceof Error` is therefore wrong for a
caller who hands us an error from somewhere else, and the failure mode is a
*substitute* rather than a diagnostic: `abortReason()` replaces the caller's
error with a fresh `AbortError`, so the reason they aborted with is silently
discarded.

`Error.isError()` (ES2026, V8 13.6 / Node 24) is a brand check on the
`[[ErrorData]]` internal slot and is realm-independent. **It does not exist
on this library's declared floor** - `engines.node` is `>=22.12.0` (V8 12.4)
and CI runs 22.12 - so the capability is probed once here, at module load,
rather than assumed at each call site. On a runtime without it the
`instanceof` fallback preserves today's behaviour exactly, which is why this
is a strict improvement rather than a raised floor.

Two differences from `instanceof` change the answer in the *other* direction,
and both are correct: `Object.create(Error.prototype)` has the prototype but
not the brand (`instanceof` says `true`, this says `false`), and a
cross-realm error has the brand but not this realm's prototype (`instanceof`
says `false`, this says `true`).

Declared as a **type predicate** rather than returning plain `boolean`.
That is not decoration: without it `tsc` cannot narrow at the call site, and
the first caller to rely on narrowing introduced two type errors -
`options.reason instanceof Error ? reason : new Error(...)` in
`PowerBulkhead#reset` widened to `string | Error | undefined` at the merge,
because nothing told the checker the true branch was an `Error`. It is also
strictly more useful than `boolean` at every other site.

## Parameters

### value

`unknown`

Any value, including a non-object.

## Returns

`value is Error`

`true` if `value` is an `Error` object.
