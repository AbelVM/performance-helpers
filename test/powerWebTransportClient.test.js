import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PowerWebTransportClient, READY_STATE } from '../src/helpers/powerWebTransportClient.js';
import { decodeMessage, encodeMessage } from '../src/helpers/powerMessageCodec.js';

/**
 * RT-002 — `PowerWebTransportClient` mirrors the `PowerWebSocketClient` public
 * API over WebTransport streams.
 */
describe('RT-002: PowerWebTransportClient', () => {
  /** @type {PowerWebTransportClient} */
  let client;

  function fakeWebTransport(overrides = {}) {
    const listeners = /** @type {Record<string, Function[]>} */ ({});
    let _closedResolve = () => {};
    const closedPromise = new Promise((r) => {
      _closedResolve = r;
    });
    return {
      ready: Promise.resolve(),
      closed: closedPromise,
      closeCode: undefined,
      closeReason: undefined,
      createBidirectionalStream() {
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array());
          },
        });
        const writable = new WritableStream({
          write() {
            // ignore
          },
        });
        return { readable, writable };
      },
      close() {
        _closedResolve();
      },
      ...overrides,
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
      _fire(type, ...args) {
        for (const fn of listeners[type] || []) fn(...args);
      },
    };
  }

  function streamWithChunks(chunks) {
    const readable = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const writable = new WritableStream({ write() {} });
    return { readable, writable };
  }

  function controlledStream(onWrite) {
    let controller;
    const writes = [];
    const readable = new ReadableStream({
      start(nextController) {
        controller = nextController;
      },
    });
    const writable = new WritableStream({
      write(chunk) {
        writes.push(chunk);
        onWrite?.(chunk, controller);
      },
    });
    return { readable, writable, writes, fail: () => controller.error(new Error('stream-dead')) };
  }

  function concatBytes(...chunks) {
    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  beforeEach(() => {
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: fakeWebTransport,
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });
  });

  afterEach(() => {
    if (client.readyState !== READY_STATE.CLOSED) {
      client.close();
    }
  });

  it('connects and reaches OPEN', async () => {
    await client.connect();
    expect(client.readyState).toBe(READY_STATE.OPEN);
    expect(client.isOpen).toBe(true);
  });

  it('waits for the promise-returning bidirectional stream', async () => {
    const transport = fakeWebTransport();
    const createStream = transport.createBidirectionalStream.bind(transport);
    let resolveStream;
    transport.createBidirectionalStream = () =>
      new Promise((resolve) => {
        resolveStream = resolve;
      });
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return transport;
        }
      },
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });

    const connecting = client.connect();
    await Promise.resolve();
    expect(client.readyState).toBe(READY_STATE.CONNECTING);

    resolveStream(createStream());
    await connecting;
    expect(client.readyState).toBe(READY_STATE.OPEN);
  });

  it('delivers split and multi-frame JSON values once', async () => {
    const first = encodeMessage({ id: 1 });
    const second = encodeMessage({ id: 2 });
    const messages = [];
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return fakeWebTransport({
            createBidirectionalStream: () =>
              Promise.resolve(
                streamWithChunks([first.slice(0, 2), concatBytes(first.slice(2), second)])
              ),
          });
        }
      },
      onMessage: (value) => messages.push(value),
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages).toEqual([{ id: 1 }, { id: 2 }]);
    expect(client.stats().received).toBe(2);
  });

  it('delivers raw frame values without decoding them again', async () => {
    const messages = [];
    const payload = new Uint8Array([4, 5, 6]);
    const frame = encodeMessage(payload, { codec: 'raw' });
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      codec: 'raw',
      WebTransportImpl: class {
        constructor() {
          return fakeWebTransport({
            createBidirectionalStream: () => Promise.resolve(streamWithChunks([frame])),
          });
        }
      },
      onMessage: (value) => messages.push(value),
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(payload);
  });

  it('answers heartbeat pings and records pong RTT without delivering control frames', async () => {
    const messages = [];
    const stream = controlledStream((chunk, controller) => {
      const value = decodeMessage(chunk).value;
      if (value.__heartbeat === 'ping') {
        controller.enqueue(encodeMessage({ __heartbeat: 'pong' }));
      }
    });
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return fakeWebTransport({ createBidirectionalStream: () => stream });
        }
      },
      onMessage: (value) => messages.push(value),
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 30,
      autoReconnect: false,
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(stream.writes.length).toBeGreaterThan(0);
    expect(client.stats().heartbeats).toBeGreaterThan(0);
    expect(client.stats().rtt.count).toBeGreaterThan(0);
    expect(messages).toEqual([]);
    expect(client.stats().heartbeatTimeouts).toBe(0);
  });

  it('closes after an unanswered heartbeat deadline', async () => {
    const stream = controlledStream(() => {});
    const transport = fakeWebTransport({ createBidirectionalStream: () => stream });
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return transport;
        }
      },
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 10,
      autoReconnect: false,
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(client.stats().heartbeatTimeouts).toBeGreaterThanOrEqual(1);
    expect(client.readyState).toBe(READY_STATE.CLOSED);
  });

  it('closes and reconnects after a stream failure', async () => {
    const streams = [];
    const transports = [];
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          const stream = controlledStream(() => {});
          streams.push(stream);
          const transport = fakeWebTransport({ createBidirectionalStream: () => stream });
          transports.push(transport);
          return transport;
        }
      },
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const closes = [];
    client.on('close', (event) => closes.push(event));

    await client.connect();
    streams[0].fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toHaveLength(1);
    expect(client.readyState).toBe(READY_STATE.CLOSED);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transports).toHaveLength(2);
    expect(client.readyState).toBe(READY_STATE.OPEN);
    client.close();
  });

  it.each([
    ['partial header', (frame) => frame.slice(0, 2)],
    ['partial payload', (frame) => frame.slice(0, -1)],
  ])('reports a truncated inbound %s at stream EOF', async (_name, truncate) => {
    const errors = [];
    const frame = encodeMessage({ complete: true });
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return fakeWebTransport({
            createBidirectionalStream: () => streamWithChunks([truncate(frame)]),
          });
        }
      },
      onError: (error) => errors.push(error),
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });

    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
  });

  it('emits open on connect', async () => {
    const opens = [];
    client.on('open', () => opens.push(1));
    await client.connect();
    expect(opens).toHaveLength(1);
  });

  it('sends a frame and counts it', async () => {
    await client.connect();
    const result = await client.sendFrame(new Uint8Array([1, 2, 3]));
    expect(result).toBe(true);
    const stats = client.stats();
    expect(stats.sent).toBe(1);
  });

  it('returns false when sending while closed', async () => {
    const result = await client.sendFrame(new Uint8Array([1]));
    expect(result).toBe(false);
  });

  it('closes and emits close', async () => {
    await client.connect();
    const closes = [];
    client.on('close', () => closes.push(1));
    client.close(1000, 'bye');
    expect(client.readyState).toBe(READY_STATE.CLOSED);
    expect(closes).toHaveLength(1);
  });

  it('supports on/off unsubscribe', async () => {
    const messages = [];
    const unsub = client.on('message', () => messages.push(1));
    unsub();
    await client.connect();
    // unsub before any message; nothing should arrive.
    expect(messages).toHaveLength(0);
  });

  it('reports stats with the expected shape', async () => {
    await client.connect();
    const stats = client.stats();
    expect(stats.readyState).toBe(READY_STATE.OPEN);
    expect(stats.backpressureMode).toBe('streams');
    expect(stats.rtt).toBeDefined();
    expect(stats.rtt.canPing).toBe(false);
  });

  it('getStats is an alias for stats', async () => {
    await client.connect();
    expect(client.getStats()).toStrictEqual(client.stats());
  });

  it('dispose closes the client', async () => {
    await client.connect();
    client.dispose();
    expect(client.readyState).toBe(READY_STATE.CLOSED);
  });

  it('reconnects after an unexpected close', async () => {
    const transport = fakeWebTransport();
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return transport;
        }
      },
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 2,
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
    });

    await client.connect();
    expect(client.readyState).toBe(READY_STATE.OPEN);

    // Simulate transport close without user close.
    transport.close();
    await new Promise((r) => setTimeout(r, 50));

    // Should have attempted reconnection.
    const stats = client.stats();
    expect(stats.reconnects).toBeGreaterThanOrEqual(1);
  });
});
