[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRTCChannel](../README.md) / PowerRTCChannel

# Class: PowerRTCChannel

PowerRTCChannel

 PowerRTCChannel

## Example

```ts
// Peer side. `dc` came from `pc.createDataChannel('hub', { ordered: false, maxRetransmits: 0 })`
// or from a `datachannel` event on the answering side.
const channel = new PowerRTCChannel(dc, {
  expectUnreliable: true,
  highWaterMarkBytes: 64 * 1024,
  onMessage: ({ data }) => handle(decodeMessage(data)),
  onClose: ({ reason }) => log.warn({ reason }, 'peer went away'),
});

const hub = new PowerRealtimeHub({
  send: (sub, frame) => sub.transport.send(frame),
  close: (sub) => sub.transport.close(),
  onError: (err) => log.error({ err }, 'send failed'),
});
hub.subscribe('ticks', onTick, { transport: channel });
```

## Constructors

### Constructor

> **new PowerRTCChannel**(`channel`, `options?`): `PowerRTCChannel`

#### Parameters

##### channel

`any`

An `RTCDataChannel`, or anything with its shape. It
  may still be `connecting`: `send()` refuses until `open`, and `onOpen`
  reports when that changes.

##### options?

`PowerRTCChannelOptions` = `...`

#### Returns

`PowerRTCChannel`

## Properties

### \_backpressured

> **\_backpressured**: `boolean`

Whether the outgoing buffer is above the high-water mark.

**Set from the send path, cleared from the event**, which is what makes it
accurate without a timer: `send()` is the only thing that raises the
buffer, and `bufferedamountlow` is the only thing that lowers it. Reading
`bufferedAmount > mark` on each send covers the raise; the event covers the
fall. Polling on a timer would answer the same question later and cost a
wakeup for it.

***

### \_closedByUs

> **\_closedByUs**: `boolean`

***

### \_counters

> **\_counters**: `object`

#### backpressureEvents

> **backpressureEvents**: `number` = `0`

#### bytesIn

> **bytesIn**: `number` = `0`

#### bytesOut

> **bytesOut**: `number` = `0`

#### closed

> **closed**: `number` = `0`

#### droppedFrames

> **droppedFrames**: `number` = `0`

#### handled

> **handled**: `number` = `0`

#### lowBufferEvents

> **lowBufferEvents**: `number` = `0`

#### messages

> **messages**: `number` = `0`

#### opened

> **opened**: `number` = `0`

#### oversizeFrames

> **oversizeFrames**: `number` = `0`

#### queuedBytes

> **queuedBytes**: `number` = `0`

#### queuedFrames

> **queuedFrames**: `number` = `0`

#### sendFailures

> **sendFailures**: `number` = `0`

#### sendRefusals

> **sendRefusals**: `number` = `0`

#### sent

> **sent**: `number` = `0`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_highWaterMark

> **\_highWaterMark**: `number`

***

### \_listeners

> **\_listeners**: \[`string`, (`any`) => `void`\][]

Everything this class attached to the caller's channel, so `dispose()` can
undo all of it. A listener nobody remembers to remove is the leak this
field exists to make impossible, and the listener count in
`test/powerRTCChannel.test.js` asserts it is back to zero — six on the way
in, which is what makes a seventh addition a deliberate edit.

***

### \_lowWaterMark

> **\_lowWaterMark**: `number`

***

### \_maxMessageSizeBytes

> **\_maxMessageSizeBytes**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_onClose

> **\_onClose**: ((`arg0`) => `void`) \| `null`

***

### \_onError

> **\_onError**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### \_onMessage

> **\_onMessage**: ((`arg0`) => `void`) \| `null`

***

### \_onOpen

> **\_onOpen**: ((`arg0`) => `void`) \| `null`

***

### \_queue

> **\_queue**: `any`[]

Frames held while the channel is paused, and the bytes they occupy.

**A queue, not a buffer of last resort.** It exists so a producer that
outruns the SCTP congestion window is slowed rather than broken: the
platform's own `bufferedAmount` keeps growing until the browser kills the
connection, which is the failure this prevents. It is bounded by
`queueBudget`, and over budget `send()` refuses — the producer's signal to
slow down, which is what a watermark is for.

***

### \_queueBudget

> **\_queueBudget**: `number`

***

### \_queuedBytes

> **\_queuedBytes**: `number`

***

### \_state

> **\_state**: `number`

***

### channel

> **channel**: `any`

## Accessors

### bufferedAmount

#### Get Signature

> **get** **bufferedAmount**(): `number`

Bytes buffered by the transport for sending.

**`0` unless the channel is open** — the RT-018 trap, and it applies here
unchanged. A buffered-amount number that never comes back down turns a
producer's watermark wait into a spin: every check keeps failing and nothing
reports why. MDN documents the behaviour on `WebSocket.bufferedAmount`, and
`RTCSctpTransport.bufferedAmount` is the same shape of number with the same
"queued to be sent" meaning, so a caller writing the naive loop against this
class would hang on a closed channel for the same reason.

A non-numeric value is coerced to `0` rather than propagated. `NaN` compares
false against every watermark, so a proxy or a double reporting a string
would read as *never backed up* and silently defeat back-pressure — the
quieter and worse direction.

##### Returns

`number`

***

### canPing

#### Get Signature

> **get** **canPing**(): `boolean`

Whether the transport exposes a usable probe.

Always `false`, and reported rather than omitted. There is no protocol-level
ping on a data channel — nothing answers one, because there is no framing
layer beneath it to define one — so liveness here is the `close` event plus
message activity. RT-003 established that a transport which cannot measure
must say "unmeasured" rather than report `0 ms`, and a helper that reported
no RTT field at all would leave a caller comparing it against a sibling
helper's `rtt` with nothing to compare.

