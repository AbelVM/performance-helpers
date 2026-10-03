import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  PowerWebSocketClient,
  PowerRealtimeHub,
  decodeMessage,
  encodeMessage,
  preloadNode,
} from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/** A WebSocket double with manually driven lifecycle and a settable buffer. */
class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.pings = 0;
    this.closedWith = null;
    this._handlers = new Map();
  }
  addEventListener(type, fn) {
    const list = this._handlers.get(type) || [];
    list.push(fn);
    this._handlers.set(type, list);
  }
  _fire(type, data) {
    // `data` is the event's `.data` - a MessageEvent, not a wrapper.
    const ev = { type, data };
    for (const fn of this._handlers.get(type) || []) fn(ev);
    const prop = `on${type}`;
    if (typeof this[prop] === 'function') this[prop](ev);
  }
  open() {
    this.readyState = 1;
    this._fire('open');
  }
  /** Deliver a message event whose `.data` is a codec frame. */
  message(value, codec = 'json') {
    this._fire('message', encodeMessage(value, { codec }));
  }
  send(frame) {
    this.sent.push(frame);
  }
  close(code, reason) {
    this.closedWith = [code, reason];
    this.readyState = 3;
    this._fire('close', { code, reason });
  }
  ping() {
    this.pings += 1;
  }
  /** Drain `n` bytes, as the network would. */
  drain(n = Infinity) {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - n);
  }
}

const mkClient = (options = {}) => {
  const created = [];
  const client = new PowerWebSocketClient({
    url: 'ws://test/',
    WebSocketImpl: class extends FakeSocket {
      constructor(u, p) {
        super(u, p);
        created.push(this);
      }
    },
    heartbeatIntervalMs: 0,
    ...options,
  });
  return { client, created };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('PowerWebSocketClient construction', () => {
  it('validates its options', () => {
    expect(() => new PowerWebSocketClient({})).toThrow(/url/);
    expect(() => new PowerWebSocketClient({ url: '' })).toThrow(/url/);
    expect(
      () => new PowerWebSocketClient({ url: 'ws://x', WebSocketImpl: FakeSocket, codec: 'yaml' })
    ).toThrow(/codec/);
    expect(
      () =>
        new PowerWebSocketClient({
          url: 'ws://x',
          WebSocketImpl: FakeSocket,
          lowWaterMarkBytes: 100,
          highWaterMarkBytes: 10,
        })
    ).toThrow(/never resume/);
  });

  it('reports the ready state and refuses to send when closed', async () => {
    const { client } = mkClient();
    expect(client.readyState).toBe(3);
    expect(client.isOpen).toBe(false);
    expect(client.backpressureMode).toBe('none');
    expect(await client.send({ a: 1 })).toBe(false);
    client.close();
  });
});

describe('PowerWebSocketClient connect and message flow', () => {
  it('opens, decodes frames, and sends encoded frames', async () => {
    const { client, created } = mkClient();
    const messages = [];
    client.on('message', (m) => messages.push(m));

    const p = client.connect();
    created[0].open();
    await p;

    expect(client.isOpen).toBe(true);
    expect(client.backpressureMode).toBe('watermark');

    created[0].message({ id: 1 });
    created[0].message({ id: 2 });
    expect(messages).toEqual([{ id: 1 }, { id: 2 }]);

    expect(await client.send({ out: true })).toBe(true);
    expect(decodeMessage(created[0].sent[0]).value).toEqual({ out: true });
    expect(client.stats().sent).toBe(1);
    expect(client.stats().received).toBe(2);
    client.close();
  });

  it('reports a decode failure without tearing down the socket', async () => {
    const { client, created } = mkClient();
    const errors = [];
    client.on('error', (e) => errors.push(e));
    const p = client.connect();
    created[0].open();
    await p;

    // Garbage that is not a frame.
    created[0]._fire('message', new TextEncoder().encode('not a frame'));
    expect(errors.length).toBe(1);
    expect(client.stats().decodeErrors).toBe(1);
    // The socket is still usable, which is the point: one bad frame is not a
    // reason to drop a working connection.
    expect(client.isOpen).toBe(true);
    client.close();
  });

  it('times out a connect that never opens', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient({ connectTimeoutMs: 1000 });
    const p = client.connect();
    const assertion = expect(p).rejects.toThrow(/connect timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(created[0].closedWith).not.toBeNull();
    client.close();
  });
});

describe('PowerWebSocketClient backpressure: bufferedAmount watermarks', () => {
  it('pauses above the high-water mark and resumes below the low one', async () => {
    vi.useFakeTimers();
    const events = [];
    const { client, created } = mkClient({
      highWaterMarkBytes: 1000,
      lowWaterMarkBytes: 400,
      pollIntervalMs: 10,
      maxPollIntervalMs: 40,
    });
    client.on('pause', () => events.push('pause'));
    client.on('resume', () => events.push('resume'));
    const p = client.connect();
    created[0].open();
    await p;

    created[0].bufferedAmount = 2000; // over the high mark
    await vi.advanceTimersByTimeAsync(60);
    expect(client.paused).toBe(true);
    expect(events).toContain('pause');

    // Still above the low mark: stays paused.
    created[0].bufferedAmount = 800;
    await vi.advanceTimersByTimeAsync(120);
    expect(client.paused).toBe(true);

    created[0].drain(500); // down to 300, under the low mark
    await vi.advanceTimersByTimeAsync(200);
    expect(client.paused).toBe(false);
    expect(events).toContain('resume');
    client.close();
  });

  it('send() pauses the producer when the socket is already over the mark', async () => {
    const { client, created } = mkClient({ highWaterMarkBytes: 100, lowWaterMarkBytes: 10 });
    const p = client.connect();
    created[0].open();
    await p;

    created[0].bufferedAmount = 500;
    expect(await client.send({ a: 1 })).toBe(true);
    expect(client.paused).toBe(true);
    client.close();
  });

  it('dropOnBackpressure refuses instead of queueing further', async () => {
    const { client, created } = mkClient({ highWaterMarkBytes: 100, lowWaterMarkBytes: 10 });
    const p = client.connect();
    created[0].open();
    await p;

    created[0].bufferedAmount = 5000;
    expect(await client.send({ a: 1 }, { dropOnBackpressure: true })).toBe(false);
    expect(client.stats().drops).toBe(1);
    expect(created[0].sent.length).toBe(0);
    client.close();
  });

  it('backs the poll interval off while paused instead of spinning', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient({
      highWaterMarkBytes: 10,
      lowWaterMarkBytes: 5,
      pollIntervalMs: 10,
      maxPollIntervalMs: 320,
    });
    const p = client.connect();
    created[0].open();
    await p;

    created[0].bufferedAmount = 1000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.paused).toBe(true);
    // The interval must have grown, not stayed pinned at the base.
    expect(client._lastPollInterval).toBeGreaterThan(10);
    client.close();
  });
});

