import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient, encodeMessage } from '../src/index.js';

/**
 * RT-036: a `Blob` frame is converted and decoded, and delivery stays ordered.
 *
 * **Part 2 of 2 shipped, and it changed three of the four assertions below.** Part 1
 * reported the refused `binaryType` once and refused to decode, because decoding needs
 * `await blob.arrayBuffer()` and the inbound path was synchronous. That was a real gap —
 * `src/utils/frameSize.js` only *sizes* a `Blob`, `decodeMessage` accepts views and
 * `ArrayBuffer`, so every binary frame failed in the codec with `expected a Uint8Array`,
 * naming the codec rather than the cause, once per frame.
 *
 * The conversion is now done, through a **serial inbound chain**. The chain is the whole
 * design and the reason is ordering: `_handleMessage` runs inside an `addEventListener`
 * handler and **nobody awaits what that returns**, so converting a `Blob` inline would
 * let a later text frame overtake an earlier binary one and make delivery order a
 * function of how fast each conversion happened.
 *
 * Three assertions moved, and each moved for a stated reason rather than because the
 * numbers changed:
 *
 * - `decodeErrors` was 2 for two Blobs; it is now **0**, because they decoded. It
 *   still counts a frame that genuinely cannot be read — that is what it is for.
 * - `received` was 0; it is now **2**, and the messages are delivered.
 * - The advice in the one-shot error was "cannot be decoded, pass a `WebSocketImpl` or
 *   send text frames". That was **wrong** once the conversion shipped, so the wording
 *   changed: the conversion happens here, and the platform ignoring an option this
 *   client set is worth saying once rather than an error the caller must resolve first.
 */
