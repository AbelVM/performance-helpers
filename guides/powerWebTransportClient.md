# PowerWebTransportClient

> **Client-side helper** — dials out and owns the connection lifecycle. The
> server-side counterpart is [`PowerWebTransportAdapter`](powerWebTransportAdapter.md).

Reconnecting WebTransport client with **stream-based back-pressure**, heartbeats, and `PowerMessageCodec` framing.

## Constructor

| option                        | type                            | default                   | description                                                                                                               |
| ----------------------------- | ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `url`                         | `string`                        | _(required)_              | The `https://` URL.                                                                                                       |
| `WebTransportImpl`            | `Function`                      | `globalThis.WebTransport` | Constructor override, for tests or a non-global implementation.                                                           |
| `codec`                       | `'json'` \| `'raw'`             | `'json'`                  | Frame codec handed to the codec module.                                                                                   |
| `connectTimeoutMs`            | `number`                        | `10000`                   | Abort the connect attempt after this long. `0` disables the timeout.                                                      |
| `maxPayloadSizeBytes`         | `number`                        | `Infinity`                | Maximum accepted size for incoming framed data. Oversized frames are rejected by the decoder and are not delivered.       |
| `heartbeatIntervalMs`         | `number`                        | `30000`                   | Send a heartbeat at this interval. `0` disables heartbeats.                                                               |
| `heartbeatTimeoutMs`          | `number`                        | `10000`                   | Declare the transport dead if a heartbeat reply is not received in this long.                                             |
| `maxReconnectAttempts`        | `number`                        | `Infinity`                | `Infinity` retries forever with decorrelated-jitter backoff.                                                              |
| `maxReconnectElapsedMs`       | `number`                        | `Infinity`                | Wall-clock ceiling on one reconnect run, in milliseconds.                                                                 |
| `reconnectBaseMs`             | `number`                        | `500`                     | Base delay for the backoff.                                                                                               |
| `reconnectMaxMs`              | `number`                        | `30000`                   | Ceiling for the backoff.                                                                                                  |
| `autoReconnect`               | `boolean`                       | `true`                    | Reconnect on an unexpected close.                                                                                         |
| `reconnectOnHeartbeatTimeout` | `boolean`                       | `true`                    | Reconnect when a heartbeat goes unanswered.                                                                               |
| `onMessage`                   | `Function`                      | —                         | Called with each decoded message.                                                                                         |
| `onOpen`                      | `Function`                      | —                         | Called once the transport reaches `OPEN`.                                                                                 |
| `onClose`                     | `Function`                      | —                         | Called with the close code and reason.                                                                                    |
| `onError`                     | `Function`                      | —                         | Called with each transport error.                                                                                         |
| `rtt`                         | `PowerHistogram`                | —                         | Histogram for heartbeat RTT. One is created when omitted.                                                                 |
| `observability`               | `boolean` \| `MetricsCollector` | `false`                   | Opt in to metrics: `true` registers this helper in the shared collector, or pass a collector of your own. Off by default. |

## The problem this exists for

`PowerWebSocketClient` covers the WebSocket case. WebTransport is the HTTP/3 successor: same request/response shape, but the data path is streams and datagrams rather than messages, and the platform does not provide `ping()`/`pong()` or `bufferedAmount`. This client mirrors the `PowerWebSocketClient` API so a hub can swap transports without changing the call sites.

## Back-pressure

WebTransport exposes back-pressure through the stream's `ready` promise, which resolves when the transport has room. No watermark polling is required:

```javascript
const client = new PowerWebTransportClient({
  url: 'https://example.test/feed',
  WebTransportImpl,
  codec: 'json',
});
```

`send()` and `sendFrame()` both await `writer.ready` before writing, so a slow network naturally slows the producer.

## Heartbeats

Heartbeats are application-level: a small frame is sent on the writable stream at `heartbeatIntervalMs`, and a deadline is armed for the reply. If the deadline fires, the client counts a `heartbeatTimeout` and, if `reconnectOnHeartbeatTimeout` is set, closes the transport and reconnects.

## Reconnection

Unexpected closes trigger decorrelated-jitter backoff, bounded by `maxReconnectAttempts` and `maxReconnectElapsedMs`. The reconnect state is reset on a successful open, so a flappy network does not accumulate debt.

## Pairing with PowerRealtimeHub

Pass `client.send` as the hub's `send` adapter and `client.close` as the hub's `close` adapter. The hub's `codec: 'json'` path batches values into one JSON array frame, which the client writes as a single stream write.
