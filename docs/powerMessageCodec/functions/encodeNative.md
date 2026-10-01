[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / encodeNative

# Function: encodeNative()

> **encodeNative**(`value`): `object`

Encode a value for a `MessagePort` / `Worker` using the platform's structured
clone, with no framing and no serialization.

This is the fast path for in-process boundaries — faster than the `json` frame
and lossless for `Map`, `Set`, `Date`, `RegExp`, cycles and binary. It is
*not* a byte stream, so it cannot be used over a WebSocket; use
[encodeMessage](encodeMessage.md) there.

## Parameters

### value

`any`

## Returns

`object`

The message to pass to
  `postMessage` and the transfer list to pass alongside it. The list is empty
  when the value contains no transferable buffer.

### message

> **message**: `any`

### transfer

> **transfer**: `ArrayBuffer`[]
