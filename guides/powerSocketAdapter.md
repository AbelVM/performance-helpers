# PowerSocketAdapter

One socket interface over Node `ws`, browser `WebSocket`, and `WebSocketStream` — with liveness, per-message rate limiting, and a graceful drain.

## Why this exists

There is no WebSocket **server** in this package, and there should not be. RFC 6455 is a security liability to reimplement, and the `ws` package already does it properly. REJ-007 in the review rejected the idea for exactly that reason.

What is missing is the layer either side of one. A server receives connections from three genuinely different objects, and they are not interchangeable:

| Model               | Emits on         | `message` handler receives | Backpressure signal |
| ------------------- | ---------------- | -------------------------- | ------------------- |
| Node `ws`           | `EventEmitter`   | `(data, isBinary)`         | `bufferedAmount`    |
| Browser `WebSocket` | `EventTarget`    | one `MessageEvent`         | `bufferedAmount`    |
| `WebSocketStream`   | `ReadableStream` | the bare written value     | `writer.ready`      |

The differences are not cosmetic. A handler written for `ws` —

```js
socket.on('message', (data, isBinary) => {
  /* ... */
});
```

— silently **never fires** against an `EventTarget` socket, because the two registration methods differ. `addEventListener` against a `ws` socket throws. And `WebSocketStream` has neither `on`, `addEventListener`, `readyState`, nor `bufferedAmount`, so the "pause the producer when the socket is backed up" loop the MDN docs recommend cannot be written against it at all.

`PowerSocketAdapter` is the same normalisation `WorkerAgnostic` already does for `Worker` constructors, applied to sockets. Wrap once, and the rest of your code does not know which transport it got.

## Usage

```javascript
import { PowerSocketAdapter } from 'performance-helpers/powerSocketAdapter';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws, req) => {
  const adapter = new PowerSocketAdapter(ws, {
    heartbeatIntervalMs: 30_000,
    rateLimit: { limit: 100, windowMs: 1_000 },
    onMessage: ({ data, isBinary, adapter }) => {
      handle(data, isBinary);
      adapter.send(ack);
    },
    onClose: ({ code, reason }) => log.info({ code, reason }, 'socket closed'),
  });

  req.socket.on('close', () => adapter.dispose());
});
```

Or dispose it in a shutdown path, where the drain is what you want first:

```javascript
async function shutdown() {
  await Promise.all([...adapters].map((a) => a.drain(1001, 'server shutting down')));
  server.close();
}
```

## Constructor

`new PowerSocketAdapter(socket, options?)`

`socket` is a Node `ws` socket, a browser `WebSocket`, or a `WebSocketStream`. The transport is detected from the socket's **capabilities**, not its constructor name — the same class is reachable as `ws` in Node, `undici`'s `WebSocket` in newer Node, and the global in a browser, and the last two are different objects sharing a name. An unrecognised object **throws** rather than defaulting, because a silent default would attach no listeners and look healthy while receiving nothing.

Detection order is `stream` → `websocket` → `ws`, and each test asks for the **capability that model actually needs** rather than for a truthy property:

| kind        | detected by                                    |
| ----------- | ---------------------------------------------- |
| `stream`    | `writable.getWriter` (or `readable.getReader`) |
| `websocket` | `addEventListener`                             |
| `ws`        | `on` **and** `send`                            |

Two of those tests are load-bearing in both directions.

The stream test is on the **methods**, not on `readable`/`writable` being truthy, because on a Node `Duplex` — `net.Socket` above all — those two are **booleans**. A truthiness test therefore classified every TCP socket in existence as a `WebSocketStream`: `send()` returned `false` on every call, `isOpen` reported `true`, and not one inbound message was ever delivered while the socket itself was echoing them. A healthy-looking adapter, permanently deaf.

`writable` is checked before `readable` because a `WebSocketStream` reports `readable: null` until its connection opens, and that object is still a stream.

The `ws` test requires `send` as well as `on`, because `on` alone matches every `EventEmitter` in Node. Without it a raw `net.Socket` was accepted as a `ws` socket: it emits `data`, never `message`, so the adapter stayed deaf, and its TCP `close` was reported as a WebSocket close. So a `net.Socket` **throws** — pass `kind` explicitly if you really are adapting one.

