import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  PowerSocketAdapter,
  detectSocketKind,
  READY_STATE,
} from '../src/helpers/powerSocketAdapter.js';

/**
 * FEAT-005: `PowerSocketAdapter` normalises Node `ws` (EventEmitter), browser
 * `WebSocket` (EventTarget) and `WebSocketStream` (streams) behind one
 * interface, and adds liveness, per-message rate limiting and a graceful drain.
 *
 * The three fake sockets below are the substance of the item: they are the
 * models that are genuinely incompatible, so a test that only exercises one
 * proves nothing about normalisation. The assertions that matter are the ones
 * a naive wrapper gets wrong:
 *
 *  - a `ws` `message` handler gets `(data, isBinary)` and an `EventTarget` one
 *    gets an event object - so a shared handler must not care which;
 *  - `dispose()` must actually detach, or a server leaks one adapter per
 *    connection for the life of the process;
 *  - `drain()` must let in-flight work finish, and must be bounded.
 */

/** A Node `ws` socket: EventEmitter, `(data, isBinary)`, has `ping`/`terminate`. */
class FakeWsSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = READY_STATE.OPEN;
    this.bufferedAmount = 0;
    this.pings = 0;
    this.closed = null;
    this.throwOnSend = false;
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return this;
  }
  off(event, fn) {
    const list = this.listeners.get(event);
    if (list)
      this.listeners.set(
        event,
        list.filter((f) => f !== fn)
      );
    return this;
  }
  emit(event, ...args) {
    for (const fn of this.listeners.get(event) || []) fn(...args);
  }
  listenerCount(event) {
    return (this.listeners.get(event) || []).length;
  }
  totalListeners() {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
  send(data) {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(data);
  }
  ping() {
    this.pings += 1;
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = READY_STATE.CLOSED;
    this.emit('close', code, Buffer.from(reason || ''));
  }
}

/** A browser `WebSocket`: EventTarget, `event.data`, no `ping`. */
class FakeBrowserSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = READY_STATE.OPEN;
    this.bufferedAmount = 0;
    this.closed = null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list)
      this.listeners.set(
        type,
        list.filter((f) => f !== fn)
      );
  }
  dispatch(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }
  totalListeners() {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = READY_STATE.CLOSED;
    this.dispatch('close', { code, reason });
  }
}

