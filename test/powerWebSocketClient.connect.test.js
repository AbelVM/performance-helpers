import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';

/**
 * Three defects in `PowerWebSocketClient`, all of which a Node-only test cannot
 * see — which is why they survived.
 *
 * `RT-002` is the sharpest: a browser delivers every inbound frame as a `Blob`
 * unless `binaryType` is set, and this library only ever *sends* binary. So on a
 * browser every received binary frame failed to decode, while the identical code
 * on a Node `ws` socket worked. A test on Node cannot observe it, because Node
 * delivers `ArrayBuffer` anyway.
 *
 * `RT-001` and `RT-003` are both about a socket that behaves normally and a
 * client that never notices:
 *
 * - `error` and `close` reported the event but did not settle `connect()`, so a
 *   failed connect sat PENDING until the connect timeout — 10 s by default, and
 *   **forever** with `connectTimeoutMs: 0`, which is documented to "reject on a
 *   failed connect".
 * - there was no `pong` handler, so `_pingSentAt` was written and never read. On
 *   a `ws` socket, where `ping()` exists and the reply arrives as a `pong`
 *   event, the heartbeat deadline was never cleared, so **every healthy
 *   connection was closed with 4000 and reconnected, forever**. In a browser,
 *   where there is no `ping()`, the heartbeat was inert and `stats().rtt` was
 *   permanently empty.
 */

/**
 * A `_WS`-shaped socket the test drives by hand.
 *
 * `ping()` emits a `pong` immediately, which is what a healthy `ws` socket does
 * — and is the only way to reach the RTT path at all, since a socket without
 * `ping()` never arms the deadline and never has anything to clear.
 */
class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.pings = 0;
    this.closes = [];
    this.binaryType = undefined;
  }

  addEventListener(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(fn);
  }

  emit(name, event) {
    for (const fn of this.handlers.get(name) ?? []) fn(event);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closes.push([code, reason]);
  }

  /**
   * Reply on a macrotask, not synchronously.
   *
   * This is load-bearing and it is what the first draft got wrong. `_tickHeartbeat`
   * arms `_heartbeatDeadline` *after* calling `ping()`, so a socket that replies
   * synchronously has already delivered its `pong` before the deadline exists —
   * and `_handlePong`'s `clearHeartbeat()` then finds nothing to clear. With such
   * a fake, **deleting the clear from `_handlePong` did not fail a single test**,
   * which is the row's actual symptom (every healthy connection closed with 4000
   * and reconnected, forever) sitting unverified. A real socket replies over the
   * network, so the reply is always after the deadline is armed.
   */
  ping() {
    this.pings += 1;
    setTimeout(() => this.emit('pong', {}), 0);
  }
}

/**
 * @param {object} [options]
 * @returns {{client: PowerWebSocketClient, opened: () => FakeSocket}}
 */
function makeClient(options = {}) {
  let socket = null;
  const Impl = function () {
    socket = new FakeSocket();
    return socket;
  };
  const client = new PowerWebSocketClient({
    url: 'ws://example.test/',
    WebSocketImpl: Impl,
    autoReconnect: false,
    ...options,
  });
  // `socket` is only bound once the client constructs it, so the
  // accessor is the only safe way to reach it from a test.
  return { client, opened: () => socket };
}

/**
 * Let a promise settle, or report that it did not.
 *
 * A `connectTimeoutMs` of 10 s means the old code would leave the promise pending
 * for the whole test, so the harness asks a short question and says so.
 *
 * @param {Promise<*>} promise
 * @param {number} ms
 * @returns {Promise<string>}
 */
function outcomeWithin(promise, ms) {
  return Promise.race([
    promise.then(
      () => 'resolved',
      (e) => `rejected: ${e?.message ?? String(e)}`
    ),
    new Promise((resolve) => setTimeout(() => resolve('STILL PENDING'), ms)),
  ]);
}