##### Returns

`boolean`

***

### isBackpressured

#### Get Signature

> **get** **isBackpressured**(): `boolean`

Whether a producer should pause.

The push-signal answer: no poll timer, no backing off, and it cannot be
forgotten by a caller who stopped checking a timer.

```js
while (messages.length && !channel.isBackpressured) channel.send(messages.shift());
```

`false` forever when `highWaterMarkBytes` is `0`, which is what disabling the
watermark means.

##### Returns

`boolean`

***

### isOpen

#### Get Signature

> **get** **isOpen**(): `boolean`

Whether the channel is open and this class has not been disposed.

##### Returns

`boolean`

***

### queuedBytes

#### Get Signature

> **get** **queuedBytes**(): `number`

Bytes held in the JS-side queue while the channel is paused.

AUD-024. The number that says how far behind the producer is, as against
`bufferedAmount`, which says how far behind the *platform* is. A channel can
be paused with an empty platform buffer and a full queue — that is the whole
point of holding frames locally — so the two answer different questions and
neither implies the other.

Bounded by `queueBudget`; `send()` refuses once it would be exceeded.

##### Returns

`number`

***

### queuedFrames

#### Get Signature

> **get** **queuedFrames**(): `number`

Frames held in the JS-side queue while the channel is paused.

##### Returns

`number`

***

### readyState

#### Get Signature

> **get** **readyState**(): `number`

The channel's lifecycle state, as a numeric `READY_STATE`.

The same numbers `PowerWebSocketClient` and `PowerSocketAdapter` report, for
the reason in the module docblock: the platform's own value is a string, and
comparing it to `READY_STATE` is always false.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerRTCChannel#dispose](#dispose-1), so `using` works.

#### Returns

`void`

***

### close()

> **close**(): `void`

Close the channel.

**No code and no reason.** `RTCDataChannel.close()` takes no arguments, and
the `close` event carries neither — unlike `WebSocket`, which hands you a
`CloseEvent` with both. A `PowerRealtimeHub` `close(sub, reason)` adapter
therefore has to take its reason from its own argument; the hub supplies
`'unsubscribe'`, `'slow-consumer'` or `'hub-closed'` and that string is the
only record of why, so pass it to your own logging there.

Safe to call more than once, and safe on a channel that closed first.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Detach every listener and drop the caller's channel reference.

Required rather than tidy, for the reason `PowerSocketAdapter.dispose` is:
an `RTCDataChannel` outliving its adapter keeps every handler closure alive,
and a peer table that never disposes leaks one adapter per peer for the life
of the page. `dispose()` also **closes** the channel — an adapter that
detached from a still-open channel leaves a transport nobody is reading.

`dispose()` is idempotent and does **not** null the caller's callbacks'
closures' targets beyond this object, but it does null its own handler
fields, so a message already in flight cannot reach a torn-down adapter.

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats).

See `guides/stats-naming.md` for why both spellings exist and why this
method is written out per class.

#### Returns

`object`

***

### send()

> **send**(`frame`): `boolean`

Send one frame.

**Two refusals, and they are not the same thing.** This is the whole design
decision on this method, so it is worth being explicit:

- **Not open → `false`.** Transient. The caller retries. This matches
  `PowerSocketAdapter.send`, whose documented contract is "false means not
  now", and it is the guard that keeps a `connecting` channel from throwing
  `InvalidStateError` out of [send](#send).

  **A hub cannot see it.** `PowerRealtimeHub` increments `delivered` *before*
  calling a `send(sub, frame)` adapter and invokes the subscriber's handler
  on the success path of whatever the adapter returned — so a `false` is not
  a rejection, and the consumer is told it processed a frame that never left
  the process. `PowerSocketAdapter` has the same property. The only trace is
  `stats().sendRefusals`, so if a caller is wiring this straight into a hub
  they must watch it; the guide says so and
  `test/powerRTCChannel.hub.test.js` pins it.
- **Over the message-size ceiling → `throw`.** Permanent. No amount of
  retrying makes an oversized frame small, so a caller looping on `false`
  would spin on it forever. Throwing is also the only thing a hub can
  observe: it routes a throw to `onError` and leaves `delivered` uncounted
  for that batch, whereas a `false` would lose the frame with `delivered`
  already incremented. So the throw is not a stricter contract for its own
  sake — it is the only outcome that reaches anyone.

The frame is handed to the platform **without a copy**, which is safe because
`RTCDataChannel.send()` serialises synchronously — the same guarantee
`WebSocket.send()` gives. It matters because `PowerRealtimeHub` hands every
subscriber of a topic **the same buffer** (its RT-006 encode memo), so a
transport that wrote into the frame would corrupt every other subscriber. A
transport that *retains* the frame past the call — a stream writer, for
instance — must copy it.

#### Parameters

##### frame

`string` \| `ArrayBuffer` \| `ArrayBufferView`\<`ArrayBufferLike`\>

#### Returns

`boolean`

`false` when the channel is not open. Throws only for a
  frame this channel can never carry.

***

### stats()

> **stats**(): `object`

Counters, the channel's configured reliability, and the live transport state.

`ordered` / `maxRetransmits` / `maxPacketLifeTime` are reported because this
class cannot set them (they are fixed by `createDataChannel()`), which makes
"what am I actually getting" a question only a runtime read can answer. A
dashboard can alert on `ordered === false && maxRetransmits === 0` and catch
a peer that negotiated a different channel than the application believes it
asked for.

#### Returns

`object`
