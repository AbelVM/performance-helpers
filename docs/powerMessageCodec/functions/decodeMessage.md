[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / decodeMessage

# Function: decodeMessage()

> **decodeMessage**(`input`, `options?`): `object`

Decode a framed message.

## Parameters

### input

`ArrayBuffer` \| `Uint8Array`\<`ArrayBufferLike`\> \| `DataView`\<`ArrayBufferLike`\>

The frame.

### options?

#### rawAsBytes?

`boolean`

For a `raw` frame, return a
`Uint8Array` view over the frame instead of copying the payload out.

#### strict?

`boolean`

Reject an unknown protocol version
instead of attempting a best-effort decode. A future version may change the
layout, so silently mis-parsing is worse than a clear error.

## Returns

`object`

`byteLength` is the total framed length, which lets a stream reader know how
much to consume.

### byteLength

> **byteLength**: `number`

### codec

> **codec**: `"json"` \| `"raw"`

### value

> **value**: `any`

### version

> **version**: `number`
