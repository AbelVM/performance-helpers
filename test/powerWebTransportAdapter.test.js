import { describe, it, expect, beforeEach } from 'vitest';
import { createWebTransportAdapter } from '../src/helpers/powerWebTransportAdapter.js';
import { encodeMessage } from '../src/helpers/powerMessageCodec.js';

/**
 * WT-002 — `await createWebTransportAdapter(session)`.
 *
 * Returns a `kind: 'stream'` socket wrapping a `WebTransportBidirectionalStream`
 * whose readable side is decoded by `createFrameDecoder`. The four properties
 * below are the ones `PowerSocketAdapter` reads for a stream socket:
 *
 * - `writable` — the stream's native `WritableStream`.
 * - `readable` — a `ReadableStream` of decoded frame values.
 * - `close?.(code, reason)` — closes both sides.
 * - `kind` — `'stream'`.
 *
 * The tests use a fake `WebTransport` because there is no server in the test
 * harness. The fake models the three surfaces the adapter touches:
 *
 * - `session.createBidirectionalStream()` returns `{ readable, writable }`.
 * - `writable` is a `WritableStream` whose `getWriter()` returns a mock writer
 *   that records writes and can be locked.
 * - `readable` is a `ReadableStream` that the test pushes chunks into via a
 *   controller.
 */

/** A minimal mock writer that records writes and supports locking. */
class MockWriter {
  constructor() {
    this.written = [];
    this.desiredSize = 1;
    this.locked = false;
    this.closed = false;
  }
  write(chunk) {
    if (this.closed) throw new Error('writer is closed');
    this.written.push(chunk);
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  releaseLock() {
    this.locked = false;
  }
}

/** A fake WebTransport session with a controllable bidirectional stream. */
class FakeWebTransportSession {
  constructor() {
    this._streamQueue = [];
    this._streamDone = false;
    this._reader = null;
    this._writer = null;
    this.closed = false;
    this.closeCalls = [];
    this._controller = null;
  }

  createBidirectionalStream() {
    const self = this;
    this._writer = new MockWriter();

    const readable = new ReadableStream({
      start(controller) {
        self._controller = controller;
        // Flush any pre-queued chunks.
        for (const chunk of self._streamQueue) {
          controller.enqueue(chunk);
        }
        if (self._streamDone) {
          controller.close();
        }
      },
    });

    const writable = new WritableStream({
      write(chunk) {
        return self._writer.write(chunk);
      },
    });

    return { readable, writable };
  }

  /** Push a chunk into the readable side of the next created stream. */
  pushReadable(chunk) {
    this._streamQueue.push(chunk);
    if (this._controller) {
      this._controller.enqueue(chunk);
    }
  }

  /** Signal end-of-stream on the readable side. */
  endReadable() {
    this._streamDone = true;
    if (this._controller) {
      this._controller.close();
    }
  }