## Options

| Option                |                              Type |     Default | Description                                                                                                                                                        |
| --------------------- | --------------------------------: | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                | `'ws' \| 'websocket' \| 'stream'` |    detected | Override detection. An unrecognised value **throws** rather than being stored, because a stored kind that matches no branch would attach nothing and look healthy. |
| `onMessage`           |                        `Function` | `undefined` | Called per accepted inbound message as `{ data, isBinary, adapter }`. A returned promise is awaited by `drain()`.                                                  |
| `onOpen`              |                        `Function` | `undefined` | Socket opened.                                                                                                                                                     |
| `onClose`             |                        `Function` | `undefined` | Socket closed — including a heartbeat or idle timeout. Receives `{ code, reason, adapter }`.                                                                       |
| `onError`             |                        `Function` | `undefined` | Transport, handler, or send error. Receives `(err, adapter)`. A throwing `onError` is swallowed.                                                                   |
| `onRateLimited`       |                        `Function` | `undefined` | An inbound message was refused by the rate limit. Receives the running refusal count.                                                                              |
| `heartbeatIntervalMs` |                          `number` |     `30000` | Send a ping at this interval. `0` disables.                                                                                                                        |
| `heartbeatTimeoutMs`  |                          `number` |     `10000` | Declare the socket dead if no pong or message arrives in this long. `0` disables.                                                                                  |
| `idleTimeoutMs`       |                          `number` |         `0` | Declare the socket dead if nothing at all arrives for this long. `0` disables.                                                                                     |
| `maxPayloadSizeBytes` |                          `number` |  `Infinity` | Report inbound frames over this size — **detection, not prevention**, see below. `0` disables the report.                                                          |
| `rateLimit`           |             `{ limit, windowMs }` | `undefined` | Per-socket inbound rate limit. Omitted means no limit.                                                                                                             |
| `rateLimitAction`     |               `'drop' \| 'close'` |    `'drop'` | What to do with a rate-limited message. `close` uses code 1008.                                                                                                    |
| `drainTimeoutMs`      |                          `number` |      `5000` | How long `drain()` waits for in-flight handlers before closing anyway. `0` waits indefinitely.                                                                     |

## API

- `send(data)` → `boolean` — `false` when the socket is not open, is draining, or is disposed. Never throws for an ordinary "cannot send right now".
- `close(code?, reason?)` — idempotent, and safe in any state.
- `drain(code?, reason?)` → `Promise<boolean>` — see below.
- `dispose()` / `[Symbol.dispose]`
- `stats()` → counters plus the liveness mode actually in use
- `readyState`, `isOpen`, `isDraining`, `bufferedAmount`, `canPing`

## Normalised messages

Every transport delivers the same shape:

```javascript
{
  data,     // the payload as the transport delivered it
  isBinary, // false only for a text frame
  adapter,  // the adapter, so a handler can reply without a closure
}
```

`isBinary` is inferred for a `WebSocketStream`, which carries no frame type. For a browser `WebSocket` it is derived from the payload type, since `MessageEvent` has no frame flag of its own.

## Liveness

A socket can sit in `OPEN` forever with nothing getting through — the normal state of affairs behind a dead load balancer or a silently dropped NAT entry. That is why ping/pong exists, and why "connected" is not evidence of anything.

The adapter pings on `heartbeatIntervalMs` and declares the socket dead if no pong **or message** arrives within `heartbeatTimeoutMs`. Treating a pong as the only evidence would close a perfectly healthy connection that simply has nothing to say.

**On transports with no `ping()`, the adapter does not pretend to be heartbeating.** Browsers deliberately do not expose the API to script, and `WebSocketStream` has no equivalent. There, `canPing` is `false` and `stats().canPing` reports it, and the liveness signal is message activity plus `idleTimeoutMs` if you configured one. An adapter that reported healthy forever on a transport where it could not possibly know would be worse than no heartbeat at all.

> The adapter listens for `ws`'s **`pong`** event, not `ping`. `ws` emits `ping` when a ping _arrives_ and `pong` when a pong arrives — so on a server, listening for `ping` means every client's ping looks like a liveness answer, while the server's own unanswered probes read as dead. Inverted in both directions.

