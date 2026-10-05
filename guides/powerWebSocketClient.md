# PowerWebSocketClient

Reconnecting WebSocket client with **explicit back-pressure**, heartbeats, and `PowerMessageCodec` framing.

## The problem this exists for

The `WebSocket` interface has **no back-pressure**. MDN is blunt about it:

> The `WebSocket` interface … **doesn't support back-pressure**. As a result, when messages arrive faster than the application can process them it will either fill up the device's memory by buffering those messages, become unresponsive due to 100 % CPU usage, or both.

A producer that ignores this OOMs the client — and on a server fanning out to many sockets, OOMs the server too. Two mitigations exist, and this client uses whichever is available.

## Two back-pressure tiers

### 1. `bufferedAmount` watermarks (universal)

`send()` returns immediately and the browser buffers internally, so the producer must watch `socket.bufferedAmount` and stop feeding it above a high-water mark. This is the fallback, and it is always active unless the Streams tier is in use.

```javascript
const client = new PowerWebSocketClient({
  url: 'wss://example.test/feed',
  highWaterMarkBytes: 1 << 20, // pause above 1 MiB buffered
  lowWaterMarkBytes: 1 << 19, //  resume below 512 KiB
  onPause: () => feed.pause(),
  onResume: () => feed.resume(),
});
```

- `paused` / `onPause` / `onResume` tell a producer to stop and start. **Drive your feed from these** rather than polling.
- The poll interval **backs off** while paused (up to `maxPollIntervalMs`), so a stuck socket does not spin the event loop. MDN's own advice is to poll; doing it on a backing-off timer is the difference between a CPU pegged at 100 % and one that is not.
- `lowWaterMarkBytes` must be ≤ `highWaterMarkBytes`; otherwise the socket would pause and never resume. That is rejected at construction.

#### `bufferedAmount` does not reset on close — gate on `readyState`

MDN, on `WebSocket.bufferedAmount`:

> This value does not reset to zero when the connection is closed; if you keep
> calling `send()`, this will continue to climb.

So the number that is supposed to tell you the socket is full **keeps growing on a
socket that is not open**, and never comes back down. That makes a naive wait
loop into a hang rather than into back-pressure:

```javascript
// Spins forever on a closed socket: bufferedAmount only climbs.
while (socket.bufferedAmount > highWaterMarkBytes) {
  await new Promise((r) => setTimeout(r, 10));
}
```

Two things make it worse than an ordinary hang. The loop is usually written
_before_ the close, so it is correct in testing and hangs in production; and
because `bufferedAmount` is climbing, every check passes, so nothing ever throws
and no timeout fires.

Gate on `readyState` instead, and treat a socket that is not open as "no
back-pressure" rather than "full":

```javascript
while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > highWaterMarkBytes) {
  await new Promise((r) => setTimeout(r, 10));
}
if (socket.readyState !== WebSocket.OPEN) {
  // Closed or closing: stop sending, do not wait for room that never comes.
}
```

**This client already does both halves**, which is why the trap cannot bite you
here: `bufferedAmount` returns `0` unless `readyState === OPEN`, so a
not-yet-open or closed socket reads as empty rather than full, and the poll runs
on the backing-off timer above rather than in a tight loop. That is a deliberate
property and not an accident of the getter — reading the raw socket instead would
reintroduce the hang.

### 2. Streams (where `WebSocketStream` exists)

`WebSocketStream` is a Promise-based alternative built on the Streams API and therefore "can take advantage of stream back-pressure automatically". It is not yet standard or universally available, so it is feature-detected:

```javascript
const client = new PowerWebSocketClient({ url }); // no WebSocketStreamImpl
const client2 = new PowerWebSocketClient({ url, WebSocketStreamImpl: WebSocketStream });
client.backpressureMode; // 'streams' | 'watermark' | 'none'
```

With the Streams tier there is no polling at all: `send()` awaits `writer.ready`, so the returned promise resolves only when the socket has room. That is a stronger guarantee than a watermark, because there is no window in which a message can be queued into a full buffer.

Inbound works the other way round, and it is worth knowing that it is a **reader**: once the connection opens the client takes a reader from `readable` and pumps frames through the same decode path the socket tier uses. Two consequences you can observe:

- A `WebSocketStream` has no `message` event, so nothing arrives unless someone takes that reader. The client does, on every connection — including reconnects — and holds the handle so `close()` can `cancel()` it. A pending `read()` keeps the stream locked, so dropping the handle would leak the lock and leave the _next_ connection unable to supply a reader at all.
- `close()` cancels the reader before aborting the writer, because aborting the write side does not release a read lock.

