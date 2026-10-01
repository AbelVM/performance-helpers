[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerMessageCodec

# powerMessageCodec

Versioned binary framing for helper-to-helper messages.

`PowerPool` and any WebSocket transport both need to move structured values
across a boundary, and both currently have to *guess* what they received. The
pool sniffs — "if it looks like an ArrayBuffer, `JSON.parse` it" — which
silently corrupts a genuinely binary worker message. This module replaces
sniffing with an explicit, self-describing envelope.

## Frame layout

```
byte  0      protocol version  (currently 1)
byte  1      codec id          (see CODECS)
bytes 2..5   payload length    (uint32 little-endian)
bytes 6..    payload
```

A length prefix beats newline-delimited JSON for anything but tiny text
frames: no escaping is needed, a payload may contain newlines and arbitrary
bytes, and the reader knows the frame length before allocating.

## Why there is no `v8` frame

It is tempting to add a "V8" codec for speed. There is not one, and shipping a
fake would be worse than not having it: the structured-clone algorithm does
not produce bytes. It is a native operation that only exists on a
`MessagePort`, `Worker` or `postMessage` boundary, and there is no portable
way to serialise a structured clone into a transferable buffer without a
serialization library — which would break this package's zero-dependency rule.

So the two things are split by what they actually are:

- [encodeMessage](functions/encodeMessage.md) / [decodeMessage](functions/decodeMessage.md) — **framed bytes**, for
  transports that carry a byte stream (WebSocket, files, HTTP bodies).
  Codecs: [CODECS.JSON](enumerations/CODECS.md#json), [CODECS.RAW](enumerations/CODECS.md#raw).
- [encodeNative](functions/encodeNative.md) / [encodeNativeEnvelope](functions/encodeNativeEnvelope.md) — **native structured
  clone**, for a `MessagePort` or `Worker`, where the platform does the work
  and no framing is needed at all. Lossless for `Map`, `Set`, `Date`,
  `BigInt`, cycles and binary, which the JSON frame is not — see the
  negotiation section below for the measurement.

## Negotiation

Which carrier to use is not a property of the value, so this module does not
decide it: a worker advertises the carriers it can decode with
[announceCapabilities](functions/announceCapabilities.md), `PowerPool` records that per worker, and posts
the native carrier to that worker alone. A worker that never announces keeps
receiving framed JSON, so the feature is opt-in at both ends and cannot break
a peer that does not know it exists. [decodeInbound](functions/decodeInbound.md) is the worker-side
read that handles all three carriers.

## Enumerations

- [CODECS](enumerations/CODECS.md)

## Variables

- [HEADER\_BYTES](variables/HEADER_BYTES.md)
- [MESSAGE\_CODECS](variables/MESSAGE_CODECS.md)
- [MESSAGE\_PROTOCOL\_VERSION](variables/MESSAGE_PROTOCOL_VERSION.md)
- [NATIVE\_ENVELOPE\_KEY](variables/NATIVE_ENVELOPE_KEY.md)
- [NATIVE\_PROTOCOL\_VERSION](variables/NATIVE_PROTOCOL_VERSION.md)
- [PowerMessageCodec](variables/PowerMessageCodec.md)

## Functions

- [announceCapabilities](functions/announceCapabilities.md)
- [canUseNativeClone](functions/canUseNativeClone.md)
- [collectTransferables](functions/collectTransferables.md)
- [decodeInbound](functions/decodeInbound.md)
- [decodeMessage](functions/decodeMessage.md)
- [encodeMessage](functions/encodeMessage.md)
- [encodeNative](functions/encodeNative.md)
- [encodeNativeEnvelope](functions/encodeNativeEnvelope.md)
- [frameEncodedJson](functions/frameEncodedJson.md)
- [frameTransferList](functions/frameTransferList.md)
- [isCapabilityAnnouncement](functions/isCapabilityAnnouncement.md)
- [isNativeEnvelope](functions/isNativeEnvelope.md)
- [isRawPayload](functions/isRawPayload.md)
- [selectCodec](functions/selectCodec.md)

## References

### default

Renames and re-exports [PowerMessageCodec](variables/PowerMessageCodec.md)
