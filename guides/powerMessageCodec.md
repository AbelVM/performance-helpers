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

## Negotiation: the carrier is a per-worker decision

The frame is the default because it is portable. It is also lossy, silently, for a class of values a worker will reasonably be handed. Measured through the shipped path (`node bench/claims.js carrier`):

| value sent                | what the worker receives                                      |
| ------------------------- | ------------------------------------------------------------- |
| `new Map([['a', 1]])`     | `{}`                                                          |
| `new Set([1, 2])`         | `{}`                                                          |
| `/ab+c/i`                 | `{}`                                                          |
| `new Date(1234567890123)` | an ISO **string**                                             |
| `10n`                     | the whole message posts unframed, then `decodeMessage` throws |
| `Infinity`, `NaN`         | `null`                                                        |
| `[1, , 3]`                | `[1, null, 3]` — a hole becomes `null`                        |

`Date` is the sharpest one, because nothing fails at the boundary: the worker gets a string that looks like a date, and the first `.getTime()` throws somewhere unrelated, long after the `postMessage`.

`messageCodec: 'negotiated'` fixes this without changing what any other worker receives. **The worker advertises; the pool only listens.**

```javascript
// worker
import { parentPort } from 'node:worker_threads';
import { decodeInbound, announceCapabilities } from 'performance-helpers';

parentPort.postMessage(announceCapabilities()); // once, at start-up

parentPort.on('message', (data) => {
  const { codec, value } = decodeInbound(data);
  // ...
});
```

```javascript
// pool
const pool = new PowerPool(WorkerUrl, { messageCodec: 'negotiated' });
```

The pool posts a frame to every worker until one advertises, then the native carrier to that worker alone. A mixed fleet — nine legacy workers and one upgraded — is a normal state during a rollout, and `pool.getStats().protocol` reports it (`nativeWorkers`, and per-worker `codecs`).

**The direction is the design.** A pool-asks handshake would have to put a control message on a worker's port, and any worker that did not implement it would run that message as a task. Asking only that a peer stay quiet cannot break a peer that has never heard of the protocol, which is why ADR 0001's objection — negotiation "requires a working message channel" — does not apply.

### `decodeInbound` is the worker half

```javascript
const { codec, value, correlationId } = decodeInbound(data);
```

`codec` is one of `'json'`, `'raw'`, `'native'`, `'legacy'` or `'raw'` (a bare value posted as-is). It replaces the try-the-frame-and-fall-back-to-bare-JSON dance that every worker otherwise re-derives — and that this repository itself had in three places. Only a body whose version byte claims version 1 is decoded as a frame, so a version-2 or truncated frame still reports the error it actually is.

Reply on the carrier the message arrived on. A pool cannot read a frame as a bare body, or the reverse:

```javascript
parentPort.postMessage(
  codec === 'native'
    ? encodeNativeEnvelope({ ...value, result }, { correlationId: value.correlationId })
    : encodeMessage({ ...value, result })
);
```

### It is not a speedup

The release note for this originally claimed 2–5×. `node bench/claims.js carrier` says otherwise:

| payload              |  framed |  native | ratio |
| -------------------- | ------: | ------: | ----: |
| small object (210 B) | ~3.4 µs | ~3.8 µs |  1.11 |
| 1 KB string          | ~4.2 µs | ~1.5 µs |  0.37 |
| 64 KB string         | ~171 µs | ~8.9 µs |  0.05 |
| 200 nested objects   |  ~51 µs |  ~87 µs |  1.71 |

A tie for small objects, up to ~1.7× **slower** for deep structure, and faster only for string-heavy payloads. Timings are indicative — BENCH-001 measured a 28% spread on this machine — but the direction is consistent across runs, and a pool that posted envelopes for the speed would have been slower for the payloads a worker actually receives. Negotiation is justified by the fidelity table above, and the per-worker decision is what keeps a pool from adopting it where it does not pay.

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