## Per-message rate limiting

```javascript
new PowerSocketAdapter(ws, {
  rateLimit: { limit: 100, windowMs: 1_000 },
  rateLimitAction: 'drop', // or 'close'
  onRateLimited: (count) => log.debug({ count }, 'dropped'),
});
```

`drop` is the default and the right choice for an **inbound** limit: a client sending faster than you can process is a client you cannot serve, and discarding its excess keeps your own work bounded. Use `close` when the traffic is abusive rather than merely fast — it closes with code 1008 (policy violation).

Rate-limited messages are **counted**, not delivered, and never reach `onMessage`.

## Oversized frames: detection, not prevention

```javascript
new PowerSocketAdapter(ws, {
  maxPayloadSizeBytes: 1 << 20, // 1 MiB
  onError: (err) => {
    if (err.code === 'ERR_FRAME_TOO_LARGE') {
      metrics.increment('ws.frame.oversize', { size: err.size });
    }
  },
});
```

**Read the option name as what it is.** By the time any transport hands you a frame, the platform has already received and materialised it. A `ws` socket has allocated the `Buffer`; a browser has the `Blob`. Nothing at this layer can stop that allocation, so `maxPayloadSizeBytes` **counts** the frame (`stats().oversizeFrames`) and emits an `error` naming the size and the limit — and then handles the frame exactly as it would have handled any other.

That is why it is described this way in the option, in the error message, and here. A number that reads like a limit and is not one is worse than no number, because a deployment sets it, believes it is protected, and is not. **Prevention belongs at the peer that produces the frame** — the server, or a proxy in front of it.

Three things worth knowing about the semantics:

- **`0` disables the report**, the same convention `idleTimeoutMs: 0` and the client's `highWaterMarkBytes: 0` use. The limit is inclusive: a frame exactly at the limit is not over it.
- **The check runs before the drain and rate-limit filters**, so `oversizeFrames` answers _what arrived_ rather than _what survived two filters_. An oversized frame the rate limit then refuses is counted in **both** counters, and that is deliberate: folding it into `rateLimited` would hide the peer sending 40 MB frames, which is the exact fact this option exists to make alertable.
- **A text frame is measured in UTF-16 code units, not UTF-8 bytes.** An exact figure would cost a `TextEncoder` per frame on the hot path. Binary frames — the ones this is for — are measured exactly.

The error carries a stable `code` and both figures, so you branch on `err.code` rather than parsing text. `PowerWebSocketClient` reports through the same factory with the same wording, so one `onError` handler can serve both directions.

## Graceful drain

`drain()` is the difference between a deploy that drops a thousand in-flight requests and one that does not.

```javascript
await adapter.drain(1001, 'server shutting down'); // true, or false on timeout
```

The sequence:

1. `isOpen` becomes `false` and `send()` refuses, so a producer stops immediately rather than queueing into a socket that is about to close.
2. In-flight `onMessage` handlers are allowed to settle. Async handlers are tracked; a rejected one decrements the count, so a drain does not wait out its full timeout for work that already finished.
3. The socket closes and the promise resolves.

Step 3 is bounded by `drainTimeoutMs`, because a handler that never settles would otherwise hold a deploy open forever. **A drain that times out resolves `false` rather than `true`** — pretending it finished cleanly is how a deploy silently drops work. The counters tell you how it went: `drainTimeouts` is 1 after a timeout, and `drainedFromDrain` counts messages that arrived during the drain and were dropped.

`drain()` called twice returns the same promise.

## `WebSocketStream` notes

A stream has no `readyState` or `bufferedAmount`, so the adapter reports `OPEN` for its life and `CLOSED` after `close()`, and `bufferedAmount` is always `0`. Reporting `0` rather than `NaN` or `Infinity` is deliberate: a watermark loop reading either would treat the socket as "never backed up" and never pause.

