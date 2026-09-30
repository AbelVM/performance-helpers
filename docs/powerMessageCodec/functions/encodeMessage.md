[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / encodeMessage

# Function: encodeMessage()

> **encodeMessage**(`value`, `options?`): `Uint8Array`\<`ArrayBufferLike`\>

Encode a value into a framed `Uint8Array`.

## Parameters

### value

`any`

The value to encode.

### options?

#### codec?

`"json"` \| `"raw"`

Force a codec. Defaults to
[selectCodec](selectCodec.md).

## Returns

`Uint8Array`\<`ArrayBufferLike`\>

A framed message, ready to `postMessage` or send.

## Throws

On an unknown codec, or when `raw` is forced for a
non-binary value.