A `read()` that rejects is reported as an `error` event rather than thrown, and deliberately does **not** trigger a reconnect: synthesising a close would invent a `close` event and a close code the peer never sent. The trade-off is that a stream failing _after_ it opened leaves a deaf open socket — a real limitation, not a settled design.

## What back-pressure you actually get

Worth being precise, because it is the part people get wrong:

| tier      | `send()` resolves when                                                | what the producer must do                                   |
| --------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| watermark | the frame is handed to `socket.send()` — i.e. the browser buffered it | honour `onPause`/`onResume`; there is nothing left to await |
| streams   | the writer had room and accepted the frame                            | nothing, just `await`                                       |

At the watermark tier the browser has already buffered the message by the time `send()` resolves, so awaiting it tells you nothing. That is exactly why `onPause`/`onResume` exist. Use `send(msg, { dropOnBackpressure: true })` for telemetry where a gap beats growing a buffer.

## Composing with `PowerRealtimeHub`

The two helpers handle back-pressure at different layers, and the composition is the point:

- **This client** owns the socket-level watermark — it stops a single slow socket accumulating megabytes in the browser.
- **`PowerRealtimeHub`** owns per-subscriber bounded queues — it bounds what a slow client can cost _across_ a fan-out, and sheds load with a declared policy.

Wire them together with `sendFrame`, **not** `send`:

```javascript
import { PowerRealtimeHub, PowerWebSocketClient } from 'performance-helpers';

const client = new PowerWebSocketClient({
  url: 'wss://example.test/feed',
  onPause: () => feed.pause(),
  onResume: () => feed.resume(),
});

const hub = new PowerRealtimeHub({
  // The hub hands `send` an already-framed payload. `send()` would try to
  // JSON-serialise those bytes and corrupt them.
  send: (sub, frame) => client.sendFrame(frame, { dropOnBackpressure: true }),
  close: (sub) => client.close(1013, 'slow consumer'),
});

client.on('message', (m) => hub.publish('feed', m));
hub.subscribe('feed', (m) => render(m), { maxQueue: 32, slowConsumer: 'drop-newest' });
```

The same principle applies to `PowerPool` workers, which also send pre-framed payloads: use `sendFrame` whenever the bytes are already a frame, `send` for a plain value.

## Heartbeats

A socket can sit in `OPEN` forever while nothing gets through — common behind proxies and load balancers, which drop idle connections without a close frame. So the client pings and treats silence as death:

```javascript
new PowerWebSocketClient({
  url,
  heartbeatIntervalMs: 30_000, // ping this often; 0 disables
  heartbeatTimeoutMs: 10_000, // no pong in this long => the socket is dead
});
```

RTT samples land in a `PowerHistogram` (DDSketch), exposed as `stats().rtt.{p50,p95,p99}`.

## Reconnection

An unexpected close triggers reconnection with **decorrelated-jitter** backoff (AWS, _Exponential Backoff and Jitter_, 2015) — `sleep = min(cap, sleep/2 + random(sleep/2))`, tripling `sleep` each time. This decorrelates far better than plain exponential backoff, which matters here because a server restart otherwise produces a synchronised reconnect stampede from every client at once.

- `maxReconnectAttempts` defaults to `Infinity`.
- A successful open resets the counter and the backoff.
- `close()` sets a user-initiated flag, so it never reconnects.

### Bounding a reconnect run

An attempt _count_ alone bounds nothing useful: a peer that closes the connection the instant you accept it produces one attempt per second for as long as you tolerate it. `maxReconnectElapsedMs` is the wall-clock ceiling on a single reconnect run, and the two compose — whichever is reached first stops the run.

```javascript
new PowerWebSocketClient({
  url,
  maxReconnectAttempts: 10,
  maxReconnectElapsedMs: 120_000, // 2 minutes, then stop
});
```

When a run ends because a bound was reached, `stats().reconnectExhaustedBy` says **which** one — `'attempts'` or `'elapsed'`, and `null` while reconnection has not been stopped. They mean different things to whoever is alerting: a run stopped by a count suggests the peer is refusing, one stopped by the clock suggests the outage outlived the budget. Without the distinction both read as "reconnect failed".

Both default to `Infinity`, which is the documented anti-pattern for an always-on connection: _"Should I reconnect a WebSocket forever? No… Retrying forever wastes mobile battery and server resources with no benefit."_ The finite defaults are a **3.0** change, because turning them on by default closes sockets that currently stay open — a behaviour change this release does not make silently. Set at least one bound explicitly.

### Declaring a close code non-retryable