/** A `WebSocketStream`: `opened` promise, readable/writable, no readyState. */
class FakeWebSocketStream {
  constructor() {
    this.readable = {
      getReader: () => ({
        read: () => this._nextRead(),
        cancel: () => {
          this.cancelled = true;
          return Promise.resolve();
        },
      }),
    };
    // Models the real lock semantics: `getWriter()` locks the stream and only
    // `releaseLock()` unlocks it, so taking a writer per `send()` makes the
    // second send throw. A fake that returns a fresh writer every time would
    // hide exactly the defect this exists to catch.
    this.locked = false;
    this.writable = {
      getWriter: () => {
        if (this.locked) throw new TypeError('WritableStream is locked');
        this.locked = true;
        return {
          desiredSize: 1,
          write: (chunk) => {
            this.written = (this.written || []).concat([chunk]);
            return Promise.resolve();
          },
          releaseLock: () => {
            this.locked = false;
            this.released = true;
          },
        };
      },
    };
    this.closed = null;
    this.cancelled = false;
    this.released = false;
    this._queue = [];
    this._done = false;
    this._pending = [];
  }
  push(value) {
    this._queue.push({ value, done: false });
    this._flush();
  }
  end() {
    this._queue.push({ value: undefined, done: true });
    this._flush();
  }
  _flush() {
    while (this._queue.length && this._pending.length) {
      this._pending.shift()(this._queue.shift());
    }
  }
  _nextRead() {
    if (this._queue.length) return Promise.resolve(this._queue.shift());
    if (this._done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this._pending.push(resolve));
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
}

describe('detectSocketKind', () => {
  it('detects each transport by capability, not by name', () => {
    expect(detectSocketKind(new FakeWsSocket())).toBe('ws');
    expect(detectSocketKind(new FakeBrowserSocket())).toBe('websocket');
    expect(detectSocketKind(new FakeWebSocketStream())).toBe('stream');
  });

  it('rejects an object it cannot identify rather than defaulting', () => {
    // A silent default would attach no listeners at all, so the adapter would
    // look healthy and receive nothing - the worst possible failure.
    expect(() => detectSocketKind({})).toThrow('cannot detect the socket model');
    expect(() => detectSocketKind(null)).toThrow('must be an object');
    expect(() => detectSocketKind('ws://x')).toThrow('must be an object');
  });

  it('checks the stream before the emitter, since a stream is otherwise unremarkable', () => {
    // A WebSocketStream exposes readable/writable but neither `on` nor
    // `addEventListener`. Tested in the other order it would be a socket whose
    // message pump silently never starts.
    const stream = new FakeWebSocketStream();
    expect(stream.on).toBeUndefined();
    expect(stream.addEventListener).toBeUndefined();
    expect(detectSocketKind(stream)).toBe('stream');
  });
});

describe('PowerSocketAdapter normalisation', () => {
  it('delivers the same message shape from a ws socket and a browser socket', async () => {
    // The load-bearing assertion. `ws` calls the handler with `(data, isBinary)`
    // and an EventTarget with one event object; a consumer must not care.
    const wsSeen = [];
    const ws = new FakeWsSocket();
    const wsAdapter = new PowerSocketAdapter(ws, { onMessage: (m) => wsSeen.push(m) });
    ws.emit('message', 'hello', false);
    ws.emit('message', Buffer.from([1, 2, 3]), true);

    const browserSeen = [];
    const browser = new FakeBrowserSocket();
    const browserAdapter = new PowerSocketAdapter(browser, {
      onMessage: (m) => browserSeen.push(m),
    });
    browser.dispatch('message', { data: 'hello' });
    browser.dispatch('message', { data: new ArrayBuffer(3) });

    expect(wsSeen.map((m) => [m.data, m.isBinary])).toEqual([
      ['hello', false],
      [Buffer.from([1, 2, 3]), true],
    ]);
    expect(browserSeen.map((m) => [m.data, m.isBinary])).toEqual([
      ['hello', false],
      [new ArrayBuffer(3), false],
    ]);
    // Both carry the adapter, so a handler can reply without a closure.
    expect(wsSeen[0].adapter).toBe(wsAdapter);
    expect(browserSeen[0].adapter).toBe(browserAdapter);

    wsAdapter.dispose();
    browserAdapter.dispose();
  });

  it('pumps a WebSocketStream through the same handler', async () => {
    const seen = [];
    const stream = new FakeWebSocketStream();
    const adapter = new PowerSocketAdapter(stream, { onMessage: (m) => seen.push(m) });
    stream.push('a');
    stream.push(new ArrayBuffer(2));
    await vi.waitFor(() => {
      expect(seen.map((m) => m.data)).toEqual(['a', new ArrayBuffer(2)]);
    });
    // A stream carries no frame type, so `isBinary` is inferred from the value.
    expect(seen[0].isBinary).toBe(false);
    expect(seen[1].isBinary).toBe(true);
    adapter.dispose();
  });

  it('reports CLOSED when a stream ends', async () => {
    const stream = new FakeWebSocketStream();
    const onClose = vi.fn();
    const adapter = new PowerSocketAdapter(stream, { onClose });
    expect(adapter.readyState).toBe(READY_STATE.OPEN);
    stream.end();
    await vi.waitFor(() => {
      expect(adapter.readyState).toBe(READY_STATE.CLOSED);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    adapter.dispose();
  });

  it('sends through all three models', () => {
    const ws = new FakeWsSocket();
    const browser = new FakeBrowserSocket();
    const stream = new FakeWebSocketStream();
    const a = new PowerSocketAdapter(ws, {});
    const b = new PowerSocketAdapter(browser, {});
    const c = new PowerSocketAdapter(stream, {});
    expect(a.send('x')).toBe(true);
    expect(b.send('x')).toBe(true);
    expect(c.send('x')).toBe(true);
    expect(ws.sent).toEqual(['x']);
    expect(browser.sent).toEqual(['x']);
    expect(stream.written).toEqual(['x']);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('can send to a stream more than once, and releases the lock on dispose', () => {
    // `getWriter()` locks the stream permanently until `releaseLock()`. Taking
    // one per `send()` means the second send throws, and the stream is never
    // usable again - including by whatever else holds a reference to it.
    const stream = new FakeWebSocketStream();
    const adapter = new PowerSocketAdapter(stream, {});
    expect(adapter.send('a')).toBe(true);
    expect(adapter.send('b')).toBe(true);
    expect(adapter.send('c')).toBe(true);
    expect(stream.written).toEqual(['a', 'b', 'c']);
    expect(stream.locked).toBe(true);
    adapter.dispose();
    expect(stream.released).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it('waits for a stream write to settle before draining', async () => {
    // An un-awaited `write()` that rejects later is an unhandled rejection, and
    // a drain that returned early would close the stream mid-write.
    let releaseWrite;
    const stream = new FakeWebSocketStream();
    stream.writable.getWriter = () => ({
      desiredSize: 1,
      write: () =>
        new Promise((r) => {
          releaseWrite = r;
        }),
      releaseLock: () => {},
    });
    const adapter = new PowerSocketAdapter(stream, { drainTimeoutMs: 5000 });
    expect(adapter.send('x')).toBe(true);
    expect(adapter.stats().pending).toBe(1);
    const drained = adapter.drain();
    releaseWrite();
    await expect(drained).resolves.toBe(true);
    adapter.dispose();
  });

  it('reports bufferedAmount 0 for a stream rather than NaN', () => {
    // A watermark loop reading NaN would never pause, so the adapter would look
    // like it had backpressure handling while having none.
    const stream = new FakeWebSocketStream();
    const adapter = new PowerSocketAdapter(stream, {});
    expect(adapter.bufferedAmount).toBe(0);
    const ws = new FakeWsSocket();
    ws.bufferedAmount = 1234;
    const wsAdapter = new PowerSocketAdapter(ws, {});
    expect(wsAdapter.bufferedAmount).toBe(1234);
    adapter.dispose();
    wsAdapter.dispose();
  });

  it('refuses to send when closed, draining, or disposed, without throwing', () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {});
    adapter.close();
    expect(adapter.send('x')).toBe(false);
    expect(ws.sent).toEqual([]);
    adapter.dispose();
    expect(adapter.send('x')).toBe(false);
  });

  it('routes a send failure to onError and counts it', () => {
    const ws = new FakeWsSocket();
    ws.throwOnSend = true;
    const onError = vi.fn();
    const adapter = new PowerSocketAdapter(ws, { onError });
    expect(adapter.send('x')).toBe(false);
    expect(onError).toHaveBeenCalled();
    expect(adapter.stats().sendFailures).toBe(1);
    adapter.dispose();
  });
});

describe('PowerSocketAdapter dispose', () => {
  it('detaches every listener it attached', () => {
    // Without this a server leaks one adapter per connection: the socket
    // outlives the adapter and keeps its closures alive.
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {});
    expect(ws.totalListeners()).toBeGreaterThan(0);
    adapter.dispose();
    expect(ws.totalListeners()).toBe(0);

    const browser = new FakeBrowserSocket();
    const browserAdapter = new PowerSocketAdapter(browser, {});
    expect(browser.totalListeners()).toBeGreaterThan(0);
    browserAdapter.dispose();
    expect(browser.totalListeners()).toBe(0);
  });

  it('stops delivering messages after dispose', () => {
    const onMessage = vi.fn();
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { onMessage });
    adapter.dispose();
    ws.emit('message', 'after', false);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('is idempotent and supports a scope-exit dispose', () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {});
    adapter.dispose();
    expect(() => adapter.dispose()).not.toThrow();
    expect(adapter[Symbol.dispose]).toBeInstanceOf(Function);
    expect(() => {
      const scoped = new PowerSocketAdapter(new FakeWsSocket(), {});
      try {
        expect(scoped).toBeInstanceOf(PowerSocketAdapter);
      } finally {
        scoped.dispose();
      }
    }).not.toThrow();
  });

  it('cancels a stream reader', async () => {
    const stream = new FakeWebSocketStream();
    const adapter = new PowerSocketAdapter(stream, {});
    // Real wait, deliberately: this asserts the reader was *cancelled*, and
    // `vi.waitFor` cannot express a negative — its condition is already true
    // before it starts.
    await new Promise((r) => setTimeout(r, 0));
    adapter.dispose();
    expect(stream.cancelled).toBe(true);
  });

  it('cancels the heartbeat timer', () => {
    vi.useFakeTimers();
    try {
      const ws = new FakeWsSocket();
      const adapter = new PowerSocketAdapter(ws, { heartbeatIntervalMs: 1000 });
      vi.advanceTimersByTime(5000);
      expect(ws.pings).toBeGreaterThan(0);
      const before = ws.pings;
      adapter.dispose();
      vi.advanceTimersByTime(10_000);
      // No further pings after disposal, or the adapter is still holding the
      // process open.
      expect(ws.pings).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PowerSocketAdapter liveness', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pings on the interval and clears the deadline on a pong', () => {
    const ws = new FakeWsSocket();
    const onClose = vi.fn();
    const adapter = new PowerSocketAdapter(ws, {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 500,
      onClose,
    });
    vi.advanceTimersByTime(1000);
    expect(ws.pings).toBe(1);
    // Answer it with a `pong` - the event `ws` emits for an inbound pong, and
    // the mirror image of the `ping` a server *receives* from its clients.
    ws.emit('pong');
    // Advance past the 500ms deadline but not as far as the next 1000ms ping.
    // If the pong had not cleared the deadline, this would close the socket.
    vi.advanceTimersByTime(400);
    expect(onClose).not.toHaveBeenCalled();
    expect(adapter.readyState).toBe(READY_STATE.OPEN);
    adapter.dispose();
  });

  it('declares the socket dead when a ping goes unanswered', () => {
    // The failure this exists for: a socket stuck in OPEN with nothing getting
    // through, which is the normal state behind a dead load balancer.
    const ws = new FakeWsSocket();
    const onClose = vi.fn();
    const adapter = new PowerSocketAdapter(ws, {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 500,
      onClose,
    });
    vi.advanceTimersByTime(1000);
    expect(ws.pings).toBe(1);
    vi.advanceTimersByTime(500);
    expect(adapter.readyState).toBe(READY_STATE.CLOSED);
    expect(ws.closed.code).toBe(4000);
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ code: 4000, reason: 'heartbeat timeout' })
    );
    expect(adapter.stats().heartbeatTimeouts).toBe(1);
    adapter.dispose();
  });

  it('does not pretend to heartbeat on a transport with no ping()', () => {
    // The browser deliberately does not expose ping. An adapter that "sends" a
    // ping there would report healthy forever.
    const browser = new FakeBrowserSocket();
    const adapter = new PowerSocketAdapter(browser, { heartbeatIntervalMs: 1000 });
    expect(adapter.canPing).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(adapter.readyState).toBe(READY_STATE.OPEN);
    expect(adapter.stats().heartbeatTimeouts).toBe(0);
    expect(adapter.stats().canPing).toBe(false);
    adapter.dispose();
  });

  it('closes an idle socket when idleTimeoutMs is set', () => {
    const ws = new FakeWsSocket();
    const onClose = vi.fn();
    const adapter = new PowerSocketAdapter(ws, {
      heartbeatIntervalMs: 0,
      idleTimeoutMs: 2000,
      onClose,
    });
    vi.advanceTimersByTime(1999);
    expect(adapter.readyState).toBe(READY_STATE.OPEN);
    vi.advanceTimersByTime(2);
    expect(adapter.readyState).toBe(READY_STATE.CLOSED);
    expect(adapter.stats().idleTimeouts).toBe(1);
    adapter.dispose();
  });

  it('activity resets the idle timer', () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { heartbeatIntervalMs: 0, idleTimeoutMs: 1000 });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(800);
      ws.emit('message', 'x', false);
    }
    expect(adapter.readyState).toBe(READY_STATE.OPEN);
    adapter.dispose();
  });
});

