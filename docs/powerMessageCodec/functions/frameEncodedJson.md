[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / frameEncodedJson

# Function: frameEncodedJson()

> **frameEncodedJson**(`json`): `Uint8Array`\<`ArrayBufferLike`\>

Frame bytes that are already encoded JSON, under the `json` codec.

This exists for a caller that caches the _encoded_ form of a value - as
`PowerPool` does - and wants to reuse it instead of re-serialising. The bytes
must be the UTF-8 encoding of a JSON document, which is what `o2u8` produces.

The codec id is `json`, not `raw`: `decodeMessage` will parse the payload,
which is what the sender meant. Framing pre-encoded JSON as `raw` would hand
the receiver a `Uint8Array` and lose the value.

## Parameters

### json

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

UTF-8 JSON bytes, or a JSON string to
encode first. A string is accepted because that is what a caller caching
the encoded form actually holds; passing a string here avoids the
double-encode that `o2u8(someJsonString)` would cause.

## Returns

`Uint8Array`\<`ArrayBufferLike`\>

A framed message with the `json` codec id.