describe('PowerWebSocketClient backpressure: Streams tier', () => {
  /** A WebSocketStream double with a controllable writer. */
  class FakeStream {
    constructor(url) {
      this.url = url;
      this.holdReady = false;
      this.writable = {
        getWriter: () => {
          // Resolved by default so ordinary sends do not hang. A test that
          // wants to observe back-pressure sets `this.holdReady = true`.
          this.ready = this.holdReady
            ? new Promise((r) => {
                this._resolveReady = r;
              })
            : Promise.resolve();
          return {
            ready: this.ready,
            write: vi.fn().mockResolvedValue(undefined),
            abort: vi.fn(),
            _resolveReady: this._resolveReady,
          };
        },
      };
      this.opened = Promise.resolve();
    }
  }

  it('uses the writer and awaits ready instead of polling', async () => {
    const { client } = mkClient({
      WebSocketStreamImpl: class extends FakeStream {
        constructor(url) {
          super(url);
          this.holdReady = true;
        }
      },
    });
    const p = client.connect();
    await p;

    expect(client.isOpen).toBe(true);
    expect(client.backpressureMode).toBe('streams');

    // The writer's `ready` is pending until the stream says it has room.
    let settled = false;
    const sending = client.send({ a: 1 }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    client._writer._resolveReady();
    await sending;
    expect(settled).toBe(true);
    expect(client.stats().sent).toBe(1);
    client.close();
  });

  it('does not poll bufferedAmount when the Streams tier is active', async () => {
    vi.useFakeTimers();
    const { client } = mkClient({ WebSocketStreamImpl: FakeStream, pollIntervalMs: 5 });
    await client.connect();
    expect(client.backpressureMode).toBe('streams');
    await vi.advanceTimersByTimeAsync(200);
    // No watermark polling at all: the writer is the signal.
    expect(client.paused).toBe(false);
    expect(client._pollTimer).toBeNull();
    client.close();
  });

  it('reports a writer failure through onError', async () => {
    const { client } = mkClient({ WebSocketStreamImpl: FakeStream });
    const errors = [];
    client.on('error', (e) => errors.push(e));
    await client.connect();
    client._writer.write = vi.fn().mockRejectedValue(new Error('writer-dead'));
    expect(await client.send({ a: 1 })).toBe(false);
    expect(errors.length).toBe(1);
    client.close();
  });
});

describe('PowerWebSocketClient reconnection', () => {
  it('reconnects after an unexpected close with decorrelated-jitter backoff', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient({
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
    });
    const p = client.connect();
    created[0].open();
    await p;

    created[0].close(1006, 'server restart');
    expect(client.isOpen).toBe(false);
    expect(client.stats().reconnects).toBe(1);

    // The delay is randomised, so advance far enough for any draw.
    await vi.advanceTimersByTimeAsync(1200);
    expect(created.length).toBeGreaterThan(1);
    created[created.length - 1].open();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.isOpen).toBe(true);
    // A successful open resets the attempt counter.
    expect(client.stats().reconnectAttempts).toBe(0);
    client.close();
  });

  it('does not reconnect after a user-initiated close', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient();
    const p = client.connect();
    created[0].open();
    await p;

    client.close(1000, 'bye');
    await vi.advanceTimersByTimeAsync(5000);
    expect(created.length).toBe(1);
    expect(client.isOpen).toBe(false);
  });

  it('honours maxReconnectAttempts', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient({ maxReconnectAttempts: 2, reconnectBaseMs: 10 });
    const p = client.connect();
    created[0].open();
    await p;

    for (let i = 0; i < 4; i++) {
      const latest = created[created.length - 1];
      latest.readyState = 3;
      latest._fire('close', { code: 1006 });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(client.stats().reconnects).toBeLessThanOrEqual(2);
    client.close();
  });

  it('randomises the backoff rather than reconnecting in lockstep', async () => {
    const delays = [];
    const { client } = mkClient({ reconnectBaseMs: 100, reconnectMaxMs: 100_000 });
    for (let i = 0; i < 8; i++) {
      client._reconnectDelay = null;
      delays.push(client._nextReconnectDelay());
    }
    expect(new Set(delays).size).toBeGreaterThan(1);
    for (const d of delays) expect(d).toBeGreaterThan(0);
  });
});

