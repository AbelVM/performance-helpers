[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerWebTransportAdapter

# powerWebTransportAdapter

WebTransport bidirectional-stream adapter.

Wraps a `WebTransport` session's `createBidirectionalStream()` in the
`kind: 'stream'` socket shape PowerSocketAdapter expects, and
decodes the inbound byte stream with [createFrameDecoder](../powerMessageCodec/functions/createFrameDecoder.md) so split
frames do not surface as `RangeError`s at the reader.

## Why this exists

`PowerSocketAdapter` already knows how to drive a `WebSocketStream` — a
`WritableStream` plus a `ReadableStream` with `getReader`/`getWriter`. A
`WebTransportBidirectionalStream` exposes the same two surfaces, so the
adapter can wrap it without a new transport branch. The one difference is
framing: WebSocket carries messages, WebTransport carries a raw byte
stream, and a frame that lands across two QUIC datagrams would otherwise
be handed to `decodeMessage` half-written. `createFrameDecoder` absorbs
that split and yields complete frames only.

## Socket shape

The returned object is deliberately minimal — just the four properties
`PowerSocketAdapter` reads for a stream socket:

- `kind` — `'stream'`, so detection short-circuits.
- `writable` — the stream's native `WritableStream`. `PowerSocketAdapter`
  takes a writer once and holds it for the adapter's lifetime, so this
  must be a real `WritableStream` that supports locking.
- `readable` — a `ReadableStream` whose chunks are the *decoded* frame
  values, not raw bytes. `PowerSocketAdapter` passes each chunk to
  `_handleMessage(value, typeof value !== 'string')`, so a JSON frame
  arrives as its parsed object and a `raw` frame arrives as an
  `ArrayBuffer`/typed array.
- `close?.(code, reason)` — closes both sides. The writer may be locked
  by `PowerSocketAdapter` when this is called, so the implementation
  tries `getWriter().close()` first and falls back to `abort()`.

## Functions

- [createWebTransportAdapter](functions/createWebTransportAdapter.md)
