# PowerMessageCodec

Versioned binary framing for helper-to-helper messages.

Any transport that carries structured values needs to know two things: how to read the bytes, and what they mean. `PowerPool` currently answers the second question by guessing — it sniffs "if this looks like an `ArrayBuffer`, `JSON.parse` it" — which silently corrupts a genuinely binary worker message. This module replaces sniffing with an explicit, self-describing envelope.

## Frame layout

```
byte  0      protocol version  (currently 1)
byte  1      codec id          (see CODECS)
bytes 2..5   payload length    (uint32 little-endian)
bytes 6..    payload
```

A length prefix beats newline-delimited JSON for anything but tiny text frames:

- No escaping is needed, and a payload may contain newlines or arbitrary bytes.
- The reader knows the frame length **before** allocating, so a stream reader can consume exactly one message and keep the remainder.
- Frames are self-delimiting, which is what a `WebSocket` fan-out needs to batch several messages per send.

## Why there is no `v8` frame

It is tempting to add a "V8" codec for speed. There is not one, and shipping a fake would be worse than omitting it.

The structured-clone algorithm does not produce bytes. It is a native operation that only exists on a `MessagePort`, `Worker` or `postMessage` boundary, and there is no portable way to serialise a structured clone into a transferable buffer without a serialization library — which would break this package's zero-dependency rule. (`o2u8(structuredClone(x))` is just `JSON.stringify` with extra steps.)

So the two things are split by what they actually are:

|                  | API                               | Use when                                                                                     |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| **Framed bytes** | `encodeMessage` / `decodeMessage` | the transport is a byte stream: WebSocket, file, HTTP body                                   |
| **Native clone** | `encodeNative`                    | the transport is a `MessagePort` or `Worker` — the platform does the work, no framing needed |

## API

- `encodeMessage(value, { codec })` — value to a framed `Uint8Array`. `codec` defaults to `selectCodec(value)`.
- `decodeMessage(input, { strict, rawAsBytes })` — frame to `{ version, codec, value, byteLength }`. Accepts a `Uint8Array`, `ArrayBuffer` or `DataView`.
- `encodeNative(value)` — `{ message, transfer }` for a `MessagePort`/`Worker`, using the platform's structured clone.
- `canUseNativeClone()` — whether `encodeNative` is usable.
- `selectCodec(value)` / `isRawPayload(value)` — codec choice helpers.
- `frameTransferList(frame)` — `[frame.buffer]`, for `postMessage` transfer lists. Note that transferring detaches the buffer.
- `MESSAGE_PROTOCOL_VERSION`, `CODECS`, `HEADER_BYTES`.

## Codecs

| codec  |  id | notes                                                                                                                                                     |
| ------ | --: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json` | `0` | Portable across every runtime; the only choice that interoperates with older peers. Does not handle `undefined`, `BigInt`, cycles, `Map`/`Set` or binary. |
| `raw`  | `2` | The value is already an `ArrayBuffer` or typed array and is stored verbatim, with no serialisation.                                                       |

## Example

```javascript
import { encodeMessage, decodeMessage } from '../src/helpers/powerMessageCodec.js';

// Structured data over any byte-stream transport.
const socket = new WebSocket(url);
socket.addEventListener('open', () => socket.send(encodeMessage({ type: 'subscribe', id: 7 })));

socket.addEventListener('message', (e) => {
  const { codec, value } = decodeMessage(new Uint8Array(e.data));
  console.log(codec, value);
});

// Binary stays binary - no JSON round-trip, no corruption.
const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
socket.send(encodeMessage(bytes)); // codec: 'raw'
```

On a `MessagePort` or `Worker`, skip the framing:

```javascript
import { encodeNative } from '../src/helpers/powerMessageCodec.js';

const { message, transfer } = encodeNative({ map: new Map(), bin: new Uint8Array(1024) });
port.postMessage(message, transfer);
```

`encodeNative` is lossless for `Map`, `Set`, `Date`, `RegExp`, cycles and binary — none of which the `json` codec supports — and it clones first, so the returned object shares no memory with the input.

## Batching over a stream

Because `decodeMessage` reports `byteLength`, a reader can split a byte stream into frames:

```javascript
let buffered = new Uint8Array(0);
for await (const chunk of stream) {
  buffered = concat(buffered, chunk);
  for (;;) {
    if (buffered.length < HEADER_BYTES) break;
    const declared =
      (buffered[2] | (buffered[3] << 8) | (buffered[4] << 16) | (buffered[5] << 24)) >>> 0;
    if (buffered.length < HEADER_BYTES + declared) break;
    const { value, byteLength } = decodeMessage(buffered);
    handle(value);
    buffered = buffered.subarray(byteLength);
  }
}
```

## Errors

`decodeMessage` throws rather than guessing, because a mis-parsed frame is worse than a clear failure:

- `RangeError` — frame shorter than the 6-byte header, unknown protocol version (unless `{ strict: false }`), unknown codec id, or a truncated payload.
- `TypeError` — input is not a `Uint8Array`/`ArrayBuffer`/`DataView`, or `codec: 'raw'` was forced for a non-binary value.

`encodeMessage` throws a `TypeError` for an unknown codec name, and for `raw` on a non-binary value.

## Notes

- `decodeMessage(..., { rawAsBytes: true })` returns a `Uint8Array` **view** over the frame, scoped to the payload — no copy. The default copies with `slice()`, which is what you want if you intend to keep the payload after the frame is transferred away.
- The `raw` codec respects a typed array's `byteOffset`/`byteLength`, so a `subarray` of a larger buffer encodes only its own window.
- `strict: false` is there for a rolling upgrade, where a newer peer may send version 2 and a reader should decide for itself. It is off the default deliberately.
- Every frame is written with a hand-rolled little-endian length rather than a `DataView`, to avoid allocating one per message on a hot path.