describe('RT-036: a Blob frame is converted, decoded, and delivered in order', () => {
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

  it('says the platform refused binaryType, once, and no longer says it cannot decode', async () => {
    const { client, errors, socket } = await connect();
    try {
      const frame = encodeMessage({ a: 1 });
      socket.message(frame);
      socket.message(frame);
      socket.message(frame);
      await client._settleInbound();

      expect(errors).toHaveLength(1);
      const text = String(errors[0].message);
      expect(text).toMatch(/binaryType/);
      expect(text).toMatch(/Blob/);
      // **Changed in part 2.** "cannot be decoded" was true when this row was filed and
      // is false now, so asserting it would pin advice the library no longer needs to
      // give. What replaces it is the fact that still holds and that the caller can act
      // on: the frames are converted here, and delivery became asynchronous.
      expect(text).not.toMatch(/cannot be decoded/);
      expect(text).toMatch(/converted here/);
      expect(text).toMatch(/asynchronous/);
      // And explicitly not the misleading codec error.
      expect(text).not.toMatch(/PowerMessageCodec/);
    } finally {
      client.close();
    }
  });

  it('delivers the Blob frames it used to drop', async () => {
    // The row's actual point. Before part 2 these three frames produced three errors
    // and zero messages; `received` stayed 0.
    const { client, errors, socket } = await connect();
    const messages = [];
    client.on('message', (m) => messages.push(m));
    try {
      socket.message(encodeMessage({ a: 1 }));
      socket.message(encodeMessage({ a: 2 }));
      socket.message(encodeMessage({ a: 3 }));
      await client._settleInbound();

      expect(messages).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
      expect(client.stats().received).toBe(3);
      // And nothing is lost, so nothing is counted as lost.
      expect(client.stats().decodeErrors).toBe(0);
      expect(errors).toHaveLength(1); // the one-shot refusal, not per frame
    } finally {
      client.close();
    }
  });

  it('delivers in arrival order even when a conversion is slower than the frames behind it', async () => {
    // **The assertion that decides the design.** A slow first conversion with fast
    // frames behind it is exactly the case that makes delivery order an implementation
    // detail: inline conversion delivers 2, 3, 1. The chain is what makes it 1, 2, 3.
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
        /**
         * Deliver with a controllable conversion delay, in microtasks.
         *
         * Resolves with the frame's **ArrayBuffer**, which is what a real
         * `Blob.arrayBuffer()` does. Resolving with the Blob was the first draft's
         * bug and it failed in a way worth recording: `new Uint8Array(blob)` does not
         * throw — a Blob is neither array-like nor iterable, so it silently produces a
         * **zero-length** array, which then fails in the codec as a decode error. The
         * test reported "nothing delivered" and pointed at the delivery chain rather
         * than at the fake.
         */
        message(bytes, delayTicks = 0) {
          const blob = new Blob([bytes]);
          blob.arrayBuffer = () => {
            const inner = new Blob([bytes]).arrayBuffer();
            return new Promise((resolve, reject) => {
              let n = delayTicks;
              const step = () =>
                n-- > 0 ? Promise.resolve().then(step) : inner.then(resolve, reject);
              step();
            });
          };
          this._h.get('message')?.({ type: 'message', data: blob });
        }
      },
    });
    const order = [];
    client.on('message', (m) => order.push(m.n));
    const p = client.connect();
    const sock = client._socket;
    sock.open();
    await p;

    try {
      // The slow one goes first, so an unsynchronised implementation overtakes it.
      sock.message(encodeMessage({ n: 1 }), 6);
      sock.message(encodeMessage({ n: 2 }), 0);
      sock.message(encodeMessage({ n: 3 }), 0);
      await client._settleInbound();

      expect(order).toEqual([1, 2, 3]);
    } finally {
      client.close();
    }
  });

  it('does not emit close before the message a pending conversion still owes', async () => {
    // The other half of the ordering contract, and the one a caller actually notices:
    // `close` means "nothing more will arrive". A `Blob` conversion in flight when the
    // peer closes used to be overtaken by that `close`, so the frame it was carrying
    // arrived after the event that says no more frames are coming.
    const { client, socket } = await connect();
    const order = [];
    client.on('message', () => order.push('message'));
    client.on('close', () => order.push('close'));
    try {
      // A slow conversion, then an immediate close behind it.
      const slow = new Blob([encodeMessage({ a: 1 })]);
      const inner = new Blob([encodeMessage({ a: 1 })]).arrayBuffer();
      slow.arrayBuffer = () =>
        new Promise((resolve) => {
          let n = 8;
          const step = () => (n-- > 0 ? Promise.resolve().then(step) : inner.then(resolve));
          step();
        });
      socket._fire('message', slow);
      socket.close();
      await client._settleInbound();

      expect(order).toEqual(['message', 'close']);
      // And the teardown was **not** deferred: the socket was already CLOSED while the
      // conversion was still running, because `readyState` is the peer's news rather
      // than an ordering decision.
      expect(client.stats().readyState).toBe(3);
    } finally {
      client._closedByUser = true;
      client._state = 3;
    }
  });

  it('emits close on the same tick when nothing was pending', async () => {
    // The regression the join must not cause: a `close` caller that checks
    // synchronously after `socket.close()` would start seeing it one microtask late,
    // and nothing about this library announces a tick of latency.
    const { client, socket } = await connect();
    let closed = false;
    client.on('close', () => {
      closed = true;
    });
    try {
      socket.close();
      expect(closed, 'synchronous, as it has always been').toBe(true);
      expect(client._inboundChain, 'and nothing was queued').toBe(null);
    } finally {
      client._closedByUser = true;
      client._state = 3;
    }
  });

  it('counts and reports a Blob that cannot be converted, per frame', async () => {
    // Unlike the refusal above, a failing conversion is not necessarily the same
    // failure twice, so it is counted and reported every time. And the chain must
    // survive it: a rejected chain would strand every later frame and turn one bad
    // frame into a permanently deaf socket.
    const { client, errors, socket } = await connect();
    const messages = [];
    client.on('message', (m) => messages.push(m));
    try {
      socket.message(encodeMessage({ a: 1 }));
      const bad = new Blob([new Uint8Array([1, 2, 3])]);
      bad.arrayBuffer = () => Promise.reject(new Error('blob exploded'));
      socket._fire('message', bad);
      socket.message(encodeMessage({ a: 2 }));
      await client._settleInbound();

      expect(errors.filter((e) => /blob exploded/.test(String(e.message)))).toHaveLength(1);
      expect(client.stats().decodeErrors).toBe(1);
      // The frame behind the bad one still arrives.
      expect(messages).toEqual([{ a: 1 }, { a: 2 }]);
    } finally {
      client.close();
    }
  });

  it('delivers synchronously on a socket that never produces a Blob', async () => {
    // The regression this must not cause: a working client going async, and a caller
    // relying on delivery inside its own listener, silently moving a microtask later.
    // One property read per frame is the entire cost of the feature when it is unused.
    const client = new PowerWebSocketClient({
      url: 'ws://test/',
      WebSocketImpl: class {
        constructor() {
          this.readyState = 0;
          this._h = new Map();
          this.binaryType = 'arraybuffer';
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
    const seen = [];
    client.on('message', (m) => seen.push(m));
    const p = client.connect();
    const sock = client._socket;
    sock.open();
    await p;

    try {
      sock._h.get('message')?.({ type: 'message', data: encodeMessage({ a: 1 }) });
      // No await: delivered already.
      expect(seen).toEqual([{ a: 1 }]);
      expect(client._inboundChain, 'no chain was needed').toBe(null);
    } finally {
      client.close();
    }
  });

  it('counts a frame that decodes to nonsense rather than one that converts cleanly', async () => {
    // `decodeErrors` used to read 2 here, because both frames were undecodable as
    // Blobs. Now they convert and decode, so the counter has to mean something else:
    // it measures frames the library genuinely could not read. Bytes that survive
    // conversion and then fail in the codec are exactly that.
    const { client, socket } = await connect();
    const messages = [];
    client.on('message', (m) => messages.push(m));
    try {
      socket.message(encodeMessage({ a: 1 }));
      socket.message(encodeMessage({ a: 2 }));
      // Not a valid encoded message: converts fine, fails in the codec.
      socket._fire('message', new Blob([new Uint8Array([9, 9, 9, 9, 9, 9])]));
      await client._settleInbound();

      expect(messages).toEqual([{ a: 1 }, { a: 2 }]);
      expect(client.stats().received).toBe(2);
      expect(client.stats().decodeErrors).toBe(1);
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
      await client._settleInbound();
      expect(errors).toHaveLength(1);

      client._open().catch(() => {});
      const second = client._socket;
      second.open();
      second.message(encodeMessage({ a: 1 }));
      await client._settleInbound();

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
