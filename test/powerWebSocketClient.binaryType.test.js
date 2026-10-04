import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient, encodeMessage } from '../src/index.js';

/**
 * RT-036, part 1 of 2: when the platform refuses `binaryType = 'arraybuffer'`,
 * say so once, in terms of the actual problem.
 *
 * The library has no `Blob`-to-bytes conversion anywhere — `src/utils/frameSize.js`
 * only *sizes* a `Blob`, while `decodeMessage` accepts views and `ArrayBuffer` — so
 * a refused override means every inbound binary frame fails in the codec with
 * `expected a Uint8Array`. That error names the codec, not the cause, and it
 * repeats once per frame. `test/powerWebSocketClient.maxPayload.test.js` already
 * documented this as "pre-existing behaviour"; this file is the first thing that
 * changes what the caller sees.
 *
 * **This does not make Blobs decode.** Converting one is `await blob.arrayBuffer()`,
 * and the inbound path is synchronous, so that change would make delivery order an
 * implementation detail. The measured cost is ~0.045 ms per 64 KiB frame, which is
 * not the objection — the ordering contract is. That is part 2, deliberately.
 */
describe('RT-036: a refused binaryType is reported once, with its cause', () => {
  /** A socket whose `binaryType` is a getter-only accessor, as the comment describes. */
  class RefusesBinaryType {
    constructor() {
      this.url = 'ws://test/';
      this.readyState = 0;
      this.sent = [];
      this.bufferedAmount = 0;
      this._handlers = new Map();
      this._closed = false;
    }
    get binaryType() {
      // Throws on assignment — the case `_handleOpen`'s comment names.
      return 'blob';
    }
    addEventListener(type, fn) {
      const list = this._handlers.get(type) || [];
      list.push(fn);
      this._handlers.set(type, list);
    }
    _fire(type, data) {
      for (const fn of this._handlers.get(type) || []) fn({ type, data });
    }
    open() {
      this.readyState = 1;
      this._fire('open');
    }
    /** Deliver a binary frame the way a browser does when `binaryType` is `blob`. */
    message(bytes) {
      this._fire('message', new Blob([bytes]));
    }
    send() {}
    close() {
      this._closed = true;
      this.readyState = 3;
      this._fire('close', { code: 1000, reason: '' });
    }
  }

  const connect = async () => {
    const client = new PowerWebSocketClient({
      url: 'ws://test/',
      WebSocketImpl: RefusesBinaryType,
    });
    const errors = [];
    client.on('error', (e) => errors.push(e));
    const p = client.connect();
    const socket = client._socket;
    socket.open();
    await p;
    return { client, errors, socket };
  };

  it('remembers that the override was refused', async () => {
    const { client, errors, socket } = await connect();
    try {
      expect(client._binaryTypeUnsupported).toBe(true);
      // And says nothing at connect time: the connection is fine, and it may
      // never see a binary frame. Reporting here would invent a problem.
      expect(errors).toEqual([]);
      expect(socket.binaryType).toBe('blob');
    } finally {
      client.close();
    }
  });

  it('reports the cause instead of the codec error, once', async () => {
    const { client, errors, socket } = await connect();
    try {
      const frame = encodeMessage({ a: 1 });
      socket.message(frame);
      socket.message(frame);
      socket.message(frame);

      expect(errors).toHaveLength(1);
      const text = String(errors[0].message);
      // The three things the codec error never said.
      expect(text).toMatch(/binaryType/);
      expect(text).toMatch(/Blob/);
      expect(text).toMatch(/cannot be decoded/);
      // And explicitly not the misleading one.
      expect(text).not.toMatch(/PowerMessageCodec/);
    } finally {
      client.close();
    }
  });

  it('still counts the frames it could not decode', async () => {
    const { client, socket } = await connect();
    try {
      socket.message(encodeMessage({ a: 1 }));
      socket.message(encodeMessage({ a: 2 }));
      // One error, but two undecodable frames — so the counter stays a measure of
      // data loss rather than of messages reported.
      expect(client.stats().decodeErrors).toBe(2);
      expect(client.stats().received).toBe(0);
    } finally {
      client.close();
    }
  });

  it('reports once across a reconnect, not once per connection', async () => {
    // The platform will refuse again on every reconnect. A repeat per connection
    // is the same wall of noise one layer down, and the caller has already been
    // told.
    const { client, errors, socket } = await connect();
    try {
      socket.message(encodeMessage({ a: 1 }));
      expect(errors).toHaveLength(1);

      client._open().catch(() => {});
      const second = client._socket;
      second.open();
      second.message(encodeMessage({ a: 1 }));

      expect(errors).toHaveLength(1);
      expect(client._reportedBinaryTypeUnsupported).toBe(true);
    } finally {
      client.close();
    }
  });

  it('leaves a socket that accepts binaryType completely alone', async () => {
    // The regression this must not cause: a working client going quiet.
    const client = new PowerWebSocketClient({
      url: 'ws://test/',
      WebSocketImpl: class {
        constructor() {
          this.readyState = 0;
          this._h = new Map();
          this.binaryType = 'blob';
        }
        addEventListener(t, fn) {
          this._h.set(t, fn);
        }
        open() {
          this.readyState = 1;
          this._h.get('open')?.({ type: 'open' });
        }
        close() {}
        send() {}
      },
    });
    const errors = [];
    const messages = [];
    client.on('error', (e) => errors.push(e));
    client.on('message', (m) => messages.push(m));
    const p = client.connect();
    const sock = client._socket;
    sock.open();
    await p;

    try {
      expect(client._binaryTypeUnsupported, 'assignment took, so nothing is wrong').toBe(false);
      sock._h.get('message')?.({ type: 'message', data: encodeMessage({ a: 1 }) });
      expect(messages).toEqual([{ a: 1 }]);
      expect(errors).toEqual([]);
    } finally {
      client.close();
    }
  });
});