describe('PowerSocketAdapter rate limiting', () => {
  it('drops messages past the limit and reports the count', () => {
    const onMessage = vi.fn();
    const onRateLimited = vi.fn();
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {
      onMessage,
      onRateLimited,
      rateLimit: { limit: 3, windowMs: 1000 },
    });
    for (let i = 0; i < 10; i++) ws.emit('message', `m${i}`, false);
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onRateLimited).toHaveBeenCalledTimes(7);
    expect(adapter.stats().rateLimited).toBe(7);
    adapter.dispose();
  });

  it('closes the socket instead when the action is `close`', () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {
      onMessage: () => {},
      rateLimit: { limit: 1, windowMs: 1000 },
      rateLimitAction: 'close',
    });
    ws.emit('message', 'a', false);
    ws.emit('message', 'b', false);
    expect(ws.closed.code).toBe(1008);
    expect(adapter.readyState).toBe(READY_STATE.CLOSED);
    adapter.dispose();
  });

  it('lets messages through again in a later window', () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn();
      const ws = new FakeWsSocket();
      const adapter = new PowerSocketAdapter(ws, {
        onMessage,
        rateLimit: { limit: 2, windowMs: 1000 },
      });
      ws.emit('message', 'a', false);
      ws.emit('message', 'b', false);
      ws.emit('message', 'c', false);
      expect(onMessage).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1500);
      ws.emit('message', 'd', false);
      expect(onMessage).toHaveBeenCalledTimes(3);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rate limit when none is configured', () => {
    const onMessage = vi.fn();
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { onMessage });
    for (let i = 0; i < 500; i++) ws.emit('message', `m${i}`, false);
    expect(onMessage).toHaveBeenCalledTimes(500);
    adapter.dispose();
  });
});

