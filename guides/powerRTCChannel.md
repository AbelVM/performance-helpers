# PowerRTCChannel

One `RTCDataChannel` behind the same shape as [`PowerSocketAdapter`](powerSocketAdapter.md) — string `readyState` normalised, SCTP's message-size ceiling enforced, and back-pressure that arrives as a push signal instead of a poll timer.

## Why this exists, and what it deliberately is not

It is **a transport adapter, not a WebRTC stack**. There is no `RTCPeerConnection` here, no signalling, no ICE, no STUN/TURN. Establishing a data channel needs all four, and none of them belong in a dependency-free toolbox — the same reasoning REJ-007 gave for not shipping a WebSocket _server_: RFC 6455 is a security liability to reimplement, and `RTCPeerConnection` has a far larger one.

Bring an open — or opening — `RTCDataChannel`. This normalises it so the rest of your code does not know it is not a socket.

## What RT-017 claimed, and what was checked

The row's four premise claims were verified against MDN and the WebRTC 1.0 spec _before_ any code was written. Two held, one held with a wrong citation, and the most important difference from a socket was missing entirely.

| Claim                                                                   | Verdict                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binaryType` is already `arraybuffer`                                   | **True**, and unlike `WebSocket` (default `"blob"`). RT-002's fix is _not_ repeated here — there is nothing to set.                                                                                       |
| `RTCDataChannel` is transferable                                        | **True**, baseline. Creating one on the main thread and `postMessage`-ing it into a worker works.                                                                                                         |
| `bufferedAmountLowThreshold` + `bufferedamountlow`                      | **True.** See [Back-pressure](#back-pressure-is-pushed-here) below.                                                                                                                                       |
| `ordered:false, maxRetransmits:0` gives UDP-like delivery, per RFC 8831 | **Mechanism true; the citation is wrong.** RFC 8831 is _RTP media transport_ and says nothing about data channels. The semantics are the WebRTC 1.0 spec's; the wire format is RFC 8841 (SCTP over DTLS). |
| _(not in the row)_                                                      | **`send()` throws above the SCTP message limit.** A `WebSocket` buffers and gets slower; a data channel throws. See [Two refusals](#two-refusals-and-only-one-of-them-is-seen).                           |

Three differences from a socket are the whole of the work:

|                | `WebSocket`                                    | `RTCDataChannel`                                           |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `readyState`   | number, `0`–`3`                                | **string**, `'connecting'`/`'open'`/`'closing'`/`'closed'` |
| oversize frame | buffers; the peer sees nothing                 | **`send()` throws** — SCTP caps one message                |
| back-pressure  | `bufferedAmount` polled on a backing-off timer | **`bufferedamountlow`, pushed**                            |

## `readyState` is a string, and that is the reason this class exists

`READY_STATE.OPEN` is `1`. A data channel's `readyState` is `'open'`. So:

```js
if (channel.readyState === READY_STATE.OPEN) {
  channel.send(frame);
}
```

…is **false on a perfectly healthy, open channel**. No throw, no warning, nowhere to look. The `===` against a number is where the failure goes, and the consequence is the review's worst category: a silent total failure reported as a healthy connection. A hub wired that way refuses every frame, and `stats()` reports a channel that is connected, open, and has never sent anything.

This class reads the platform's string **once**, maps it to the numeric `READY_STATE` the rest of the library uses, and maintains that copy from events:

```js
const channel = new PowerRTCChannel(dc);

channel.readyState === READY_STATE.OPEN; // true — the line above now works
channel.isOpen; // true
```

Reading it once is not an optimisation, it is a **requirement**. A channel transferred to another realm is _detached_, and getting `readyState` on one throws `InvalidStateError`. A transferred channel is exactly the case this class exists to serve, so the initial read is guarded and every later read is the cached field — `isOpen` cannot throw from a loop. A channel that is not open is reported as `CONNECTING`; the only honest statement available is "not open yet".

An unrecognised state string maps to not-open, never to open. Failing closed is the only safe direction.

## Usage

```javascript
import { PowerRTCChannel } from 'performance-helpers/powerRTCChannel';
import { PowerRealtimeHub, decodeMessage } from 'performance-helpers';

