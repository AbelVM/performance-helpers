[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / deepEqualWithSeen

# Function: deepEqualWithSeen()

> **deepEqualWithSeen**(`a`, `b`, `seen?`): `boolean`

Exported helper that allows callers to reuse a `seen` WeakMap for
repeated deep-equality checks to avoid allocating a new WeakMap/WeakSet
structure on every call.

## Parameters

### a

`any`

### b

`any`

### seen?

`WeakMap`\<`any`, `any`\>

## Returns

`boolean`
