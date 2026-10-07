# PowerWebTransportAdapter

> **Server-side helper** — wraps a `WebTransport` session's bidirectional
> stream. The client-side counterpart is
> [`PowerWebTransportClient`](powerWebTransportClient.md).

Wrap a `WebTransport` session's `createBidirectionalStream()` in the `kind: 'stream'` socket shape [`PowerSocketAdapter`](powerSocketAdapter.md) expects, and decode the inbound byte stream with [`createFrameDecoder`](powerMessageCodec.md) so split frames do not surface as `RangeError`s at the reader.

## Why this exists

`PowerSocketAdapter` already knows how to drive a `WebSocketStream` — a `WritableStream` plus a `ReadableStream` with `getReader`/`getWriter`. A `WebTransportBidirectionalStream` exposes the same two surfaces, so the adapter can wrap it without a new transport branch. The one difference is framing: WebSocket carries messages, WebTransport carries a raw byte stream, and a frame that lands across two QUIC datagrams would otherwise be handed to `decodeMessage` half-written. `createFrameDecoder` absorbs that split and yields complete frames only.

## Socket shape

The returned object is deliberately minimal — just the four properties `PowerSocketAdapter` reads for a stream socket:

- `kind` — `'stream'`, so detection short-circuits.
- `writable` — the stream's native `WritableStream`. `PowerSocketAdapter` takes a writer once and holds it for the adapter's lifetime, so this must be a real `WritableStream` that supports locking.
- `readable` — a `ReadableStream` whose chunks are the _decoded_ frame values, not raw bytes. `PowerSocketAdapter` passes each chunk to `_handleMessage(value, typeof value !== 'string')`, so a JSON frame arrives as its parsed object and a `raw` frame arrives as an `ArrayBuffer`/typed array.
- `close?.(code, reason)` — closes both sides. The writer may be locked by `PowerSocketAdapter` when this is called, so the implementation tries `getWriter().close()` first and falls back to `abort()`.

## Usage

```javascript
import { createWebTransportAdapter } from 'performance-helpers/powerWebTransportAdapter';
import { PowerRealtimeHub } from 'performance-helpers';

const session = new WebTransport('https://example.com', {
  createBidirectionalStreams: true,
});

const socket = createWebTransportAdapter(session);
const hub = new PowerRealtimeHub({ send: (frame) => socket.writable.getWriter().write(frame) });

hub.subscribe('topic', (data) => {
  console.log(data);
});
```

## Frame decoding

The adapter uses `createFrameDecoder({ maxFrameBytes: Infinity })`. The decoder itself never throws on size; enforcement is left to `PowerSocketAdapter`'s `maxPayloadSizeBytes` option, which is checked in `_handleMessage` after decode. This keeps the transport adapter focused on transport concerns and lets the hub enforce policy.

## Close semantics

`close(code, reason)` does three things:

1. Calls `session.close(code, reason)` if the session exposes it.
2. Closes the writable side — `getWriter().close()` when the writer is free, `abort()` when it is locked by `PowerSocketAdapter`.
3. Cancels the readable side so the reader loop terminates and `_handleClose` fires.

All three swallow locked-stream errors, because the writer and reader are held by `PowerSocketAdapter` for the adapter's lifetime.

## What this is not

It is **a stream adapter, not a WebTransport stack**. There is no connection establishment, no certificate handling, no datagram support. Bring an open — or opening — `WebTransport` session with `createBidirectionalStreams: true`. This normalises its stream so the rest of your code does not know it is not a socket.