// The channel comes from `pc.createDataChannel(...)` or a `datachannel` event.
const channel = new PowerRTCChannel(dc, {
  expectUnreliable: true,
  highWaterMarkBytes: 64 * 1024,
  onMessage: ({ data }) => handle(decodeMessage(data)),
  onClose: ({ reason }) => log.warn({ reason }, 'peer went away'),
});

const hub = new PowerRealtimeHub({
  send: (sub, frame) => sub.transport.send(frame),
  close: (sub, reason) => {
    // Take the reason from *here*, not from the transport — see below.
    log.info({ reason }, 'closing peer');
    sub.transport.close();
  },
  onError: (err) => log.error({ err }, 'send failed'),
});

hub.subscribe('ticks', onTick, { transport: channel });
hub.publish('ticks', { n: 1 });
```

Note `transport: channel` on `subscribe`, not on the hub. The hub's `send(sub, frame)` receives the subscriber, and `sub.transport` is how one adapter serves many subscriptions over one channel.

`close` takes **no arguments**, so take the reason from the hub's own `close(sub, reason)` argument — that string is the only record of why.

## Two refusals, and only one of them is seen

This is the design decision most likely to surprise you, so it is worth stating plainly.

A data channel caps a **single** SCTP message. Above the negotiated size, `send()` throws rather than buffering, so a refusal is permanent: no amount of retrying makes a frame smaller. `PowerRTCChannel` checks before calling the platform and enforces the ceiling from `RTCSctpTransport.maxMessageSize`.

But the two refusals have to differ, because a hub cannot see one of them:

- **Not open → `false`.** Transient. Retry. Same contract as `PowerSocketAdapter.send`, and it must not become an `onError` per frame during every connect race.
- **Over the message-size ceiling → `throw`.** Permanent, and **the only outcome a hub can observe.**

`PowerRealtimeHub` increments `stats().delivered` _before_ calling a `send(sub, frame)` adapter, and invokes your subscriber's handler on the success path of whatever the adapter returned. A `false` is not a rejection. So an adapter that refused an over-size frame by returning `false` would **lose the frame with `delivered` already incremented** — a silent drop behind a counter that says it arrived. Throwing routes it to `onError` and leaves the batch uncounted.

The uncomfortable corollary, and it applies to `PowerSocketAdapter` identically:

> **A hub cannot see a `false`.** If a frame is published while the channel is still connecting, the transport refuses it, `sendRefusals` increments — and the subscriber's handler runs anyway, believing it processed a frame that never left the process. There is no error, because nothing went wrong.

So if you are wiring this straight into a hub, **watch `stats().sendRefusals`**. A non-zero value means your consumer is being told about frames the transport never carried. `sent` versus `sendRefusals` is the whole picture.

```js
setInterval(() => {
  const { sent, sendRefusals, oversizeFrames } = channel.stats();
  if (sendRefusals > 0) log.warn({ sendRefusals }, 'frames refused, not delivered');
  if (oversizeFrames > 0) alert({ oversizeFrames }, 'payloads exceed the SCTP ceiling');
}, 10_000);
```

Bound oversized payloads at the peer that produces them. `oversizeFrames` is a counter, not a queue: the frame never reached the transport.

## Back-pressure is pushed here

`PowerWebSocketClient` needs four options — `highWaterMarkBytes`, `lowWaterMarkBytes`, `pollIntervalMs`, `maxPollIntervalMs` — plus a timer that backs off, all to _approximate_ a low-water mark, because `WebSocket` has no event for it. A producer that stops polling stops noticing the socket drain.

A data channel has the event. Setting `bufferedAmountLowThreshold` makes the platform **push** `bufferedamountlow` when the buffer falls back to it, so this class has exactly **one** watermark option and no timer at all:

```js
const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 64 * 1024 });

// The platform threshold is armed for you:
dc.bufferedAmountLowThreshold; // 65536

