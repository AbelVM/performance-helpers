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

### 2. Streams (where `WebSocketStream` exists)

`WebSocketStream` is a Promise-based alternative built on the Streams API and therefore "can take advantage of stream back-pressure automatically". It is not yet standard or universally available, so it is feature-detected:

```javascript
const client = new PowerWebSocketClient({ url }); // no WebSocketStreamImpl
const client2 = new PowerWebSocketClient({ url, WebSocketStreamImpl: WebSocketStream });
client.backpressureMode; // 'streams' | 'watermark' | 'none'
```

With the Streams tier there is no polling at all: `send()` awaits `writer.ready`, so the returned promise resolves only when the socket has room. That is a stronger guarantee than a watermark, because there is no window in which a message can be queued into a full buffer.

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

## Connect timeout

`connectTimeoutMs` (default 10 s) aborts an attempt that never completes, rejecting with `ERR_WS_CONNECT_TIMEOUT`. Without it, a silently-failing DNS or a black-holed TCP connect hangs the promise forever.

## API

- `connect()` → `Promise<void>`, resolves when open, rejects on failure or timeout.
- `send(message, { dropOnBackpressure })` → `Promise<boolean>`. For a **plain value**.
- `sendFrame(frame, { dropOnBackpressure })` → `Promise<boolean>`. For an **already-framed** `Uint8Array`; throws a `TypeError` on anything else.
- `close(code = 1000, reason = '')` / `[Symbol.dispose]()`.
- `on(type, handler)` → one-shot unsubscribe; `off(type)`. Types: `message`, `open`, `close`, `error`, `pause`, `resume`. One handler per event; registering again replaces.
- `ping()` — application-level ping, for protocols that expose one.
- `stats()` → `{ readyState, backpressureMode, paused, bufferedAmount, highWaterMark, lowWaterMark, reconnectAttempts, sent, received, drops, decodeErrors, reconnects, heartbeatTimeouts, rtt }`.
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
