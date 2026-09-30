/**
 * `detectSocketKind` and the Streams tier — two silent-failure defects.
 *
 * **Detection matched every TCP socket in existence.** The predicate was
 * `socket.readable && socket.writable`, and on a Node `Duplex` — `net.Socket`
 * above all — those two properties are **booleans**, not streams. So a plain TCP
 * socket was classified `'stream'`, the adapter read `socket.readable === true`,
 * found no `getReader`, and returned without attaching anything. Measured
 * against a real `net.Socket` on a real loopback connection whose peer echoed
 * every byte it received:
 *
 *     detectSocketKind(netSocket) -> 'stream'
 *     adapter.kind                -> 'stream'
 *     send()                      -> false, every call
 *     isOpen / readyState         -> true / 1
 *     messages delivered          -> 0, of 1 the socket had echoed
 *
 * The guide's stated goal is that an unrecognised object **throws**, and a raw
 * TCP socket is not a `ws` socket, a browser `WebSocket` or a
 * `WebSocketStream`. It throws now.
 *
 * **The documented escape hatch did not work.** The error message ends "Pass
 * `kind` explicitly to override detection", and the line *after* the
 * assignment called `detectSocketKind` a second time regardless — so on exactly
 * the sockets detection rejects, following the message reproduced the error it
 * told you to bypass. The guard beside it could never be true: with no `kind`
 * the comparison is `x !== x`, and with one the `&& !kind` is false.
 *
 * **A closed stream stayed locked.** `_writeStream`'s own comment calls a
 * permanently locked stream permanent damage, but the lock was released only by
 * `_detach`, which runs on `dispose()`. A socket that closed — and `close()` is
 * one of the adapter's own methods — left `writable` locked for good.
 *
 * Counts, shapes and lock states throughout. No durations: the harness measures
 * a ~28% median spread, and nothing here is a timing property.
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { PowerSocketAdapter, detectSocketKind } from '../src/helpers/powerSocketAdapter.js';

describe('detectSocketKind rejects things that only look like a socket', () => {
  it('does not classify a real net.Socket as a stream', async () => {
    // A real Duplex on a real loopback connection, not a fake: the defect is
    // that `readable`/`writable` are *booleans* here, and a hand-rolled object
    // that reproduced that would be a synthetic harness for a claim about the
    // real call path.
    const server = net.createServer((s) => s.on('data', (d) => s.write(d)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {net.AddressInfo} */ (server.address()).port;
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));

    try {
      // The shape, stated plainly: both properties truthy, neither a stream.
      expect(socket.readable).toBe(true);
      expect(socket.writable).toBe(true);
      expect(typeof socket.readable).not.toBe('object');
      expect(typeof socket.writable).not.toBe('object');

      expect(() => detectSocketKind(socket)).toThrow(/cannot detect the socket model/);
      // It is an EventEmitter, which is why the `on`-only predicate used to
      // accept it, but it has no `send`, so it is not a `ws` socket either.
      expect(typeof socket.on).toBe('function');
      expect(socket.send).toBeUndefined();
    } finally {
      socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('the constructor refuses a net.Socket rather than attaching nothing', async () => {
    // The consequence that matters. Before the fix this constructed cleanly,
    // reported `isOpen: true`, and delivered no message ever — a healthy-looking
    // adapter that was permanently deaf.
    const server = net.createServer((s) => s.on('data', (d) => s.write(d)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = /** @type {net.AddressInfo} */ (server.address()).port;
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));

    const seen = [];
    try {
      expect(
        () =>
          new PowerSocketAdapter(/** @type {any} */ (socket), { onMessage: (m) => seen.push(m) })
      ).toThrow(/cannot detect the socket model/);

      socket.write('ping');
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Nothing was attached, so the echo went nowhere. Asserted as a count
      // rather than a timeout on the adapter.
      expect(seen).toEqual([]);
    } finally {
      socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still accepts the three supported models', () => {
    // The tightening must not cost a real one. `ws`-shaped, browser-shaped and
    // stream-shaped, each with the members the new predicate asks for.
    const wsLike = { on: () => {}, send: () => {}, ping: () => {} };
    const browserLike = { addEventListener: () => {}, send: () => {} };
    const streamLike = { writable: { getWriter: () => {} } };

    expect(detectSocketKind(wsLike)).toBe('ws');
    expect(detectSocketKind(browserLike)).toBe('websocket');
    expect(detectSocketKind(streamLike)).toBe('stream');
  });

  it('accepts a not-yet-open stream, whose readable is still null', () => {
    // The case that made the `readable`-side check insufficient on its own: a
    // `WebSocketStream` reports `readable: null` until its connection opens.
    // Checking only `readable` would reject it, so `writable` is checked first.
    const notYetOpen = { readable: null, writable: { getWriter: () => {} } };
    expect(detectSocketKind(notYetOpen)).toBe('stream');
  });

  it('still rejects an object it cannot identify', () => {
    expect(() => detectSocketKind({})).toThrow(/cannot detect the socket model/);
    expect(() => detectSocketKind({ on: () => {} })).toThrow(
      /cannot detect the socket model/,
      'an EventEmitter with no `send` is not a ws socket'
    );
    expect(() => detectSocketKind(null)).toThrow(/must be an object/);
  });
});

