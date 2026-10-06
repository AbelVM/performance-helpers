[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerWebTransportClient

# powerWebTransportClient

WebTransport client with back-pressure and reconnection.

## The problem this exists for

`PowerWebSocketClient` covers the WebSocket case. WebTransport is the
HTTP/3 successor: same request/response shape, but the data path is streams
and datagrams rather than messages, and the platform does not provide
`ping()`/`pong()` or `bufferedAmount`. This client mirrors the
`PowerWebSocketClient` API so a hub can swap transports without changing
the call sites.

## On the wire

Frames are encoded and decoded with PowerMessageCodec, so this pairs
directly with PowerRealtimeHub — pass [PowerWebTransportClient#send](classes/PowerWebTransportClient.md#send)
as the hub's `send` adapter.

Inbound frames arrive from a `ReadableStream`; outbound frames are written
to a `WritableStream`. Back-pressure is the stream's `ready` promise, which
resolves when the transport has room — no watermark polling required.

## Classes

- [PowerWebTransportClient](classes/PowerWebTransportClient.md)

## Interfaces

- [WebTransportClientOptions](interfaces/WebTransportClientOptions.md)

## Type Aliases

- [BackpressureMode](type-aliases/BackpressureMode.md)
- [WebTransportReadyState](type-aliases/WebTransportReadyState.md)

## Variables

- [READY\_STATE](variables/READY_STATE.md)
