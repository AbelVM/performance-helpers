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
- The reader knows the frame length **before** allocating, so a stream reader can consume exactly one message and keep the remainder. `createFrameDecoder` is that reader — see [Reading a stream](#reading-a-stream).
- Frames are self-delimiting, which is what a `WebSocket` fan-out needs to batch several messages per send.

## Why there is no `v8` frame

It is tempting to add a "V8" codec for speed. There is not one, and shipping a fake would be worse than omitting it.

The structured-clone algorithm does not produce bytes. It is a native operation that only exists on a `MessagePort`, `Worker` or `postMessage` boundary, and there is no portable way to serialise a structured clone into a transferable buffer without a serialization library — which would break this package's zero-dependency rule. (`o2u8(structuredClone(x))` is just `JSON.stringify` with extra steps.)

So the two things are split by what they actually are:

|                  | API                               | Use when                                                                                     |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| **Framed bytes** | `encodeMessage` / `decodeMessage` | the transport is a byte stream: WebSocket, file, HTTP body                                   |
| **Native clone** | `encodeNativeEnvelope`            | the transport is a `MessagePort` or `Worker` — the platform does the work, no framing needed |

## API

- `encodeMessage(value, { codec })` — value to a framed `Uint8Array`. `codec` defaults to `selectCodec(value)`.
- `decodeMessage(input, { strict, rawAsBytes })` — **one whole frame** to `{ version, codec, value, byteLength }`. Accepts a `Uint8Array`, `ArrayBuffer` or `DataView`. Throws on a partial frame; use `createFrameDecoder` for a stream.
- `createFrameDecoder({ maxFrameBytes, strict, rawAsBytes })` — an incremental decoder over a byte stream. See [Reading a stream](#reading-a-stream).
- `encodeNativeEnvelope(value, { correlationId })` — wraps a value for the native carrier **without cloning it**. The transport clones whatever it is handed, so this is the one clone, not two. This is what you want.
- `encodeNative(value)` — `{ message, transfer }`, **deprecated in 2.0 in favour of `encodeNativeEnvelope`**. It clones _and_ hands the clone back for you to post, and `postMessage` clones that again. Still correct for the one case that needs a private copy — see [Native clone](#native-clone).
- `canUseNativeClone()` — whether the native carrier is usable at all.
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
import { encodeNativeEnvelope } from '../src/helpers/powerMessageCodec.js';

port.postMessage(encodeNativeEnvelope({ map: new Map(), bin: new Uint8Array(1024) }));
```

That is the whole native path. The envelope is lossless for `Map`, `Set`, `Date`,
`RegExp`, cycles and binary — none of which the `json` codec supports — and it does
**not** clone, because `postMessage` clones whatever it is handed. One deep copy,
not two.

### `encodeNative` is deprecated, and one case still needs it

`encodeNative(value)` clones the value and returns `{ message, transfer }` for you
to post. But `postMessage` then clones that again: a transfer list only ever
_names_ buffers inside the object being posted, it never replaces the clone. So the
common case pays for two deep copies where one suffices.

Measured on the real path — the encode plus the clone `postMessage` performs,
median of nine passes over 4 000 iterations, stable across three orderings — a
small object costs **~3 800 ns with `encodeNative` and ~260 ns with the envelope,
about 14x**, with the extra clone ~95% of the total. That is far outside the 28%
median min/max spread this project's harness measures, so treat the ratio as the
claim and the absolute numbers as machine-specific.

**It is deprecated rather than removed, because one caller genuinely needs it.**
Posting binary _without detaching the caller's data_ requires a private copy **and**
a transfer list naming that copy's buffers, and `encodeNative` is the only call that
returns both. That is exactly how `PowerPool` uses it internally.

So: if your message carries an `ArrayBuffer` **and** you must not detach the
caller's buffer, `encodeNative` is correct. If it carries no binary — which is the
overwhelming majority of messages — the envelope is strictly better and you should
switch.

```javascript
// Only when you need the caller's buffer left intact:
import { encodeNative } from '../src/helpers/powerMessageCodec.js';
const { message, transfer } = encodeNative(payload);
port.postMessage(message, transfer); // transfers the *clone's* buffers
```

## Reading a stream

`decodeMessage` reads one **whole** frame and throws on anything less, so it cannot be pointed at a socket, a `ReadableStream` or a `node:stream` chunk. Two things go wrong if you feed it one anyway:

- **A frame split across two reads** throws `RangeError: … truncated frame`. That is the _normal_ state of a stream roughly once per frame, so the error arrives at a rate that trains you to swallow `RangeError`s — including the one that means the peer is genuinely corrupt.
- **Two frames in one read** returns the first and stops, reporting a `byteLength` smaller than its input. Nothing throws. The remaining bytes are never looked at, and the loss is invisible at the call site.

`createFrameDecoder` is the reader for that job. It is transport-neutral and synchronous — not a `ReadableStream` transformer, not a generator:

```javascript
import { createFrameDecoder } from 'performance-helpers/powerMessageCodec';

const decoder = createFrameDecoder({ maxFrameBytes: 1 << 20 });

for await (const chunk of stream) {
  // `push` returns EVERY complete frame in the chunk, not the first.
  for (const { value } of decoder.push(chunk)) handle(value);
}

const tail = decoder.flush(); // zero-length if the stream ended on a boundary
if (tail.length) console.warn('stream ended mid-frame', tail.length, 'bytes short');
// ...or have it name the shortfall for you:
// decoder.flush({ strict: true })  →  RangeError: … 17 of 23 bytes buffered
```

| member                           | behaviour                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push(chunk)`                    | Copies the chunk in and returns every frame it completed. `[]` when it completed none — including a chunk too short to hold a header, which never throws. |
| `flush({ strict })`              | A **copy** of the bytes still buffered. `strict: true` throws a `RangeError` naming the shortfall instead.                                                |
| `pendingBytes`                   | Bytes held for an incomplete frame.                                                                                                                       |
| `reset()`                        | Drop an incomplete frame and start over, keeping the buffer.                                                                                              |
| `dispose()` / `[Symbol.dispose]` | Release the buffer. A state reset, not a cancellation — the decoder owns no timer or listener, and stays usable afterwards.                               |

The chunk is copied in, so a transport may reuse or transfer its own buffer as soon as `push` returns.

### `maxFrameBytes` is required

There is no default, and that is deliberate. A frame declares its own payload length, so a peer that sends a 6-byte header and then nothing holds the decoder's buffer open at whatever size it named — with no bound, no counter and no error. A default would be a limit that sounds like one and is not. Pass `Infinity` to opt out; that call is greppable, which a default is not.

The ceiling is checked **when the 6 header bytes arrive**, not when the frame completes, so an oversized frame is refused before its payload is buffered rather than after. It bounds one frame, so a chunk carrying many small frames may still transiently exceed it.

### It is not a speedup

`decodeMessage`'s `byteLength` has always made a hand-rolled reader possible, and this section used to be one — a re-concatenating buffer with a declared-length check. `createFrameDecoder` replaces it because of the two failures above, not because it decodes faster.

Measured against a naive re-concatenate-per-chunk decoder at the shape this was designed against (500 frames of ~422 bytes in 157 chunks of 1400, arms interleaved to cancel JIT warm-up): **1.00× and 1.19× on two runs**, with a 55–60 % min/max spread against the 28 % noise floor this repository measures. Indistinguishable. At 422 bytes a frame the copy is L1-resident and essentially free.

The two only separate when a frame is big enough for the copy to matter — 1.9× at 32 KB frames — which is an asymptotic property, not a number to quote. Mutation is what settled the rest, and it cuts both ways. Of 21 mutants, 16 are caught. The compaction and the growth factor are **not**: reverting either leaves all 34 tests green, because neither changes a single decoded byte, and that is the honest reason to adopt this and not the reason to claim it as an optimisation. The drained-cursor rewind _is_ caught, by exactly one test and for an indirect reason — it changes buffer reuse, so it changes what a `rawAsBytes` view sees on the next `push`, not what any frame decodes to.

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

`createFrameDecoder` adds:

- `TypeError` at construction — `maxFrameBytes` absent, not a whole number, or below `HEADER_BYTES`. A byte count has to be a whole number, and not merely for tidiness: a fractional ceiling is compared against a length that is always an integer, so `1024.5` and `1024` admit exactly the same frames and the `.5` reads as a tolerance that is not there.
- `RangeError` from `push`, naming `maxFrameBytes`, when a frame declares a total length over the ceiling. This fires on the header, so the offending payload is never buffered.
- `RangeError` from `push` for anything `decodeMessage` would have thrown — an unknown version or codec id, per frame. A throw leaves the buffered bytes in place and the decoder stuck, because a mis-parsed frame means the length prefix is no longer trustworthy; call `reset()` to recover.
- `RangeError` from `flush({ strict: true })` when the stream ended mid-frame.

## Notes

- `createFrameDecoder` knows nothing about sockets, and [`PowerSocketAdapter`](powerSocketAdapter.md) does not use it — the two are independent, and connecting them is separate work.
- `decodeMessage(..., { rawAsBytes: true })` returns a `Uint8Array` **view** over the frame, scoped to the payload — no copy. The default copies with `slice()`, which is what you want if you intend to keep the payload after the frame is transferred away.
- On a **stream**, `rawAsBytes: true` is sharper than the same option on a complete frame: the view aliases the decoder's own buffer, so the next `push` overwrites it. Keep the bytes, or leave the option off.
- The `raw` codec respects a typed array's `byteOffset`/`byteLength`, so a `subarray` of a larger buffer encodes only its own window.
- `strict: false` is there for a rolling upgrade, where a newer peer may send version 2 and a reader should decide for itself. It is off the default deliberately.
- Every frame is written with a hand-rolled little-endian length rather than a `DataView`, to avoid allocating one per message on a hot path.