while (queue.length && !channel.isBackpressured) channel.send(queue.shift());
```

The flag is raised by `send()` and cleared by the event, so it stays accurate without anything scheduled. `backpressureEvents` counts _transitions into_ the state, not sends made while over the mark — "how often did this channel back up", not "how many frames did it send", which is the `sent` count again.

`highWaterMarkBytes: 0` disables the watermark. It does **not** write `0` to the platform property: the default of `0` makes `bufferedamountlow` fire whenever the buffer reaches empty, which would turn the push signal into a metronome.

Note the option is **also a mutation of your channel** — it overwrites any `bufferedAmountLowThreshold` you had set.

## ⚠️ `bufferedAmount` does not come back down after a close

**RT-018.** This is the trap the WebSocket guide documents, and it applies here unchanged: a `WebSocket`'s `bufferedAmount` stays at whatever it was when the socket closed. `RTCSctpTransport.bufferedAmount` is the same shape of number with the same "queued to be sent" meaning, and RT-018 measured the consequence — a producer looping on `bufferedAmount > highWaterMark` waits on a figure that never falls, with no diagnostic and no error. A silent total failure, one layer below the one this class exists to prevent.

So `bufferedAmount` is gated:

| Channel state                     | `channel.bufferedAmount`            |
| --------------------------------- | ----------------------------------- |
| open                              | the platform's figure               |
| `connecting`, `closing`, `closed` | `0`                                 |
| disposed                          | `0` (the channel reference is gone) |
| figure is `NaN` or unreadable     | `0`                                 |

The gate is the adapter's, not a mutation of your channel — `dc.bufferedAmount` itself is untouched. An unreadable figure coerces to `0` rather than propagating, because `NaN > mark` is false: a `NaN` would read as _never backed up_ and silently defeat back-pressure entirely. A numeric string is read as the number, which is correct.

`isBackpressured` is cleared on close for the same reason. A stranded buffer must not become a permanent stall.

## Reliability is read-only, so ask or report

`ordered` and `maxRetransmits` are fixed by `createDataChannel()` and **cannot be changed afterwards**. This class cannot make a channel UDP-like — only tell you it is not:

```js
const channel = new PowerRTCChannel(dc, { expectUnreliable: true });
// throws TypeError if dc.ordered !== false || dc.maxRetransmits !== 0
```

That check runs _before_ anything is attached or mutated, so a refusal leaves no listener on your channel and no threshold changed. Leave it off and read it at runtime instead:

```js
const { ordered, maxRetransmits } = channel.stats();
// alert on ordered === false && maxRetransmits === 0
```

A helper that reported "UDP-like" while silently accepting the _default_ reliable channel would be the class of defect this repository exists to prevent: every latency claim built on that assumption would be false, and nothing would say so.

Also worth knowing about `ordered: false`: it means **inbound messages can arrive out of order**. The hub's per-subscriber ordering guarantee covers outbound frames only, from `send()` to `send()`. Inbound, each message is self-delimiting, so treat them independently.

## Using a channel inside a worker

`RTCDataChannel` is a **transferable object**, so you can create it on the main thread and hand it to a worker — which is how a WebRTC peer connection gets established while the work runs elsewhere:

```javascript
// main thread
const dc = pc.createDataChannel('hub', { ordered: false, maxRetransmits: 0 });
worker.postMessage({ dc }, [dc]);