A `WebSocketStream` is not readable until its connection opens — it reports `readable: null` — so the adapter **waits** for it. The wait polls `readable` on a timer that starts at 5 ms and doubles up to 250 ms, and it stops at once on `close()` or `dispose()`. There is no attempt limit: a connection that takes a minute to open is still read when it does. Polling rather than an event because `WebSocketStream` from `ws` emits `'open'` but a browser `WebSocket` exposed as a stream may not, and an object that merely gains a `readable` later certainly does not — an event-based wait would fix the easy case and leave the rest. The cost when the stream is already readable is nothing: the first attempt is synchronous and no timer is armed.

Until then the adapter looks entirely healthy — `kind` is `'stream'`, `isOpen` is `true`, `send()` returns `true` and `bufferedAmount` is `0` — so a socket that is never going to open is not distinguishable from a slow one. That is deliberate: the alternative is failing a connection that is merely slow, and the pump cannot tell "not yet" from "never".

The writable writer is acquired **once** and held until the socket closes or the adapter is disposed — `close()` releases it, as does a close the adapter observes from the peer, because the lock was otherwise held for the life of the stream object even for whoever else holds a reference. `getWriter()` locks a stream, and the lock is only released by `releaseLock()` — so taking a fresh writer per `send()` would make the second send throw. `send()` stays synchronous and returns a boolean, so it is a drop-in for the `ws` path; the underlying write promise is tracked so `drain()` waits for it, because an un-awaited `write()` that later rejects is an unhandled rejection.

## Disposal

`dispose()` detaches every listener it attached and cancels every timer. This is required rather than tidy: a `ws` socket outliving its adapter keeps the adapter's closures alive, so a server that never disposes on disconnect leaks one adapter per connection for the life of the process.

```javascript
using adapter = new PowerSocketAdapter(ws, handlers);
```

## `stats()`

```javascript
{
  messages,        // every inbound frame that arrived
  handled,         // frames that actually reached onMessage
  rateLimited, sent, sendFailures, backpressureEvents,
  heartbeatTimeouts, idleTimeouts, drained, drainTimeouts, drainedFromDrain,
  oversizeFrames,  // frames over maxPayloadSizeBytes — counted, not dropped
  kind,          // 'ws' | 'websocket' | 'stream'
  state,         // a READY_STATE constant
  canPing,       // whether the transport exposes ping()
  pending,       // in-flight async handlers
  bufferedAmount,
  lastActivityAt,
}
```

`messages` and `handled` are separate on purpose. `messages` is every frame that arrived, so it includes the ones the rate limiter refused; `handled` is what your application actually processed. Without the split you cannot compute the fraction of inbound traffic you really served, which is the number you need when deciding whether a rate limit is set correctly — and `handled + rateLimited + drainedFromDrain === messages` always holds, which is worth asserting in your own metrics.

`oversizeFrames` does **not** enter that identity, and that is the point: an oversized frame is reported and then handled normally, so counting it as a drop would both break the identity and misrepresent a report as a filter. A frame can be counted in `oversizeFrames` _and_ in `rateLimited`, or in `oversizeFrames` _and_ `drainedFromDrain`.

`canPing` is the field worth alerting on together with `heartbeatTimeouts`: a socket family that can never heartbeat is worth knowing about at configuration time rather than discovering when a stale connection serves 100 % errors.

## Composes with

- **`PowerRealtimeHub`** — per-subscriber bounded queues and an explicit slow-consumer policy. Wrap each connection in an adapter and hand `send` to the hub.
- **`PowerCircuit`** — stop calling a dependency that is failing, rather than retrying it.
- **`PowerRateLimit`** — the same limiting surface, composed, if you need to combine a per-socket limit with a fleet-wide one.
- **`PowerLogger`** — surface `stats()` so a rising `rateLimited` or `drainTimeouts` is visible before it is an incident.

## See also

- [`PowerWebSocketClient`](powerWebSocketClient.md) — the _client_ side: connects, reconnects with decorrelated jitter, and does producer-side backpressure with `bufferedAmount` watermarks or `WebSocketStream` writers.
- [`PowerRealtimeHub`](powerRealtimeHub.md) — fan-out with per-subscriber queues.
- [`PowerMessageCodec`](powerMessageCodec.md) — versioned framing so a decoder never has to guess.
- [`WorkerAgnostic`](WorkerAgnostic.md) — the same normalisation approach, for `Worker` constructors.