  close({ closeCode, reason } = {}) {
    this.closed = true;
    this.closeCalls.push({ code: closeCode, reason });
    // Close the readable stream so the adapter's pump loop terminates and
    // the TransformStream's readable side closes for the reader.
    if (this._controller) {
      try {
        this._controller.close();
      } catch {
        // already closed
      }
    }
  }
}

describe('WT-002: createWebTransportAdapter', () => {
  let session;

  beforeEach(() => {
    session = new FakeWebTransportSession();
  });

  it('returns a stream socket with the four properties PowerSocketAdapter reads', async () => {
    const socket = await createWebTransportAdapter(session);
    expect(socket.kind).toBe('stream');
    expect(socket.writable).toBeInstanceOf(WritableStream);
    expect(socket.readable).toBeInstanceOf(ReadableStream);
    expect(typeof socket.close).toBe('function');
  });

  it('decodes a single complete frame on the readable side', async () => {
    const socket = await createWebTransportAdapter(session);
    const reader = socket.readable.getReader();

    const frame = encodeMessage({ hello: 'world' });
    session.pushReadable(frame);
    session.endReadable();

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual({ hello: 'world' });

    // No more frames.
    const next = await reader.read();
    expect(next.done).toBe(true);

    await reader.cancel();
  });

  it('decodes split frames without throwing', async () => {
    // The property this feature exists to pin: a frame that lands across two
    // chunks must not surface as a RangeError at the reader.
    const socket = await createWebTransportAdapter(session);
    const reader = socket.readable.getReader();

    const frame = encodeMessage({ split: true });
    const firstHalf = frame.subarray(0, Math.floor(frame.length / 2));
    const secondHalf = frame.subarray(Math.floor(frame.length / 2));

    session.pushReadable(firstHalf);
    session.pushReadable(secondHalf);

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual({ split: true });

    await reader.cancel();
  });

  it('decodes multiple frames from one chunk', async () => {
    const socket = await createWebTransportAdapter(session);
    const reader = socket.readable.getReader();

    const frame1 = encodeMessage('a');
    const frame2 = encodeMessage('b');
    const combined = new Uint8Array(frame1.length + frame2.length);
    combined.set(frame1, 0);
    combined.set(frame2, frame1.length);

    session.pushReadable(combined);
    session.endReadable();

    const first = await reader.read();
    expect(first.value).toBe('a');
    expect(first.done).toBe(false);

    const second = await reader.read();
    expect(second.value).toBe('b');
    expect(second.done).toBe(false);

    const end = await reader.read();
    expect(end.done).toBe(true);

    await reader.cancel();
  });

  it('forwards raw codec frames as Uint8Array', async () => {
    const socket = await createWebTransportAdapter(session);
    const reader = socket.readable.getReader();

    const payload = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeMessage(payload, { codec: 'raw' });
    session.pushReadable(frame);

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    // `decodeMessage` returns `bytes.slice(start, end)` for raw, which is a
    // Uint8Array view over the frame buffer — not a detached ArrayBuffer.
    expect(value).toBeInstanceOf(Uint8Array);
    expect(value).toEqual(payload);

    await reader.cancel();
  });

  it('closes both sides and records the close code', async () => {
    const socket = await createWebTransportAdapter(session);
    const reader = socket.readable.getReader();

    // Prime the writable side so getWriter() succeeds.
    socket.writable.getWriter();

    socket.close(1001, 'going away');
    expect(session.closeCalls).toEqual([{ code: 1001, reason: 'going away' }]);

    // Readable side should be closed.
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it('is safe to close more than once', async () => {
    const socket = await createWebTransportAdapter(session);
    socket.close();
    socket.close();
    expect(session.closeCalls).toHaveLength(1);
  });

  it('writes pass through to the WebTransport writable stream', async () => {
    const socket = await createWebTransportAdapter(session);
    const writer = socket.writable.getWriter();
    const payload = new Uint8Array([9, 8, 7]);

    await writer.write(payload);
    await writer.close();

    expect(session._writer.written).toEqual([payload]);
  });

  it('accepts frames over the decoder ceiling because maxFrameBytes is Infinity', async () => {
    // The adapter uses `maxFrameBytes: Infinity`, so the decoder itself never
    // throws. The enforcement point is `PowerSocketAdapter`'s
    // `maxPayloadSizeBytes` option, which is checked in `_handleMessage` after
    // decode. This test pins the adapter's choice: the decoder is unbounded.
    const socket = await createWebTransportAdapter(session);
    const reader = socket.readable.getReader();

    // Build a 1 MB raw frame.
    const header = new Uint8Array(6);
    header[0] = 1; // version
    header[1] = 2; // raw codec
    // payload length = 1 MB (little-endian uint32)
    header[2] = 0x00;
    header[3] = 0x00;
    header[4] = 0x10;
    header[5] = 0x00;
    const payload = new Uint8Array(1024 * 1024).fill(0x61);
    const frame = new Uint8Array(header.length + payload.length);
    frame.set(header, 0);
    frame.set(payload, header.length);

    session.pushReadable(frame);
    const { value, done } = await reader.read();
    // The decoder accepts it because maxFrameBytes is Infinity.
    expect(done).toBe(false);
    expect(value).toBeInstanceOf(Uint8Array);
    expect(value.length).toBe(1024 * 1024);

    await reader.cancel();
  });
});