**New in 2.0, opt-in, default `[]`.** Backoff bounds _how long_ a client keeps trying; they do not stop it from trying at all. A peer that closes with **1008** (policy violation), **1001** (going away) or **1002** (protocol error) is telling you something specific, and reconnecting immediately — with the decorrelated jitter, so within a second or two — means every client in your fleet re-offers the same connection the server just refused. That is the stampede the backoff exists to prevent, arriving through the one door the backoff does not close.

```javascript
new PowerWebSocketClient({
  url,
  nonRetryableCloseCodes: [1008, 1001, 1002],
});
```

What a matching close does:

- **No reconnect timer is armed.** The check runs ahead of every reconnect input —
  `autoReconnect`, `maxReconnectAttempts`, `maxReconnectElapsedMs` — so a bound
  cannot re-enable it, and a future `shouldReconnect` callback cannot outrank a
  code you declared terminal.
- **`readyState` goes to `CLOSED`** and the `close` event **is** emitted with the
  original event, so an `onClose` handler still runs.
- **It is not latched.** `connect()` afterwards works, because a code can be
  terminal for one close and wrong for the next.
- `stats()` records `reconnects: 0`, `reconnectAttempts: 0` and
  **`reconnectExhaustedBy: 'close-code'`** — a third value alongside `'attempts'`
  and `'elapsed'`. It is the only thing that distinguishes "stopped because you
  said so" from "stopped because `autoReconnect: false`", and the three mean
  different things to whoever is alerting.

Validation: a non-array throws, and so does an entry that is not a close code.
Duplicates are legal and order is irrelevant — the array is copied at
construction, so mutating yours afterwards does not change the client's mind.
Numeric strings match (`'1008'` matches `1008`); everything else is compared
numerically against `event.code`.

Note what this does **not** do: it does not make the close _recoverable_. A
declared code is a decision that reconnecting is wrong, not an instruction to
open a new connection later on a schedule. If you want "stop now, try again in
30 seconds", that is a `close` handler of your own calling `connect()` on a
timer.

## Connect timeout

`connectTimeoutMs` (default 10 s) aborts an attempt that never completes, rejecting with `ERR_WS_CONNECT_TIMEOUT`. Without it, a silently-failing DNS or a black-holed TCP connect hangs the promise forever.

## Oversized frames: detection, not prevention

```javascript
const client = new PowerWebSocketClient({
  url,
  maxPayloadSizeBytes: 1 << 20, // 1 MiB
  onError: (err) => {
    if (err.code === 'ERR_FRAME_TOO_LARGE') {
      metrics.increment('ws.frame.oversize', { size: err.size });
    }
  },
});
```

**Read the option name as what it is.** By the time a `message` event fires, the platform has already received and materialised the whole frame — a `Blob` in a browser, an `ArrayBuffer` once `binaryType` is set. Nothing at this layer can stop that allocation, so `maxPayloadSizeBytes` **counts** the frame (`stats().oversizeFrames`) and emits an `error` naming the size and the limit, then decodes and delivers it as usual.

### If the platform refuses `binaryType`

The client sets `binaryType = 'arraybuffer'` at connect and **remembers if that is refused** — a getter-only accessor throws on assignment, and the platform default for a binary frame is then a `Blob`. **The `Blob` is converted here**, so the frame decodes and is delivered; and you still get **one** `error` saying so, because a platform that ignores an option this client set is worth knowing about even though nothing is broken.

```
one error: this platform refused binaryType="arraybuffer", so binary frames arrive as
Blob and are converted here instead. Conversion is asynchronous, so inbound delivery
becomes asynchronous once it first happens: frames are still delivered in order, but no
longer inside the "message" listener. Pass a WebSocketImpl that honours binaryType to
avoid both. Conversion costs about 0.045 ms per 64 KiB frame.
```

Two things follow from that, and both are contract rather than implementation detail.

**Delivery becomes asynchronous once the first `Blob` arrives, and stays that way for the connection.** A `Blob` can only be read with `await blob.arrayBuffer()`, and `_handleMessage` runs inside a `message` listener whose returned promise **nobody awaits** — so converting inline would let a later text frame overtake an earlier binary one, and delivery order would depend on how fast each conversion happened. Instead every frame that needs converting, **and every frame behind it**, joins a serial chain. If your platform honours `binaryType` — every browser that supports it, and Node's `ws` — nothing joins, delivery stays synchronous for the whole connection, and the cost is one property read per frame.

**`close` is ordered behind the chain too.** `readyState` and the timers change synchronously, because `CLOSED` is the peer's news rather than an ordering decision, but the `close` event waits for a pending conversion. Otherwise a caller treating `close` as "nothing more will arrive" would be wrong once per connection.

