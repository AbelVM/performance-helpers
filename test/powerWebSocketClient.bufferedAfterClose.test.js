import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient } from '../src/index.js';

/**
 * RT-018 — the `bufferedAmount`-after-close trap, pinned.
 *
 * MDN, on `WebSocket.bufferedAmount`: *"This value does not reset to zero when
 * the connection is closed; if you keep calling `send()`, this will continue to
 * climb."* The number meant to say "the socket is full" therefore keeps growing
 * on a socket that is not open and never comes back down, so a naive wait loop
 * spins forever rather than applying back-pressure — and it spins *silently*,
 * because every check keeps passing.
 *
 * **The guide documents the trap. This file makes sure the client does not have
 * it.** `bufferedAmount` here returns `0` unless `readyState === OPEN`, so a
 * closed or not-yet-open socket reads as *empty* rather than *full*. Reading the
 * raw socket instead would reintroduce the hang, and nothing else in the suite
 * would notice — which is why the property is asserted directly rather than left
 * as a consequence of the getter's implementation.
 *
 * These drive the private getter and the state directly rather than a fake
 * socket: the earlier `maxPayloadSizeBytes` attempt at a fake never completed its
 * open handshake, and a fixture that silently delivers nothing would make every
 * case here pass vacuously.
 */

/** A socket whose `bufferedAmount` climbs, the way MDN describes after close. */
function climbingSocket(readyState = 1) {
  return {
    readyState,
    bufferedAmount: 0,
    addEventListener() {},
    removeEventListener() {},
    send() {},
    close() {},
    /** What MDN describes: sends on a closed socket keep raising the number. */
    sendAfterClose(bytes) {
      this.bufferedAmount += bytes;
    },
  };
}

/** A client over a climbing socket, with the handshake bypassed. */
function client(socket, options = {}) {
  const c = new PowerWebSocketClient({
    url: 'ws://example.invalid/',
    autoReconnect: false,
    WebSocketImpl: function FakeSocket() {
      return socket;
    },
    ...options,
  });
  // The constructor does not auto-connect and a fake socket never completes the
  // handshake, so both fields are set directly — these tests are about the
  // getter, not about connecting. The first draft passed the socket as
  // `WebSocketImpl` and assumed the client would adopt it; it does not, the
  // getter read a different socket, and four of five cases passed *because they
  // all expected 0*. That is the vacuous-pass trap again, one layer down.
  c._socket = socket;
  return c;
}

describe('RT-018: bufferedAmount reads as empty unless the socket is open', () => {
  it('reports 0 on a closed socket even when the raw number has climbed', () => {
    // The trap itself. `bufferedAmount` is 64 KiB on a socket whose readyState
    // is CLOSED, which is the state MDN says it never comes back down from. A
    // producer watching this reads "full" forever.
    const socket = climbingSocket(3); // CLOSING
    const c = client(socket);
    c._state = 3;

    socket.sendAfterClose(64 * 1024);
    expect(socket.bufferedAmount, 'the raw socket has climbed').toBe(64 * 1024);
    expect(c.bufferedAmount, 'and this client does not report it').toBe(0);
  });

  it('reports 0 before the socket has opened', () => {
    // The other half: CONNECTING is not "full" either. A client constructed and
    // fed before `open` would otherwise pause on a number that means nothing yet.
    const socket = climbingSocket(0); // CONNECTING
    const c = client(socket);
    c._state = 0;

    expect(c.bufferedAmount).toBe(0);
  });

  it('reports the real number while the socket is open', () => {
    // The control: the gate must not flatten a genuinely-full open socket, or the
    // watermarks would never engage.
    const socket = climbingSocket(1); // OPEN
    const c = client(socket);
    c._state = 1;

    socket.bufferedAmount = 2 * 1024 * 1024;
    expect(c.bufferedAmount).toBe(2 * 1024 * 1024);

    socket.bufferedAmount = 512;
    expect(c.bufferedAmount).toBe(512);
  });

  it('reports 0 when there is no socket even while the state says open', () => {
    // **The state is deliberately `OPEN` here**, and that is the correction. The
    // first draft set `_state = 3` alongside `_socket = null`, so the state check
    // short-circuited and the `this._socket` guard was never reached — removing
    // that guard left all five tests passing, which is how a vacuous case gets
    // written.
    //
    // The hazard it has to cover: a poll timer fires after the socket has been
    // torn down but before the state has moved off `OPEN`. Reading
    // `.bufferedAmount` off `null` would throw from inside a timer callback,
    // where nothing catches it.
    const socket = climbingSocket(1);
    const c = client(socket);
    c._state = 1;
    expect(c.bufferedAmount, 'sanity: reports before teardown').toBeGreaterThanOrEqual(0);

    c._socket = null; // torn down, state not yet updated
    c._state = 1; // still OPEN

    expect(() => c.bufferedAmount, 'must not throw from a timer').not.toThrow();
    expect(c.bufferedAmount).toBe(0);
  });

  it('coerces a non-numeric bufferedAmount to 0 rather than NaN', () => {
    // A `ws` socket or a proxy shim can report a string or undefined. `NaN`
    // propagates into every comparison the poll makes, and `NaN > limit` is
    // false — so the socket would silently be treated as *empty* rather than
    // reported, which is the more dangerous direction.
    const socket = climbingSocket(1);
    const c = client(socket);
    c._state = 1;

    for (const value of [undefined, null, 'lots', Number.NaN]) {
      socket.bufferedAmount = value;
      expect(c.bufferedAmount, `coerces ${String(value)}`).toBe(0);
    }
  });
});
