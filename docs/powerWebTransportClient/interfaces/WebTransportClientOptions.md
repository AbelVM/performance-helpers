[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebTransportClient](../README.md) / WebTransportClientOptions

# Interface: WebTransportClientOptions

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

### heartbeatIntervalMs?

> `optional` **heartbeatIntervalMs?**: `number`

Send a heartbeat at this
  interval. `0` disables heartbeats.

***

### heartbeatTimeoutMs?

> `optional` **heartbeatTimeoutMs?**: `number`

Declare the transport dead if
  a heartbeat reply is not received in this long.

***

### maxPayloadSizeBytes?

> `optional` **maxPayloadSizeBytes?**: `number`

Frames larger than this are
  **reported, not prevented**. Counts `oversizeFrames` and emits `error`.

***

### maxReconnectAttempts?

> `optional` **maxReconnectAttempts?**: `number`

`Infinity` retries
  forever with decorrelated-jitter backoff.

***

### maxReconnectElapsedMs?

> `optional` **maxReconnectElapsedMs?**: `number`

Wall-clock ceiling on
  one reconnect run, in milliseconds.

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to
  metrics: `true` registers this helper in the shared collector, or pass a
  collector of your own. Off by default.

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

Called once the transport reaches `OPEN`.

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
  heartbeat goes unanswered.

***

### rtt?

> `optional` **rtt?**: [`PowerHistogram`](../../helpers/powerHistogram/classes/PowerHistogram.md)

Histogram for heartbeat RTT. One is
  created when omitted.

***

### url

> **url**: `string`

The `https://` URL.

***

### WebTransportImpl?

> `optional` **WebTransportImpl?**: `Function`

Constructor override, for tests or a
  non-global implementation. Defaults to `globalThis.WebTransport`.
