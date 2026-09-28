# Realtime

Transport framing and real-time fan-out. These compose: the hub delivers over
whatever transport you supply, and the codec is what makes a batch of messages
legible to the receiver.

- [PowerMessageCodec: Versioned binary message framing](../guides/powerMessageCodec.md). Explicit `[version][codec][length][payload]` envelope so a transport never has to _guess_ what it received. Framed `json`/`raw` codecs for byte streams, plus `encodeNative` for the platform structured clone on a `MessagePort`/`Worker`. This is the protocol `PowerPool` speaks by default since 2.0.
- [PowerRealtimeHub: Topic fan-out with slow-consumer control](../guides/powerRealtimeHub.md). Per-subscriber bounded queues and a declared policy (`drop-oldest` / `drop-newest` / `disconnect`) so one slow consumer cannot stall or OOM the process. Transport-agnostic via a `send` adapter; batches over `PowerMessageCodec`.
- [PowerWebSocketClient: Reconnecting client with back-pressure](../guides/powerWebSocketClient.md). `WebSocket` has no back-pressure, so this adds it two ways: `bufferedAmount` watermarks (universal, with a backing-off poll and `onPause`/`onResume`) and `WebSocketStream` where available (awaits `writer.ready`). Plus heartbeats with RTT, decorrelated-jitter reconnects, and a connect timeout. Pairs with `PowerRealtimeHub` via `sendFrame`.
- [PowerSocketAdapter: One interface over three socket models](../guides/powerSocketAdapter.md). Normalise a Node `ws` socket, a browser `WebSocket`, or a `WebSocketStream` behind one API. They are genuinely incompatible — a `ws` `message` handler receives `(data, isBinary)`, an `EventTarget` one receives an event object, and a `WebSocketStream` has neither `on`, `readyState`, nor `bufferedAmount` — and the mismatches fail silently. Adds socket-level liveness, per-message rate limiting, and a graceful `drain()` for shutdown. The server-side counterpart to the client above; there is no WebSocket server here, and there should not be.
