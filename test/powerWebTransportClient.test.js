import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PowerWebTransportClient, READY_STATE } from '../src/helpers/powerWebTransportClient.js';

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