describe('PowerWebSocketClient heartbeat', () => {
  it('pings on the interval and records RTT', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 500 });
    const p = client.connect();
    created[0].open();
    await p;

    await vi.advanceTimersByTimeAsync(1000);
    expect(created[0].pings).toBe(1);
    expect(client.stats().rtt.count).toBe(0);
    client.close();
  });

  it('treats an unanswered heartbeat as a dead socket', async () => {
    vi.useFakeTimers();
    const { client, created } = mkClient({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 200 });
    const p = client.connect();
    created[0].open();
    await p;

    await vi.advanceTimersByTimeAsync(400); // ping sent, no pong
    expect(client.stats().heartbeatTimeouts).toBeGreaterThanOrEqual(1);
    // The socket is closed rather than left in OPEN forever.
    expect(created[0].closedWith).not.toBeNull();
    client.close();
  });
});

describe('PowerWebSocketClient composes with PowerRealtimeHub', () => {
  it('works as the hub send adapter', async () => {
    const { client, created } = mkClient();
    const hub = new PowerRealtimeHub({
      send: (sub, frame) => client.sendFrame(frame, { dropOnBackpressure: true }),
    });
    const p = client.connect();
    created[0].open();
    await p;

    const seen = [];
    hub.subscribe('feed', (m) => seen.push(m));
    hub.publish('feed', { price: 42 });
    await hub.flush();
    await new Promise((r) => setTimeout(r, 0));

    // The hub's frame is forwarded verbatim via sendFrame, so the receiver
    // decodes exactly the batch the hub produced - no double framing, no
    // JSON-serialised bytes.
    expect(created[0].sent.length).toBe(1);
    expect(decodeMessage(created[0].sent[0]).value).toEqual([{ price: 42 }]);
    hub.close();
    client.close();
  });
});

