[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebSocketClient](../README.md) / WebSocketClientOptions

# Interface: WebSocketClientOptions

## Properties

### autoReconnect?

> `optional` **autoReconnect?**: `boolean`

Reconnect on an unexpected close.

***

### codec?

> `optional` **codec?**: `"json"` \| `"raw"`

Frame codec handed to the codec
  module.

***

### connectTimeoutMs?

> `optional` **connectTimeoutMs?**: `number`

Abort the connect attempt after
  this long. `0` disables the timeout.

***

### dropOnBackpressure?

> `optional` **dropOnBackpressure?**: `boolean`

Drop frames when the
  producer is paused by the high-water mark instead of queueing them.

***

### heartbeatIntervalMs?

> `optional` **heartbeatIntervalMs?**: `number`

Send a ping at this interval.
  `0` disables heartbeats.

***

### heartbeatTimeoutMs?

> `optional` **heartbeatTimeoutMs?**: `number`

Declare the socket dead if a
  pong does not arrive in this long.

***

### highWaterMarkBytes?

> `optional` **highWaterMarkBytes?**: `number`

Above this `bufferedAmount`
  the producer is paused. 1 MiB by default.

***

### lowWaterMarkBytes?

> `optional` **lowWaterMarkBytes?**: `number`

Below this, the producer is
  resumed. Must be below the high-water mark.

***

### maxPayloadSizeBytes?

> `optional` **maxPayloadSizeBytes?**: `number`

Frames larger than this are
  **reported, not prevented** — and the distinction is the point, so read this
  before relying on it.

  By the time a `message` event fires, the platform has already received and
  materialised the whole frame. Nothing at this layer can stop that allocation,
  so this option **counts** the oversized frame (`stats().oversizeFrames`) and
  emits an `error` saying what arrived. It is observability, not a guard: a
  number that reads like a limit and is not one is worse than no number, which
  is why it is described this way in the option, in the error message and here.

  **Prevention belongs at the peer that produces the frame.** And the codec is
  already safe regardless: `decodeMessage` validates a declared payload length
  against the bytes actually present *before* slicing, so a frame lying about
  its size throws instead of reserving anything, and the payload is a view
  rather than a copy. The incremental decoder's equivalent bound —
  `createFrameDecoder`'s `maxFrameBytes` — is **required** rather than
  defaulted, because a peer that sends a header and then stops would otherwise
  pin its buffer at whatever size it named.

  Defaults to `Infinity`, which disables the report; `0` disables it too, the
  same convention `highWaterMarkBytes: 0` uses in this class. Set it to the
  largest frame your peer should ever send, and alert on `oversizeFrames`.

***

### maxPollIntervalMs?

> `optional` **maxPollIntervalMs?**: `number`

Ceiling for the backed-off poll.

***

### maxReconnectAttempts?

> `optional` **maxReconnectAttempts?**: `number`

`Infinity` retries
  forever with decorrelated-jitter backoff.

***

### maxReconnectElapsedMs?

> `optional` **maxReconnectElapsedMs?**: `number`

Wall-clock ceiling on
  one reconnect run, in milliseconds. Unlike [maxReconnectAttempts](#maxreconnectattempts),
  which counts attempts, this bounds the *time* spent retrying — so a backoff
  schedule that has stretched its delay out is stopped on wall-clock grounds
  rather than waiting for an attempt count nobody can predict.

  Defaults to `Infinity`, which is **no bound** and preserves today's
  behaviour. That default is the anti-pattern named in GAP-010 — *"Should I
  reconnect a WebSocket forever? No. Set a maximum retry count (10–15) or a
  maximum elapsed time (2–5 minutes)"* — and a finite default is a breaking
  change, so it is scheduled for 3.0 rather than smuggled into this release.
  Set it here for now.

  The budget covers **one outage**: it is reset when a connection opens, so a
  long-lived connection that drops an hour later gets a fresh window rather
  than inheriting the previous one's exhaustion. That is the same window
  `maxReconnectAttempts` bounds, and the two compose.

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to
  metrics: `true` registers this helper in the shared collector, or pass a
  collector of your own. Off by default, so the common case allocates nothing.

***

### onClose?

> `optional` **onClose?**: `Function`

Called with the close code and reason.

***

### onError?

> `optional` **onError?**: `Function`

Called with each transport error.

***

### onMessage?

> `optional` **onMessage?**: `Function`

Called with each decoded message.

***

### onOpen?

> `optional` **onOpen?**: `Function`

Called once the socket reaches `OPEN`.

***

### onPause?

> `optional` **onPause?**: `Function`

Called when the high-water mark is crossed.

***

### onResume?

> `optional` **onResume?**: `Function`

Called when `bufferedAmount` drains below
  the low-water mark.

These were written as one line - `[onOpen] / [onClose] / [onError] / ...` -
which reads fine and parses as exactly one property. `onClose`, `onError`,
`onPause` and `onResume` were therefore invisible to the type system while
being fully supported at runtime, and every call site that passed one was an
error. Five `@property` lines instead of one shorthand, for the same length.

***

### pollIntervalMs?

> `optional` **pollIntervalMs?**: `number`

Base interval for the watermark
  poll. It backs off up to `maxPollIntervalMs` while paused, so a stuck
  socket does not spin the event loop.

***

### protocols?

> `optional` **protocols?**: `string` \| `string`[]

Sub-protocols forwarded to the
  `WebSocket` / `WebSocketStream` constructor.

***

### reconnectBaseMs?

> `optional` **reconnectBaseMs?**: `number`

Base delay for the backoff.

***

### reconnectMaxMs?

> `optional` **reconnectMaxMs?**: `number`

Ceiling for the backoff.

***

### reconnectOnHeartbeatTimeout?

> `optional` **reconnectOnHeartbeatTimeout?**: `boolean`

Reconnect when a
  heartbeat goes unanswered. A TCP connection that is silently dead is common
  behind proxies and load balancers, and a socket can sit in `OPEN` forever
  while nothing gets through.

***

### rtt?

> `optional` **rtt?**: [`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

Histogram for heartbeat RTT. One is
  created when omitted.

***

### url

> **url**: `string`

The `ws://` or `wss://` URL.

***

### WebSocketImpl?

> `optional` **WebSocketImpl?**: `Function`

Constructor override, for tests or a
  non-global implementation. Defaults to `globalThis.WebSocket`.

***

### WebSocketStreamImpl?

> `optional` **WebSocketStreamImpl?**: `Function`

`WebSocketStream` constructor
  override. When absent (or when the platform lacks it) the client falls back
  to `bufferedAmount` watermarks.
