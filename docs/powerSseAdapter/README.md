[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerSseAdapter

# powerSseAdapter

Server-sent events (SSE) transport adapter for `PowerRealtimeHub`.

## The problem this exists for

SSE is HTTP/1.1-native, works through every proxy and CDN, and is simpler
than WebSocket for unidirectional push. The hub is transport-agnostic: it
only needs a `send(subscriber, frame)` function. This adapter bridges that
contract to an SSE `Response` stream, so a hub can fan out to browser
clients over `EventSource` without WebSocket infrastructure.

## On the wire

Each frame is written as one SSE `data:` line, base64-encoded so binary
payloads do not break the event-stream format. The hub's `codec: 'raw'`
path is supported: a raw frame is already a single payload, so it is
written as one line. With `codec: 'json'` the hub already batches values
into one JSON array frame, so the adapter does not split frames.

## Interfaces

- [SseAdapterOptions](interfaces/SseAdapterOptions.md)
- [SseSubscriber](interfaces/SseSubscriber.md)

## Functions

- [createSseAdapter](functions/createSseAdapter.md)
