[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / isSharedArrayBuffer

# Function: isSharedArrayBuffer()

> **isSharedArrayBuffer**(`buf`): `boolean`

Whether `buf` is a `SharedArrayBuffer`.

`instanceof SharedArrayBuffer` is not writable directly: the global is absent
from this library's type set, so TS rejects the left-hand side of an `instanceof`
expression outright (PERF-005). Routing every use through here fixes that once
instead of casting at each site.

Exported for `powerMessageCodec`, which had two bare `instanceof` sites of its
own (AUD-011) — one of them walking **arbitrary user values**, where a
cross-realm `SharedArrayBuffer` was silently *copied* instead of transferred.
The same-realm fast path is first, so the common case still costs one
comparison; only a value that fails it pays for `Reflect.get` and the `try`.

## Parameters

### buf

`unknown`

## Returns

`boolean`