describe('the `kind` override actually overrides', () => {
  it('constructs on a socket detection rejects', () => {
    // Following the error message's own instruction used to throw that error.
    // This is the one behaviour the message promises.
    //
    // The socket is one detection genuinely rejects, which the tightened
    // predicate makes narrower: a not-yet-open `WebSocketStream` is now
    // *detected* (its `writable` carries `getWriter`), so it no longer needs
    // the override. What still needs it is a socket whose stream members are
    // absent until something replaces them, and a caller who knows better than
    // the detector — the reason the option exists.
    const undetectable = { readable: null, writable: null, on: () => {} };
    expect(() => detectSocketKind(undetectable)).toThrow(/cannot detect the socket model/);
    expect(
      () => new PowerSocketAdapter(/** @type {any} */ (undetectable), { kind: 'stream' })
    ).not.toThrow();
  });

  it('honours the override over detection when both are possible', () => {
    // An EventEmitter with a `send` is detectable as `ws`; asking for `stream`
    // must win, or the option is decorative.
    const detectable = { on: () => {}, send: () => {} };
    const adapter = new PowerSocketAdapter(/** @type {any} */ (detectable), { kind: 'stream' });
    expect(adapter.kind).toBe('stream');
  });

  it('rejects an unknown kind rather than storing it', () => {
    // An unrecognised kind used to be kept and then match no branch in
    // `_attach`, which is the silent-deafness failure this class exists to avoid
    // — reachable by a typo, which is exactly the class of mistake the
    // `scheduling` option is documented to throw on.
    const wsLike = { on: () => {}, send: () => {} };
    expect(() => new PowerSocketAdapter(/** @type {any} */ (wsLike), { kind: 'typo' })).toThrow(
      /unknown kind/
    );
    // Each kind is checked against a socket it can actually drive, because
    // `_attach` dispatches on `kind`: asking for `'websocket'` on a `ws` socket
    // constructs and then throws on `addEventListener`, which says nothing about
    // whether the value was accepted. First written as one loop over all three
    // kinds and one shared object, which failed for exactly that reason.
    const matching = [
      ['stream', { readable: null, writable: { getWriter: () => ({ releaseLock() {} }) } }],
      ['websocket', { addEventListener: () => {}, send: () => {} }],
      ['ws', wsLike],
    ];
    for (const [kind, socket] of matching) {
      const adapter = new PowerSocketAdapter(/** @type {any} */ (socket), { kind });
      expect(adapter.kind, `kind '${kind}' must be accepted`).toBe(kind);
      adapter.dispose();
    }
  });
});

describe('the Streams tier releases its lock when the socket closes', () => {
  /** A real `WritableStream`, so the lock semantics are the platform's. */
  const makeStream = () => {
    const state = { written: /** @type {any[]} */ ([]) };
    const socket = {
      readable: new ReadableStream({
        start(c) {
          state.push = (/** @type {any} */ v) => c.enqueue(v);
        },
      }),
      writable: new WritableStream({
        write(chunk) {
          state.written.push(chunk);
        },
      }),
    };
    return { socket, state };
  };

  it('unlocks writable on close, not only on dispose', async () => {
    // The comment on `_writeStream` calls a permanently locked stream permanent
    // damage. The lock was released from `_detach`, which runs on `dispose()`,
    // so a socket that closed left it locked for good.
    const { socket, state } = makeStream();
    const adapter = new PowerSocketAdapter(/** @type {any} */ (socket), { onMessage: () => {} });

    expect(adapter.send('one')).toBe(true);
    expect(socket.writable.locked).toBe(true);

    state.push('inbound');
    await new Promise((resolve) => setTimeout(resolve, 10));
    adapter.close();

    expect(socket.writable.locked).toBe(false);
    adapter.dispose();
  });

  it('a caller holding the socket can write to it again after a close', async () => {
    // The consequence: `getWriter()` throws while locked, so "locked" is not a
    // state flag but a refused write for anyone else holding the stream.
    const { socket, state } = makeStream();
    const adapter = new PowerSocketAdapter(/** @type {any} */ (socket), { onMessage: () => {} });
    expect(adapter.send('one')).toBe(true);

    state.push('inbound');
    await new Promise((resolve) => setTimeout(resolve, 10));
    adapter.close();

    expect(() => socket.writable.getWriter()).not.toThrow();
    expect(state.written).toEqual(['one']);
    adapter.dispose();
  });

  it('close followed by dispose is not a double release', async () => {
    // Both paths call the same helper, so this is the overlap the extraction
    // introduced. `releaseLock()` on an already-released writer throws in some
    // implementations, and `dispose()` must stay safe to call after `close()`.
    const { socket, state } = makeStream();
    const adapter = new PowerSocketAdapter(/** @type {any} */ (socket), { onMessage: () => {} });
    expect(adapter.send('one')).toBe(true);

    state.push('inbound');
    await new Promise((resolve) => setTimeout(resolve, 10));
    adapter.close();

    expect(() => adapter.dispose()).not.toThrow();
    expect(() => adapter[Symbol.dispose]()).not.toThrow();
    expect(socket.writable.locked).toBe(false);
  });
});