describe('connect() settles when the attempt fails (RT-001)', () => {
  it('rejects on an error event rather than waiting for the connect timeout', async () => {
    const { client, opened } = makeClient({ connectTimeoutMs: 10_000 });
    const connecting = client.connect();
    connecting.catch(() => {});

    // Before the error: still legitimately pending, with a timer armed.
    expect(await outcomeWithin(connecting, 40)).toBe('STILL PENDING');

    opened().emit('error', { message: 'refused' });
    // The point of the row: the old code reported the event and left the promise
    // pending, so this is where it rejected only at the *timeout*.
    expect(await outcomeWithin(connecting, 40)).toBe('rejected: refused');
    client.dispose();
  });

  it('rejects on a close before open, which is how a refused connect usually looks', async () => {
    const { client, opened } = makeClient({ connectTimeoutMs: 10_000 });
    const connecting = client.connect();
    connecting.catch(() => {});
    opened().emit('close', { code: 1006, reason: 'refused' });
    expect(await outcomeWithin(connecting, 40)).toMatch(/^rejected: /);
    client.dispose();
  });

  it('settles promptly even with connectTimeoutMs: 0, which means "wait forever"', async () => {
    // The severity of the row. With the timeout disabled there is no other path to
    // a settlement at all, so the promise never settled *at all* — and the guide
    // promises "rejects on a failed connect".
    const { client, opened } = makeClient({ connectTimeoutMs: 0 });
    const connecting = client.connect();
    connecting.catch(() => {});
    opened().emit('error', { message: 'refused' });
    expect(await outcomeWithin(connecting, 40)).toBe('rejected: refused');
    client.dispose();
  });
});

describe('the client asks the socket for ArrayBuffer frames (RT-002)', () => {
  it('sets binaryType before any frame can arrive', async () => {
    // Set at construction, not on first message: the browser reads the property
    // when it delivers each frame, so a frame that arrives before the assignment
    // is already a `Blob`.
    const { client, opened } = makeClient();
    client.connect();
    expect(opened().binaryType).toBe('arraybuffer');
    client.dispose();
  });

  it('still connects when the implementation refuses the assignment', () => {
    // Some implementations expose `binaryType` as a getter-only accessor, and
    // throwing there would leave a client that cannot connect at all — worse than
    // one that connects with the platform default.
    const { client, opened } = makeClient();
    // `connect()` is what constructs the socket, so the property has to be made
    // read-only *after* that — and there is a race here worth naming: the
    // assignment happens during construction, so a getter-only `binaryType` is
    // installed before the client can ever read it back.
    client.connect();
    const sock = opened();
    Object.defineProperty(sock, 'binaryType', {
      get() {
        return 'blob';
      },
      set() {
        throw new TypeError('read-only');
      },
      configurable: true,
    });
    sock.emit('open', {});
    expect(client.readyState).toBe(1);
    client.dispose();
  });
});

describe('the heartbeat is answered (RT-003)', () => {
  it('does not close a healthy socket that replies to pings', async () => {
    // The row's worst symptom: with no `pong` handler the deadline was never
    // cleared, so every healthy `ws` connection was closed with 4000 and
    // reconnected, forever.
    const { client, opened } = makeClient({
      heartbeatIntervalMs: 5,
      pongTimeoutMs: 60,
    });
    client.connect();
    const sock = opened();
    sock.emit('open', {});
    await new Promise((resolve) => setTimeout(resolve, 80));

    // `> 1` is the load-bearing number, and getting it wrong is how the first
    // version of this file passed against a broken client: the heartbeat *ran*
    // once and stopped, because clearing the reply was cancelling the heartbeat's
    // own interval as well as the probe's deadline. A heartbeat that fires once is
    // not a heartbeat.
    expect(sock.pings).toBeGreaterThanOrEqual(3);
    expect(sock.closes, 'a healthy socket was closed on a heartbeat timeout').toEqual([]);
    client.dispose();
  });

  it('records RTT, so stats() reports a measurement rather than nothing', async () => {
    // The test the plan names — "records RTT" — asserted `rtt.count === 0`,
    // which is the bug described as if it were the expectation.
    const { client, opened } = makeClient({
      heartbeatIntervalMs: 5,
      pongTimeoutMs: 60,
    });
    client.connect();
    opened().emit('open', {});
    await new Promise((resolve) => setTimeout(resolve, 60));

    const stats = client.stats();
    // More than one sample, for the same reason: a single sample is a heartbeat
    // that fired once and stopped.
    expect(stats.rtt.count).toBeGreaterThanOrEqual(3);
    expect(stats.heartbeats).toBe(stats.rtt.count);
    expect(typeof stats.rtt.p50).toBe('number');
    client.dispose();
  });

  it('reports canPing false when the transport cannot ping, so empty is not zero', async () => {
    // A browser socket has no `ping()`, so the heartbeat is inert and
    // `rtt.count` stays 0 — which reads as "0 ms latency" and is a claim the
    // client never earned. `false` says unmeasured.
    const { client, opened } = makeClient({ heartbeatIntervalMs: 0 });
    client.connect();
    const sock = opened();
    // Not `delete`: `ping` is on the prototype, so deleting the own property
    // leaves it callable. A browser socket simply has no such method.
    sock.ping = undefined;
    sock.emit('open', {});

    expect(client.stats().rtt.canPing).toBe(false);
    expect(client.stats().rtt.count).toBe(0);
    client.dispose();
  });
});
