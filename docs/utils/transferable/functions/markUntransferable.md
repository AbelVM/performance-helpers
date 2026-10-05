[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/transferable](../README.md) / markUntransferable

# Function: markUntransferable()

> **markUntransferable**(`buffer`): `boolean`

Mark an `ArrayBuffer` so the platform refuses to transfer it.

**Every failure mode here is silent by design, and that is the whole contract.** A browser
has no such API; a `SharedArrayBuffer` is not markable; a buffer that is already marked is
a no-op. None of those is a reason to fail a `postMessage`, so none of them throws.

The one case worth noticing is a **non-`ArrayBuffer` view target**: `view.buffer` is
always an `ArrayBuffer` for a typed array over one, so that cannot happen here, but a
caller passing a `DataView` over a `SharedArrayBuffer` could and the guard absorbs it.

## Parameters

### buffer

`ArrayBufferLike` \| `null` \| `undefined`

Usually `view.buffer`.

## Returns

`boolean`

`true` if the buffer is marked or the platform has no marker to apply.
