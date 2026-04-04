[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / simpleArgsKey

# Function: simpleArgsKey()

> **simpleArgsKey**(...`args`): `string`

A small, fast key resolver for common cases where arguments are simple scalars.
- Fast path for primitive scalar args (string, number, boolean, null, undefined).
- Joins scalar args with `|` and prefixes type codes to avoid collisions.
- Falls back to `JSON.stringify(args)` when any arg is a non-scalar (object, function, symbol).

This is intended as a performant default for hot paths where most calls use
simple identifiers (ids, numbers, short strings). It is deterministic but
not suitable for canonicalizing complex objects — provide a custom
`keyResolver` in that case.

Example: `new PowerMemoizer(fn, { keyResolver: simpleArgsKey })`

## Parameters

### args

...`any`[]

## Returns

`string`