`stats().decodeErrors` now means what its name says: frames the library genuinely could not read. A `Blob` is no longer one of them. A frame that survives conversion and then fails in the codec still counts, and a `Blob` whose `arrayBuffer()` rejects is counted and reported **every time** — unlike the refusal above, two conversion failures are not necessarily the same failure twice.

A measured cost was never the objection — `arrayBuffer()` is ~0.045 ms for a 64 KiB frame, 0.101 ms on the first call. The ordering contract was, and that is what the chain buys.

`0` disables the report, the same convention `highWaterMarkBytes: 0` uses, and the limit is inclusive — a frame exactly at the limit is not over it. A **text** frame is measured in UTF-16 code units rather than UTF-8 bytes, because an exact figure would cost a `TextEncoder` per frame; binary frames, the ones this is for, are exact.

**The codec is safe regardless, which is a separate fact and worth not conflating.** `decodeMessage` validates a declared payload length against the bytes actually present _before_ slicing, so a frame lying about its size throws rather than reserving anything, and the payload is a view rather than a copy. The incremental decoder's `createFrameDecoder({ maxFrameBytes })` is **required** rather than defaulted, because a peer that sends a header and then stops would otherwise pin its buffer at whatever size it named.

`PowerSocketAdapter` carries the same option with the same wording and the same error factory, so one `onError` handler can serve both directions.

## API

- `connect()` → `Promise<void>`, resolves when open, rejects on failure or timeout.
- `send(message, { dropOnBackpressure })` → `Promise<boolean>`. For a **plain value**.
- `sendFrame(frame, { dropOnBackpressure })` → `Promise<boolean>`. For an **already-framed** `Uint8Array`; throws a `TypeError` on anything else.
- `close(code = 1000, reason = '')` / `[Symbol.dispose]()`.
- `await client[Symbol.asyncDispose]()` — present so `await using` works. **A delegation to `dispose()`, not a graceful path**: this client's teardown is `close()`, which is synchronous and already complete, so there is nothing to await. Compare `PowerRealtimeHub`, whose `asyncDispose` flushes pending frames first because it has some.
- `on(type, handler)` → one-shot unsubscribe; `off(type)`. Types: `message`, `open`, `close`, `error`, `pause`, `resume`. One handler per event; registering again replaces.
- `ping()` — application-level ping, for protocols that expose one.
- `stats()` → `{ readyState, backpressureMode, paused, bufferedAmount, highWaterMark, lowWaterMark, reconnectAttempts, reconnectExhaustedBy, sent, received, drops, decodeErrors, oversizeFrames, reconnects, heartbeatTimeouts, heartbeats, rtt }`. `reconnectExhaustedBy` is `'attempts'`, `'elapsed'`, `'close-code'`, or `null`.
- Getters: `isOpen`, `paused`, `bufferedAmount`, `readyState`, `backpressureMode`.

## Error handling

- A frame that fails to decode is **reported and dropped** — it does _not_ tear down the socket. One malformed message is not a reason to drop a working connection.
- A throwing handler is isolated and routed to `onError`.
- A `send` that throws or rejects returns `false` and reports through `onError`.

## Notes

- The client registers through `addEventListener` when available and only falls back to `onX` properties. Registering through both would deliver every event **twice** on a socket that supports both, silently duplicating every message.
- `bufferedAmount` is reported as `0` unless the socket is open, so it can never leak a stale value after a close.
- All internal timers go through `unref()` in Node, so a forgotten client does not keep a process alive.
- Pass `WebSocketImpl` for a non-global implementation, or to inject a test double.
- `lowWaterMarkBytes > highWaterMarkBytes` is a construction error, not a runtime surprise.

## Validation

The numeric options are validated, and they are split by what `0` _means_,
because the two cases are not the same mistake:

| Option                                      | `0` means                | `0` is                 |
| ------------------------------------------- | ------------------------ | ---------------------- |
| `heartbeatIntervalMs`, `heartbeatTimeoutMs` | disable the mechanism    | a request — kept       |
| `highWaterMarkBytes`, `lowWaterMarkBytes`   | disable backpressure     | a request — kept       |
| `connectTimeoutMs`                          | wait as long as it takes | a request — kept       |
| `pollIntervalMs`, `maxPollIntervalMs`       | **spin**                 | not a request — throws |

`pollIntervalMs: 0` was previously `Number(0) || 20`, so a caller who passed
`0` got `20` — and the backoff curve built on top of it was tuned to nothing
they had chosen. Non-finite and negative values now throw for every option
above, where previously a `NaN` produced the default silently.