describe('PowerSocketAdapter drain', () => {
  it('waits for an in-flight async handler before closing', async () => {
    // The point of a drain: a deploy that closes immediately drops work that
    // was about to finish.
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { onMessage: () => gate });
    ws.emit('message', 'work', false);
    expect(adapter.stats().pending).toBe(1);

    const drained = adapter.drain();
    expect(adapter.isDraining).toBe(true);
    expect(adapter.isOpen).toBe(false);
    // Still open: the handler has not finished.
    expect(ws.closed).toBeNull();

    release();
    await expect(drained).resolves.toBe(true);
    expect(ws.closed).not.toBeNull();
    adapter.dispose();
  });

  it('refuses new messages and sends while draining', async () => {
    const seen = [];
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { onMessage: (m) => seen.push(m.data) });
    const drained = adapter.drain();
    expect(adapter.send('x')).toBe(false);
    ws.emit('message', 'ignored', false);
    expect(seen).toEqual([]);
    await drained;
    // Counted, so the number tells you whether the timeout was generous enough.
    expect(adapter.stats().drainedFromDrain).toBe(1);
    adapter.dispose();
  });

  it('closes anyway when a handler overruns drainTimeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const ws = new FakeWsSocket();
      const adapter = new PowerSocketAdapter(ws, {
        onMessage: () => new Promise(() => {}), // never settles
        drainTimeoutMs: 1000,
      });
      ws.emit('message', 'stuck', false);
      const drained = adapter.drain();
      vi.advanceTimersByTime(1001);
      // Resolves false, not true: pretending the drain finished cleanly is how
      // a deploy silently drops work.
      await expect(drained).resolves.toBe(false);
      expect(ws.closed).not.toBeNull();
      expect(adapter.stats().drainTimeouts).toBe(1);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the same promise when drained twice', async () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {});
    const a = adapter.drain();
    const b = adapter.drain();
    expect(a).toBe(b);
    await a;
    adapter.dispose();
  });

  it('does not wait for a handler that is not async', async () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { onMessage: () => 'sync' });
    ws.emit('message', 'x', false);
    await expect(adapter.drain()).resolves.toBe(true);
    adapter.dispose();
  });

  it('resolves pending handlers on close so a drain cannot hang', async () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {
      onMessage: () => new Promise(() => {}),
      drainTimeoutMs: 0, // wait forever
    });
    ws.emit('message', 'stuck', false);
    const drained = adapter.drain();
    adapter.close();
    // `close` settles waiters rather than leaving the promise pending forever.
    await expect(drained).resolves.toBe(false);
    adapter.dispose();
  });
});