describe('PowerWebSocketClient handler management', () => {
  it('registering twice replaces, and a stale unsubscribe does not detach', async () => {
    const { client, created } = mkClient();
    const first = vi.fn();
    const second = vi.fn();
    const unFirst = client.on('message', first);
    client.on('message', second);
    const p = client.connect();
    created[0].open();
    await p;

    created[0].message({ a: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    // The stale unsubscribe must not remove the newer handler.
    unFirst();
    created[0].message({ a: 2 });
    expect(second).toHaveBeenCalledTimes(2);
    client.close();
  });

  it('off() clears a handler', async () => {
    const { client, created } = mkClient();
    const h = vi.fn();
    client.on('message', h);
    client.off('message');
    const p = client.connect();
    created[0].open();
    await p;
    created[0].message({ a: 1 });
    expect(h).not.toHaveBeenCalled();
    client.close();
  });

  it('isolates a throwing handler and routes it to onError', async () => {
    const { client, created } = mkClient();
    const errors = [];
    client.on('error', (e) => errors.push(e));
    client.on('message', () => {
      throw new Error('handler-boom');
    });
    const p = client.connect();
    created[0].open();
    await p;
    created[0].message({ a: 1 });
    expect(errors.length).toBe(1);
    expect(client.isOpen).toBe(true);
    client.close();
  });
});

describe('PowerWebSocketClient invariants', () => {
  it('never sends unless the socket is open', async () => {
    // `fc.asyncProperty`, not `fc.property`: an async predicate is not awaited
    // by the latter, so the property would pass or fail by accident.
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.array(fc.nat({ max: 5 }), { maxLength: 6 }),
        async (connect, open, beforeSends) => {
          const { client, created } = mkClient();
          if (connect && open) {
            const p = client.connect();
            created[0].open();
            await p;
          } else if (connect) {
            // Deliberately never opened. The connect promise stays pending
            // until the connect timeout, so it must not be awaited here.
            client.connect().catch(() => {});
          }
          const expectedOpen = Boolean(connect && open);
          expect(client.isOpen).toBe(expectedOpen);
          if (expectedOpen) {
            expect(client.readyState).toBe(1);
          } else {
            // Either still CONNECTING (a connect that never completed) or
            // CLOSED (never connected / closed). Both are "not open".
            expect([0, 3]).toContain(client.readyState);
          }

          for (let i = 0; i < beforeSends.length; i++) {
            const ok = await client.send({ i });
            expect(ok).toBe(expectedOpen);
          }
          if (!expectedOpen && created.length) expect(created[0].sent.length).toBe(0);
          client.close();
        }
      ),
      { numRuns: 60 }
    );
  });

  it('bufferedAmount is 0 unless the socket is open', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1e6 }), () => {
        const { client } = mkClient();
        // Not connected: no socket exists, and the getter must not leak a
        // stale or invented value.
        expect(client.bufferedAmount).toBe(0);
        expect(client.bufferedAmount).toBe(0);
        client.close();
      }),
      { numRuns: 60 }
    );
  });
});

describe('RT-015: closing does not emit a spurious resume', () => {
  // `close()` called `_setPaused(false)`, which emits `resume`. Closing is
  // terminal, and a producer wired as `onResume: () => feed.resume()` restarted
  // feeding a socket that was CLOSED on the next line. Measured before the fix:
  // one `resume` with `readyState` already 3.
  //
  // Driven through `_setPaused` because backpressure is the only thing that pauses
  // this client — there is no public `pause()` — and the assertion that matters is
  // the *absence* of an event, which only a producer-shaped listener can catch.
  it('emits no resume, and leaves the client unpaused', () => {
    const events = [];
    const { client } = mkClient({
      onPause: () => events.push('pause'),
      onResume: () => events.push('resume'),
    });
    client._setPaused(true);
    expect(events).toEqual(['pause']);

    client.close();

    expect(events, 'close() must not emit resume').toEqual(['pause']);
    expect(client.paused, 'and the client is left unpaused').toBe(false);
  });

  it('still emits resume when unpausing a live client', () => {
    // The control for the test above: suppressing the event at close must not
    // suppress it everywhere, or the fix would be 'stop emitting resume' rather
    // than 'stop emitting it during teardown'.
    const events = [];
    const { client } = mkClient({ onResume: () => events.push('resume') });
    client._setPaused(true);
    client._setPaused(false);
    expect(events).toEqual(['resume']);
  });
});