// worker
const { dc } = await import('performance-helpers');
const channel = new PowerRTCChannel(dc, { expectUnreliable: true });
```

Two things follow from the transfer:

- **Your channel object is detached** on the thread that sent it. `readyState` throws there, and `send()` throws. Construct the adapter on the receiving side, where the channel is live — which is what the code above does, and why the adapter reads `readyState` once and caches it.
- **The adapter belongs to the worker.** `dispose()` on the worker side closes the channel; do not try to close it from the main thread afterwards.

## Options

| Option                |                            Type |     Default | Description                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------: | ----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onMessage`           |                      `Function` | `undefined` | Called per inbound message as `{ data, channel }`, with the raw `MessageEvent.data` — **not decoded**, since `binaryType` is `arraybuffer` by default.                                                                                                                                                   |
| `onOpen`              |                      `Function` | `undefined` | The channel is open and `send()` will be served. **Fires for a channel that was already open at construction**, not only from the `open` event: a transferred channel never fires it again.                                                                                                              |
| `onClose`             |                      `Function` | `undefined` | The channel closed, as `{ reason, channel }`. `reason` is `'local'` if this class called `close()`, otherwise `'remote'` — the platform carries no code and no reason, so that is all it can say.                                                                                                        |
| `onError`             |                      `Function` | `undefined` | A transport, listener-registration, or `send()` error, as `(err, channel)`. A throwing `onError` is swallowed.                                                                                                                                                                                           |
| `highWaterMarkBytes`  |                        `number` |     `65536` | Above this `bufferedAmount`, `isBackpressured` is `true`. Written to the channel's `bufferedAmountLowThreshold`, so it **overwrites** any threshold already there. `0` disables the watermark and does not write the property.                                                                           |
| `maxMessageSizeBytes` |                        `number` |  negotiated | Largest frame this channel may be asked to send. Defaults to `RTCSctpTransport.maxMessageSize`, and to 256 KiB where the platform exposes none. **Enforced, not reported** — see [Two refusals](#two-refusals-and-only-one-of-them-is-seen). `Infinity` delegates the check to the platform's own throw. |
| `expectUnreliable`    |                       `boolean` |     `false` | Assert at construction that the channel is `ordered: false` and `maxRetransmits: 0`, and throw `TypeError` if not. Those are fixed by `createDataChannel()`, so this class cannot set them — only check them.                                                                                            |
| `observability`       | `boolean` \| `MetricsCollector` |     `false` | Opt in to metrics: `true` registers under the prefix `rtc`, or pass a collector of your own. See `guides/metrics.md`.                                                                                                                                                                                    |

An unrecognised option **throws** rather than being ignored — an option that was silently inert is the failure RT-016's `initialBuffer` was.

## API

| Member                             | Returns   | Notes                                                                                                                                      |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `send(frame)`                      | `boolean` | `false` when not open. **Throws** for a frame over `maxMessageSizeBytes` — see [Two refusals](#two-refusals-and-only-one-of-them-is-seen). |
| `readyState`                       | `number`  | A numeric `READY_STATE`, mapped from the platform's string.                                                                                |
| `isOpen`                           | `boolean` | Open, and not disposed.                                                                                                                    |
| `bufferedAmount`                   | `number`  | `0` unless open — see [the trap above](#-bufferedamount-does-not-come-back-down-after-a-close).                                            |
| `isBackpressured`                  | `boolean` | Raised by `send()`, cleared by `bufferedamountlow` or by a close.                                                                          |
| `canPing`                          | `boolean` | Always `false`. There is no protocol-level ping on a data channel.                                                                         |
| `close()`                          | `void`    | No arguments — the platform takes none. Idempotent.                                                                                        |
| `stats()` / `getStats()`           | `object`  | Counters, the channel's live reliability, and transport state. Both names work.                                                            |
| `dispose()` / `[Symbol.dispose]()` | `void`    | Detaches all six listeners and closes the channel. Works with `using`.                                                                     |

`stats()` reports `ordered`, `maxRetransmits`, `maxPacketLifeTime`, `binaryType`, `maxMessageSizeBytes`, `highWaterMarkBytes` and `canPing` alongside the counters, and reads the first four **live** rather than caching them at construction.

## Troubleshooting

| Symptom                                              | Cause                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send()` always returns `false`, `stats().sent` is 0 | The channel never opened. Check `readyState` — and remember it is a **string** on the raw object, so `=== READY_STATE.OPEN` will not work on `channel.channel`.                                        |
| Consumer processed frames the peer never received    | `sendRefusals > 0`. A hub cannot see a `false` from its `send` adapter.                                                                                                                                |
| `onError` with `code: 'ERR_FRAME_TOO_LARGE'`         | A frame exceeded `maxMessageSizeBytes`. It was stopped **before** `send()` — it never went on the wire. Bound the payload at the producer.                                                             |
| Producer stops permanently after a close             | You are reading `dc.bufferedAmount` directly. Use `channel.bufferedAmount`, which is gated — see the trap above.                                                                                       |
| No RTT anywhere                                      | There is no protocol-level ping on a data channel; nothing defines one beneath SCTP. `canPing` is `false` and there is no `rtt` field, by design. Liveness is the `close` event plus message activity. |

## See also

- [`PowerSocketAdapter`](powerSocketAdapter.md) — the same normalisation for `ws`, `WebSocket` and `WebSocketStream`. No `ping()` there either.
- [`PowerRealtimeHub`](powerRealtimeHub.md) — the fan-out this is a transport for.
- [`PowerWebSocketClient`](powerWebSocketClient.md) — the dialling side, and the four watermark options this class does not need.
- [`PowerMessageCodec`](powerMessageCodec.md) — the framing. `binaryType` is `arraybuffer`, so a `Uint8Array` goes straight in.
