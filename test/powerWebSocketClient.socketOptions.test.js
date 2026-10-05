/**
 * RT-037: options reach the socket constructor.
 *
 * `new this._WS(this.url, this.protocols)` passed nothing else, which is correct for a
 * browser — the DOM `WebSocket` constructor takes two arguments — and left a Node caller
 * with no way to set `headers` (auth, cookies), `perMessageDeflate` or `maxPayload`. The
 * only route was injecting a whole socket class through `WebSocketImpl`, which is
 * configuring a transport by replacing it.
 *
 * **The fix is a third argument, forwarded verbatim.** Two decisions, and the second is
 * the one worth arguing about:
 *
 * - **A browser ignores it, so it is forwarded unconditionally.** Branching on the
 *   implementation would mean deciding at runtime which of two socket contracts a
 *   caller's class follows, and getting that wrong means either losing the options on
 *   Node or passing a stray object to a browser. The DOM constructor discards extra
 *   arguments by specification, so there is nothing to branch on.
 * - **Nothing is validated, because nothing can be.** This library does not know what is
 *   behind `WebSocketImpl` — it could be `ws`, could be a browser, could be a fake in a
 *   test — so validating keys would be inventing a contract for a class it has never
 *   seen. A typo reaches the transport as a typo and fails there. Only the *shape* is
 *   checked, because that is the one thing knowable here.
 */
import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient } from '../src/index.js';

/**
 * A socket class that records what it was constructed with.
 *
 * @returns {any} The class, with a `seen` array on each instance's prototype record.
 */
function recordingSocket() {
  const seen = [];
  class Recording {
    constructor(url, protocols, options) {
      seen.push({ url, protocols, options });
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'arraybuffer';
      this._h = new Map();
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
  }
  return { Recording, seen };
}

describe('RT-037: socketOptions reaches the socket constructor', () => {
  it('passes the options as the third constructor argument', async () => {
    const { Recording, seen } = recordingSocket();
    const headers = { Authorization: 'Bearer t' };
    const client = new PowerWebSocketClient({
      url: 'ws://test/',
      WebSocketImpl: Recording,
      socketOptions: { headers, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 },
    });
    const p = client.connect();
    client._socket.open();
    await p;
    try {
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('ws://test/');
      expect(seen[0].options).toEqual({
        headers,
        perMessageDeflate: false,
        maxPayload: 8 * 1024 * 1024,
      });
    } finally {
      client.close();
    }
  });

  it('passes an empty object when none was given, rather than undefined', () => {
    // A transport that distinguishes `undefined` from `{}` — `ws` merges its options,
    // so `undefined` and `{}` behave the same there, but the point is that the
    // argument is *always* present. A class written as `(url, protocols, opts = {})`
    // behaves identically either way; one written as `(url, protocols, opts)` and then
    // `opts.headers` does not.
    const { Recording, seen } = recordingSocket();
    const client = new PowerWebSocketClient({ url: 'ws://test/', WebSocketImpl: Recording });
    expect(seen).toEqual([]);
    client._open().catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0].options).toEqual({});
    client.close();
  });

  it('copies the object, so mutating it afterwards changes nothing', () => {
    // The same rule `nonRetryableCloseCodes` follows, for the same reason: a reconnect
    // constructs a *new* socket, so a mutated options object would hand a later
    // connection different settings from the first.
    const { Recording, seen } = recordingSocket();
    const options = { headers: { a: '1' } };
    const client = new PowerWebSocketClient({
      url: 'ws://test/',
      WebSocketImpl: Recording,
      socketOptions: options,
    });
    client._open().catch(() => {});
    options.headers = { a: '2' };
    options.extra = true;
    client.close();

    client._open().catch(() => {});
    expect(seen).toHaveLength(2);
    expect(seen[0].options).toEqual({ headers: { a: '1' } });
    expect(seen[1].options, 'the reconnect gets the settings as configured').toEqual({
      headers: { a: '1' },
    });
  });

  it('passes the same copy to every reconnect', () => {
    const { Recording, seen } = recordingSocket();
    const client = new PowerWebSocketClient({
      url: 'ws://test/',
      WebSocketImpl: Recording,
      socketOptions: { perMessageDeflate: false },
    });
    for (let i = 0; i < 3; i += 1) {
      client._open().catch(() => {});
      client.close();
    }
    expect(seen).toHaveLength(3);
    // Identity, not just equality: this is the same object each time, which is what
    // "copied once at construction" means. If a future edit rebuilt it per socket the
    // equality assertions above would still pass and this one would not.
    expect(seen[1].options).toBe(seen[0].options);
    expect(seen[2].options).toBe(seen[0].options);
  });

  it('refuses a value that is not an object', () => {
    // The one thing that *is* knowable here: a non-object would be stringified into the
    // options position by a transport, so `socketOptions: 'headers'` would reach `ws`
    // as the four truthy characters rather than as a mistake anyone could see.
    for (const bad of [null, 'headers', 42, true, ['a']]) {
      expect(
        () => new PowerWebSocketClient({ url: 'ws://test/', socketOptions: bad }),
        String(bad)
      ).toThrow(TypeError);
    }
  });

  it('leaves the streams tier alone', () => {
    // `WebSocketStream` takes `(url, options)` — its second argument is already the
    // options bag, so the sub-protocols argument has nowhere to go. Passing a third
    // argument there would be a new question, and RT-037 is about the socket
    // constructor. Asserting the shape keeps the boundary visible.
    const { Recording } = recordingSocket();
    const client = new PowerWebSocketClient({ url: 'ws://test/', WebSocketImpl: Recording });
    // No WebSocketStreamImpl, so the client is on the socket tier: the third argument
    // went to the socket constructor and nothing else was constructed.
    expect(client._WSStream, 'no streams tier without an implementation').toBe(null);
    expect(client.socketOptions).toEqual({});
  });
});
