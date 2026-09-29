---
'performance-helpers': minor
---

Adds **protocol negotiation** to `PowerPool`, and corrects a claim.

The framed protocol is the default because it is portable. It is also lossy, silently, for a class of values a worker will reasonably be handed. Measured through the shipped path (`node bench/claims.js carrier`), a worker using `decodeMessage` receives:

| you post                  | the worker receives                                     |
| ------------------------- | ------------------------------------------------------- |
| `new Map([['a', 1]])`     | `{}`                                                    |
| `new Set([1, 2])`         | `{}`                                                    |
| `new Date(1234567890123)` | an ISO **string**                                       |
| `10n`                     | the message posts unframed, then `decodeMessage` throws |
| `Infinity`, `NaN`         | `null`                                                  |

`Date` is the sharpest: nothing fails at the boundary, and the first `.getTime()` in the worker throws somewhere unrelated, long after the `postMessage`. Framing every message is a decision to describe every message as JSON, and that description is wrong.

`messageCodec: 'negotiated'` fixes it without changing what any other worker receives. **The worker advertises; the pool only listens:**

```js
// pool
const pool = new PowerPool(WorkerScript, { messageCodec: 'negotiated' });

// worker
import { decodeInbound, announceCapabilities } from 'performance-helpers';
parentPort.postMessage(announceCapabilities());
parentPort.on('message', (data) => {
  const { codec, value } = decodeInbound(data);
  // ...
});
```

The pool posts a frame to every worker until one advertises, then the native structured-clone carrier to that worker alone — which preserves `Map`, `Set`, `Date`, `RegExp`, `BigInt`, `Infinity`, `NaN` and sparse arrays intact. A mixed fleet is a normal state during a rollout, so the pool can be switched on before any worker is ready; `pool.getStats().protocol` reports how many workers have upgraded.

**The direction is the design.** A pool-asks handshake would have to put a control message on a worker's port, and any worker that did not implement it would run that message as a task. Asking only that a peer stay quiet cannot break a peer that has never heard of the protocol.

Also in this release:

- **The "2–5× faster" claim is withdrawn.** It was never measured, and measurement says
  otherwise: a structured clone is a tie for small objects, up to ~1.7× _slower_ for deeply
  nested structure, and faster only for string-heavy payloads (a 64 KB string goes 171 µs to
  8.9 µs). Fidelity is the reason to adopt the native carrier, not speed — which is why it
  is negotiated per worker rather than made the default. `node bench/claims.js carrier`
  reproduces the table.
- `decodeInbound(data)` reads every carrier a pool can send — a framed message, a native
  envelope, and a 1.x bare-JSON body — in one call. It replaces the
  try-the-frame-and-fall-back-to-bare-JSON dance that every worker otherwise re-derives, and
  that this repository had in three places. Only a body whose version byte claims version 1
  is decoded as a frame, so a version-2 or truncated frame still reports its real error.
- `encodeNativeEnvelope`, `announceCapabilities`, `isNativeEnvelope`,
  `isCapabilityAnnouncement`, `collectTransferables`, `NATIVE_ENVELOPE_KEY`,
  `NATIVE_PROTOCOL_VERSION` and `MESSAGE_CODECS` are exported.
- A `pool:protocol` event fires when a worker's advertised capabilities change. Capability
  announcements are consumed by the pool rather than forwarded to `message` listeners, and do
  not touch task accounting.
- An unknown `messageCodec` value now resolves to the documented default rather than
  selecting a protocol the caller did not ask for.
- A message containing an `ArrayBuffer` is copied before being transferred on the native
  carrier, so a caller's buffer is never detached by a `postMessage`. This costs a copy, and
  it is the price of not destroying the caller's data.
