[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / PowerMessageCodec

# Variable: PowerMessageCodec

> `const` **PowerMessageCodec**: `Readonly`\<\{ `announceCapabilities`: (`options?`) => `object`; `canUseNativeClone`: () => `boolean`; `CODECS`: `Readonly`\<\{ `JSON`: `0`; `RAW`: `2`; \}\>; `collectTransferables`: (`value`, `maxDepth?`) => `ArrayBuffer`[]; `decodeInbound`: (`data`) => `object`; `decodeMessage`: (`input`, `options?`) => `object`; `encodeMessage`: (`value`, `options?`) => `Uint8Array`\<`ArrayBufferLike`\>; `encodeNative`: (`value`) => `object`; `encodeNativeEnvelope`: (`value`, `options?`) => `object`; `frameEncodedJson`: (`json`) => `Uint8Array`\<`ArrayBufferLike`\>; `frameTransferList`: (`frame`) => `ArrayBuffer`[]; `HEADER_BYTES`: `6`; `isCapabilityAnnouncement`: (`value`) => `boolean`; `isNativeEnvelope`: (`value`) => `boolean`; `isRawPayload`: (`value`) => `boolean`; `MESSAGE_CODECS`: `Set`\<`"framed"` \| `"legacy"` \| `"negotiated"`\>; `MESSAGE_PROTOCOL_VERSION`: `1`; `NATIVE_ENVELOPE_KEY`: `"__pp"`; `NATIVE_PROTOCOL_VERSION`: `1`; `selectCodec`: (`value`) => `"json"` \| `"raw"`; \}\>

Namespace object, for `import { PowerMessageCodec } from ...` and for
`PowerMessageCodec.encodeMessage(...)` call sites.
