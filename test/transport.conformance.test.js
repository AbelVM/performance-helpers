import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';
import { PowerWebTransportClient } from '../src/helpers/powerWebTransportClient.js';
import { decodeMessage, encodeMessage } from '../src/helpers/powerMessageCodec.js';

class FakeWebSocket {
  static instances = [];

  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(frame) {
    this.sent.push(frame);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.fire('close', { code, reason });
  }

  fire(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ type, data });
  }

  open() {
    this.readyState = 1;
    this.fire('open');
  }
}

function makeWebTransport() {
  let readableController;
  let resolveClosed;
  const writes = [];
  const transport = {
    ready: Promise.resolve(),
    closed: new Promise((resolve) => {
      resolveClosed = resolve;
    }),
    createBidirectionalStream() {
      const readable = new ReadableStream({
        start(controller) {
          readableController = controller;
        },
      });
      const writable = new WritableStream({
        write(chunk) {
          writes.push(chunk);
        },
      });
      return { readable, writable };
    },
    close() {
      readableController?.close();
      resolveClosed();
    },
    emit(value) {
      readableController.enqueue(encodeMessage(value));
    },
    writes,
  };
  return transport;
}

async function assertLifecycle(name, createClient) {
  it(`${name} connects, sends, receives, and closes`, async () => {
    const messages = [];
    const closes = [];
    const harness = createClient(
      (message) => messages.push(message),
      (...args) => closes.push(args)
    );

    const connecting = harness.client.connect();
    harness.open?.();
    await connecting;
    expect(harness.client.isOpen).toBe(true);

    harness.emitInbound();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([{ inbound: true }]);

    expect(await harness.client.send({ outbound: true })).toBe(true);
    expect(decodeMessage(harness.readOutbound()).value).toEqual({ outbound: true });

    harness.close();
    expect(harness.client.isOpen).toBe(false);
    expect(closes.length).toBeGreaterThan(0);
  });
}

describe('RT-004 transport conformance', () => {
  assertLifecycle('WebSocket', (onMessage, onClose) => {
    FakeWebSocket.instances.length = 0;
    const client = new PowerWebSocketClient({
      url: 'wss://example.test',
      WebSocketImpl: FakeWebSocket,
      heartbeatIntervalMs: 0,
      onMessage,
      onClose,
      autoReconnect: false,
    });
    return {
      client,
      open: () => FakeWebSocket.instances[0].open(),
      emitInbound: () =>
        FakeWebSocket.instances[0].fire('message', encodeMessage({ inbound: true })),
      readOutbound: () => FakeWebSocket.instances[0].sent[0],
      close: () => FakeWebSocket.instances[0].close(),
    };
  });

  assertLifecycle('WebTransport', (onMessage, onClose) => {
    const transport = makeWebTransport();
    const client = new PowerWebTransportClient({
      url: 'https://example.test',
      WebTransportImpl: class {
        constructor() {
          return transport;
        }
      },
      heartbeatIntervalMs: 0,
      connectTimeoutMs: 0,
      onMessage,
      onClose,
      autoReconnect: false,
    });
    return {
      client,
      emitInbound: () => transport.emit({ inbound: true }),
      readOutbound: () => transport.writes[0],
      close: () => client.close(),
    };
  });
});