describe('PowerSocketAdapter error handling', () => {
  it('routes a throwing handler to onError without killing the socket', () => {
    const onError = vi.fn();
    const onMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('handler blew up');
      })
      .mockImplementationOnce(() => 'ok');
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { onMessage, onError });
    ws.emit('message', 'a', false);
    ws.emit('message', 'b', false);
    expect(onError).toHaveBeenCalledTimes(1);
    // The next message still gets through: one bad frame is not a dead socket.
    expect(adapter.readyState).toBe(READY_STATE.OPEN);
    adapter.dispose();
  });

  it('releases a pending count when a handler rejects', async () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {
      onMessage: () => Promise.reject(new Error('async boom')),
      drainTimeoutMs: 1000,
    });
    ws.emit('message', 'x', false);
    await vi.waitFor(() => {
      // Otherwise the drain would wait out its full timeout for work that is
      // already finished - and then report a timeout that did not happen.
      expect(adapter.stats().pending).toBe(0);
    });
    await expect(adapter.drain()).resolves.toBe(true);
    adapter.dispose();
  });

  it('survives a throwing onError', () => {
    const ws = new FakeWsSocket();
    ws.throwOnSend = true;
    const adapter = new PowerSocketAdapter(ws, {
      onError: () => {
        throw new Error('error handler also broke');
      },
    });
    expect(() => adapter.send('x')).not.toThrow();
    adapter.dispose();
  });

  it('validates its numeric options', () => {
    const ws = new FakeWsSocket();
    expect(() => new PowerSocketAdapter(ws, { heartbeatIntervalMs: -1 })).toThrow('must be >= 0');
    expect(() => new PowerSocketAdapter(ws, { drainTimeoutMs: Number.NaN })).toThrow(
      'finite number'
    );
    expect(() => new PowerSocketAdapter(ws, { rateLimit: { limit: 0, windowMs: 1000 } })).toThrow(
      'must be >= 1'
    );
  });
});

