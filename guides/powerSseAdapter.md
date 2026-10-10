# createSseAdapter

> **Server-side helper** — bridges `PowerRealtimeHub` to an SSE `Response`
> stream for unidirectional push to browser `EventSource` clients.

Server-sent events (SSE) transport adapter for `PowerRealtimeHub`.

## The problem this exists for

SSE is HTTP/1.1-native, works through every proxy and CDN, and is simpler than WebSocket for unidirectional push. The hub is transport-agnostic: it only needs a `send(subscriber, frame)` function. This adapter bridges that contract to an SSE `Response` stream, so a hub can fan out to browser clients over `EventSource` without WebSocket infrastructure.

## On the wire

Each frame is written as one SSE `data:` line, base64-encoded so binary payloads do not break the event-stream format. The hub's `codec: 'raw'` path is supported: a raw frame is already a single payload, so it is written as one line. With `codec: 'json'` the hub already batches values into one JSON array frame, so the adapter does not split frames.

**Each frame is also written with an `id:` field**, and that field is what makes
reconnection safe. SSE reconnection is driven by the _client_: a browser
`EventSource` that loses its connection reconnects on its own and sends a
`Last-Event-ID` header carrying the last `id:` the server emitted. Before 2.0
this adapter wrote only `data:` lines, so there was never an `id:` to remember,
the header was never sent, and every reconnect silently dropped everything
emitted during the gap — data loss for a telemetry or log-streaming use case,
with nothing on either side reporting it.

`id:` and `data:` go out in **one write**, not two: they are one SSE event block
and the spec dispatches them together, so two writes would be back-pressure the
caller pays for nothing.

## Resuming after a reconnect

The adapter reads `Last-Event-ID` from the request headers when a subscriber
registers, and exposes both ends of the gap:

- `lastEventId(sub)` → `string | null`. Where the **client** got to. `null` means
  a first connect — there is nothing to resume from.
- `lastSentId(sub)` → `number`. Where the **server** has got to, or `0` if
  nothing has been written yet.

The difference between the two is exactly the size of the gap a reconnect has to
replay.

```javascript
adapter.register(sub);

const from = adapter.lastEventId(sub);
if (from !== null) {
  // The client reconnected after a gap. Replay from `from`.
  for (const frame of replayFrom(from)) adapter.send(sub, frame);
}
```

**The adapter deliberately does not replay.** It holds no buffer of past frames —
it is a `send(sub, frame)` bridge, and a replay buffer is the message source's
concern, not the transport's. What the adapter owes the caller is the resume
_point_; without it the caller cannot know where the client got to, and the gap
is unfixable from above.

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
