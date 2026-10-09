/**
 * WebTransport bidirectional-stream adapter.
 *
 * Wraps a `WebTransport` session's `createBidirectionalStream()` in the
 * `kind: 'stream'` socket shape {@link PowerSocketAdapter} expects, and
 * decodes the inbound byte stream with {@link createFrameDecoder} so split
 * frames do not surface as `RangeError`s at the reader.
 *
 * ## Why this exists
 *
 * `PowerSocketAdapter` already knows how to drive a `WebSocketStream` — a
 * `WritableStream` plus a `ReadableStream` with `getReader`/`getWriter`. A
 * `WebTransportBidirectionalStream` exposes the same two surfaces, so the
 * adapter can wrap it without a new transport branch. The one difference is
 * framing: WebSocket carries messages, WebTransport carries a raw byte
 * stream, and a frame that lands across two QUIC datagrams would otherwise
 * be handed to `decodeMessage` half-written. `createFrameDecoder` absorbs
 * that split and yields complete frames only.
 *
 * ## Socket shape
 *
 * The returned object is deliberately minimal — just the four properties
 * `PowerSocketAdapter` reads for a stream socket:
 *
 * - `kind` — `'stream'`, so detection short-circuits.
 * - `writable` — the stream's native `WritableStream`. `PowerSocketAdapter`
 *   takes a writer once and holds it for the adapter's lifetime, so this
 *   must be a real `WritableStream` that supports locking.
 * - `readable` — a `ReadableStream` whose chunks are the *decoded* frame
 *   values, not raw bytes. `PowerSocketAdapter` passes each chunk to
 *   `_handleMessage(value, typeof value !== 'string')`, so a JSON frame
 *   arrives as its parsed object and a `raw` frame arrives as an
 *   `ArrayBuffer`/typed array.
 * - `close?.(code, reason)` — closes both sides. The writer may be locked
 *   by `PowerSocketAdapter` when this is called, so the implementation
 *   tries `getWriter().close()` first and falls back to `abort()`.
 *
 * @module powerWebTransportAdapter
 * @public
 */

import { createFrameDecoder } from './powerMessageCodec.js';

/**
 * Wrap a `WebTransport` session in a stream socket that decodes inbound
 * frames.
 *
 * **No connection is opened here.** The caller is expected to have
 * constructed and configured the `WebTransport` already (including
 * `createBidirectionalStreams: true` in the options). The only thing this
 * function does is call `session.createBidirectionalStream()` and wrap the
 * result.
 *
 * @param {WebTransport} session - A live `WebTransport` with bidirectional
 *   streams enabled.
 *   A socket object compatible with {@link PowerSocketAdapter}.
 * @since 2.0.0
 */
export async function createWebTransportAdapter(session) {
  const stream = await session.createBidirectionalStream();

  // `Infinity` because the caller's `maxPayloadSizeBytes` option on
  // `PowerSocketAdapter` is the enforcement point; the decoder's own ceiling
  // is a second line of defence, and accepting any size here lets the adapter
  // enforce the policy rather than the transport refusing a legitimate frame.
  const decoder = createFrameDecoder({ maxFrameBytes: Infinity });

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        // Emit the decoded value only. `PowerSocketAdapter` will wrap it in
        // `{data, isBinary}` for the `onMessage` handler, with `isBinary`
        // inferred from `typeof value !== 'string'` — the same rule it uses
        // for a `WebSocketStream`.
        controller.enqueue(frame.value);
      }
    },
    flush(controller) {
      // When the writable side ends, report anything still buffered. In
      // strict mode (the default) `flush()` throws on a truncated frame,
      // which propagates as a stream error — the right thing, because a
      // mid-frame close is a protocol violation, not a clean shutdown.
      const remaining = decoder.flush();
      if (remaining.length > 0) {
        controller.enqueue(remaining);
      }
    },
  });

  let closed = false;

  // Pump data from the WebTransport readable into the TransformStream's
  // writable side. Without this loop no chunk ever reaches the decoder, so
  // the reader would wait forever.
  const pump = async () => {
    const reader = stream.readable.getReader();
    const writer = transformStream.writable.getWriter();
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (e) {
      // An aborted or errored read is how a closed stream reports itself.
      // Propagate to the TransformStream so its readable side errors too.
      try {
        writer.abort(e);
      } catch {
        // already aborted
      }
    } finally {
      reader.releaseLock();
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
  };

  pump();

  return {
    kind: 'stream',
    writable: stream.writable,
    readable: transformStream.readable,
    /**
     * Alias of `close()`, so the socket object takes part in `using` /
     * `await using` teardown like every other long-lived helper here.
     *
     * This adapter owns no timer and no listener registry of its own - the
     * pump loop is driven by the stream itself - so `dispose()` is the same
     * operation as `close()`, not a state reset.
     *
     * @param {number} [code]
     * @param {string} [reason]
     * @returns {void}
     */
    dispose(code = 1000, reason = '') {
      close(code, reason);
    },
    [Symbol.dispose](code = 1000, reason = '') {
      close(code, reason);
    },
    async [Symbol.asyncDispose](code = 1000, reason = '') {
      close(code, reason);
      return;
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      // Close the WebTransport session itself.
      try {
        session.close?.({ closeCode: code, reason });
      } catch {
        // session may not have a close method, or may already be closed
      }
      // The writer is held by `PowerSocketAdapter` for the adapter's lifetime,
      // so `getWriter()` throws `TypeError` here more often than not. Try
      // anyway — it succeeds when the caller closes before any `send()` — and
      // fall back to `abort()`, which does not require a lock.
      try {
        const writer = stream.writable.getWriter();
        writer.close().catch(() => {});
      } catch {
        stream.writable.abort().catch(() => {});
      }
      // Cancel the readable side so the reader loop in `PowerSocketAdapter`
      // terminates and `_handleClose` fires. The reader may be locked by
      // `PowerSocketAdapter`, so catch the error.
      transformStream.readable.cancel().catch(() => {});
    },
  };
}
