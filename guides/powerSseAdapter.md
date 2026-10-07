# PowerSseAdapter

> **Server-side helper** — bridges `PowerRealtimeHub` to an SSE `Response`
> stream for unidirectional push to browser `EventSource` clients.

Server-sent events (SSE) transport adapter for `PowerRealtimeHub`.

## The problem this exists for

SSE is HTTP/1.1-native, works through every proxy and CDN, and is simpler than WebSocket for unidirectional push. The hub is transport-agnostic: it only needs a `send(subscriber, frame)` function. This adapter bridges that contract to an SSE `Response` stream, so a hub can fan out to browser clients over `EventSource` without WebSocket infrastructure.

## On the wire

Each frame is written as one SSE `data:` line, base64-encoded so binary payloads do not break the event-stream format. The hub's `codec: 'raw'` path is supported: a raw frame is already a single payload, so it is written as one line. With `codec: 'json'` the hub already batches values into one JSON array frame, so the adapter does not split frames.

## Usage

```javascript
import { createSseAdapter } from 'performance-helpers/powerSseAdapter';

const adapter = createSseAdapter({
  createResponse(sub) {
    return new Response(new ReadableStream(), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  },
  onError(err, sub) {
    console.error('SSE write failed', err, sub.id);
  },
});

// Pass adapter.send and adapter.close to PowerRealtimeHub.
const hub = new PowerRealtimeHub({
  send: adapter.send,
  close: adapter.close,
  codec: 'raw',
});
```

## Subscriber lifecycle

`register(sub)` is called when a subscriber is added. It creates the writer from `createResponse` or falls back to `sub.transport.write`/`sub.transport.end` in Node. `close(sub)` marks the subscriber closed and closes the writer or transport end.

If `createResponse` throws, `register(sub)` reports the error through `onError` and does not retain a dead subscriber.