describe('PowerSocketAdapter stats', () => {
  it('reports the transport and the liveness mode actually in use', () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, {});
    const s = adapter.stats();
    expect(s.kind).toBe('ws');
    expect(s.canPing).toBe(true);
    expect(s.messages).toBe(0);
    adapter.dispose();

    const browser = new FakeBrowserSocket();
    const b = new PowerSocketAdapter(browser, {});
    expect(b.stats().kind).toBe('websocket');
    expect(b.stats().canPing).toBe(false);
    b.dispose();
  });
});

/**
 * The drain invariant, over random interleavings.
 *
 * Hand-written sequences test the cases I thought of. These test the ones I did
 * not: an async handler that resolves, one that rejects, a close, and a dispose
 * racing each other. The property that has to hold regardless is that `pending`
 * returns to zero and `drain()` always settles - a drain that never settles is
 * a deploy that never finishes, and neither shows up in a fixed sequence unless
 * you happened to write that one.
 */
describe('PowerSocketAdapter drain invariants', () => {
  it('always returns pending to zero and settles drain, whatever the interleaving', async () => {
    // `fc.asyncProperty`, not `fc.property`: `fc.assert` does not await an async
    // predicate, so a rejection inside one escapes the assertion and surfaces
    // as an unhandled rejection instead of a failure - which is what made the
    // empty plan look like an adapter bug.
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            delay: fc.integer({ min: 0, max: 5 }),
            outcome: fc.constantFrom('resolve', 'reject'),
          }),
          { minLength: 0, maxLength: 12 }
        ),
        async (plan) => {
          const ws = new FakeWsSocket();
          const adapter = new PowerSocketAdapter(ws, {
            onMessage: (msg) =>
              new Promise((resolve, reject) => {
                const step = plan[Number(msg.data)];
                setTimeout(() => {
                  if (step.outcome === 'reject') reject(new Error('x'));
                  else resolve('ok');
                }, step.delay);
              }),
            drainTimeoutMs: 5_000,
          });
          for (let i = 0; i < plan.length; i++) ws.emit('message', String(i), false);

          const ok = await adapter.drain();
          expect(adapter.stats().pending).toBe(0);
          expect(typeof ok).toBe('boolean');
          // Every message is accounted for exactly once: delivered, refused,
          // or dropped by the drain.
          const s = adapter.stats();
          expect(s.handled + s.rateLimited + s.drainedFromDrain).toBe(s.messages);
          adapter.dispose();
        }
      ),
      { numRuns: 60 }
    );
  });

  it('never delivers more messages than the rate limit allows in a window', () => {
    // **The clock is frozen, and that is a correction rather than tidying.**
    //
    // This test's premise was "every message in the same tick, so the window
    // cannot have rolled over". It is false: `ws.emit()` in a loop is
    // synchronous, but the limiter reads `nowMs()` on every call, and a
    // millisecond boundary can fall between two iterations of a loop that is
    // doing real work — most reliably when 272 test files are running in
    // parallel and the process is descheduled. With `windowMs` as low as 1 that
    // is enough for the window to roll and admit one extra message, so the test
    // failed roughly once per full-suite run, on real code that was correct.
    //
    // The failure was `expected 3 to be less than or equal to 2` inside this
    // file, on a property I had not touched. It is recorded here because a test
    // that fails intermittently for a reason unrelated to its subject is worse
    // than one that never fails: the next person to see it blames whatever they
    // changed. Note also that `PowerSocketAdapter` builds its `PowerSlidingWindow`
    // internally with no `now` passthrough, so freezing is the only lever a test
    // has — the alternative was deleting the case, which throws away a real
    // property.
    vi.useFakeTimers();
    try {
      fc.assert(
        fc.property(
          fc.record({
            limit: fc.integer({ min: 1, max: 8 }),
            windowMs: fc.integer({ min: 1, max: 50 }),
            messages: fc.array(fc.boolean(), { minLength: 0, maxLength: 40 }),
          }),
          ({ limit, windowMs, messages }) => {
            const ws = new FakeWsSocket();
            const adapter = new PowerSocketAdapter(ws, {
              onMessage: () => {},
              rateLimit: { limit, windowMs },
            });
            // Every message at one instant, which is now **actually** true
            // rather than approximately true: the clock cannot advance, so the
            // window provably cannot roll over and the delivered count must not
            // exceed the limit. `messages` counts every frame that arrived,
            // refused ones included, so it is the wrong thing to assert against.
            for (let i = 0; i < messages.length; i++) ws.emit('message', String(i), false);
            const s = adapter.stats();
            expect(s.messages).toBe(messages.length);
            expect(s.handled + s.rateLimited).toBe(messages.length);
            expect(s.handled).toBeLessThanOrEqual(limit);
            adapter.dispose();
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      // `finally`, not a trailing call: an assertion failure inside `fc.assert`
      // leaves the clock frozen for every later test in the file, which is the
      // same class of leak the `Date.now` stubbing cleanup in
      // `typed-options-and-lint` was about.
      vi.useRealTimers();
    }
  });
});
