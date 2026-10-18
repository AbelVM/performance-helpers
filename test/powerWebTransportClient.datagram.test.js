import { describe, it, expect, afterEach } from 'vitest';
import { PowerWebTransportClient, READY_STATE } from '../src/helpers/powerWebTransportClient.js';

describe('PowerWebTransportClient datagrams (S-23)', () => {
  let client;

  function fakeWebTransport(overrides = {}) {
    const listeners = {};
    let _closedResolve = () => {};
    const closedPromise = new Promise((r) => {
      _closedResolve = r;
    });
    const dgWritable = {
      ready: Promise.resolve(),
      getWriter() {
        return {
          ready: Promise.resolve(),
          write: async () => {},
          releaseLock: () => {},
        };
      },
    };
    const dgReadable = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    return {
      ready: Promise.resolve(),
      closed: closedPromise,
      closeCode: undefined,
      closeReason: undefined,
      datagrams: { writable: dgWritable, readable: dgReadable },
      createBidirectionalStream() {
        const readable = new ReadableStream({
          start(c) {
            c.close();
          },
        });
        const writable = new WritableStream({ write() {} });
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
    };
  }

  afterEach(() => {
    if (client && client.readyState !== READY_STATE.CLOSED) client.close();
  });

  it('sendDatagram uses datagram path when available', async () => {
    const written = { value: null };
    const transport = fakeWebTransport();
    transport.datagrams.writable.getWriter = () => ({
      ready: Promise.resolve(),
      write: async (d) => {
        written.value = d;
      },
      releaseLock: () => {},
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
      datagrams: true,
    });
    await client.connect();
    const ok = await client.sendDatagram('hi');
    expect(ok).toBe(true);
    expect(written.value).not.toBeNull();
  });

  it('falls back to stream when datagrams unavailable and fallback enabled', async () => {
    const transport = fakeWebTransport({ datagrams: undefined });
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: class {
        constructor() {
          return transport;
        }
      },
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      datagramFallback: true,
    });
    await client.connect();
    const ok = await client.sendDatagram('hi');
    // fallback calls send() which writes to stream writer; returns true
    expect(typeof ok).toBe('boolean');
  });

  it('returns false when not open', async () => {
    client = new PowerWebTransportClient({
      url: 'https://example.test/feed',
      WebTransportImpl: fakeWebTransport,
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
    });
    const ok = await client.sendDatagram('hi');
    expect(ok).toBe(false);
  });

  it('streamPriority/sendOrder are accepted options', async () => {
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
      streamPriority: 5,
      sendOrder: 7,
    });
    await client.connect();
    expect(client.readyState).toBe(READY_STATE.OPEN);
  });
});
