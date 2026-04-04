[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / b2o

# Function: b2o()

> **b2o**(`buf`): `any`

Decode an ArrayBuffer/TypedArray/Buffer containing JSON UTF-8 to a value.
This is a small wrapper around `u82o` for the legacy ArrayBuffer API.

## Parameters

### buf

`any`

Buffer-like input containing JSON UTF-8.

## Returns

`any`

Parsed value.

## Example

```ts
const obj = b2o(buf)
```
