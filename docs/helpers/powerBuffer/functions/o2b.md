[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / o2b

# Function: o2b()

> **o2b**(`obj`): `ArrayBuffer`

Encode a value to an ArrayBuffer containing JSON UTF-8.
Returns an owning ArrayBuffer (may be a slice of the underlying buffer).

## Parameters

### obj

`any`

Value to encode.

## Returns

`ArrayBuffer`

## Example

```ts
const buf = o2b({ a: 1 })
```
