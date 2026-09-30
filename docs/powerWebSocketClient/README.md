[**performance-helpers**](../README.md)

---

[performance-helpers](../README.md) / powerWebSocketClient

# powerWebSocketClient

WebSocket client with back-pressure, heartbeats and reconnection.

## The problem this exists for

The `WebSocket` interface has **no back-pressure**. As MDN puts it: "The
`WebSocket` interface ... doesn't support back-pressure. As a result, when
messages arrive faster than the application can process them it will either
fill up the device's memory by buffering those messages, become unresponsive
due to 100 % CPU usage, or both."

A producer that ignores this will OOM the client, and — on a server that
fans out to many sockets — OOM the server too. Two mitigations exist, and this
client uses whichever is available:

1. **`bufferedAmount` watermarks** (universal). `send()` returns immediately
   and the browser buffers internally, so the producer must watch
   `socket.bufferedAmount` and stop feeding it above a high-water mark. MDN's
   own advice is to poll, which is exactly what this does — but on a timer
   that backs off rather than a tight loop, and it exposes `pause()`/`resume()`
   events so a producer can be driven by it instead of polling.
2. **Streams** (where `WebSocketStream` exists). It is a Promise-based
   alternative built on the Streams API and therefore "can take advantage of
   stream back-pressure automatically". It is not yet standard or
   universally available, so it is feature-detected and the watermark tier is
   always kept as the fallback.

## On the wire

Frames are encoded and decoded with PowerMessageCodec, so this pairs
directly with PowerRealtimeHub — pass [PowerWebSocketClient#send](classes/PowerWebSocketClient.md#send)
as the hub's `send` adapter and a slow socket is handled at both layers: the
watermark stops the producer here, the bounded queue handles it there.

## Classes

- [PowerWebSocketClient](classes/PowerWebSocketClient.md)

## Interfaces

- [WebSocketClientOptions](interfaces/WebSocketClientOptions.md)

## Type Aliases

- [BackpressureMode](type-aliases/BackpressureMode.md)
- [WebSocketReadyState](type-aliases/WebSocketReadyState.md)

## References

### default

Renames and re-exports [PowerWebSocketClient](classes/PowerWebSocketClient.md)

---

### READY\_STATE

Re-exports [READY_STATE](../helpers/constants/variables/READY_STATE.md)
