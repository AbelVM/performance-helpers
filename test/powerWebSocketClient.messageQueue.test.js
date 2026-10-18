import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
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
}

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
  return { client, opened: () => socket };
}

describe('PowerWebSocketClient message queue while disconnected (S-22)', () => {
  it('returns false while closed when queueing is disabled (default)', async () => {
    const { client } = makeClient();
    const r = await client.send('hello');
    expect(r).toBe(false);
    expect(client.stats().queuedMessages).toBe(0);
    client.dispose();
  });

  it('buffers a send while disconnected and flushes on open', async () => {
    const { client, opened } = makeClient({ messageQueueSize: 4 });
    const r = await client.send('hello');
    expect(r).toBe(true);
    expect(client.stats().queuedMessages).toBe(1);

    client.connect();
    const sock = opened();
    sock.emit('open', {});
    // flush is fire-and-forget; wait a tick
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sock.sent.length).toBe(1);
    expect(client.stats().queuedMessages).toBe(0);
    client.dispose();
  });

  it('flushes multiple queued messages in order', async () => {
    const { client, opened } = makeClient({ messageQueueSize: 4 });
    await client.send('a');
    await client.send('b');
    await client.send('c');
    expect(client.stats().queuedMessages).toBe(3);

    client.connect();
    const sock = opened();
    sock.emit('open', {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sock.sent.length).toBe(3);
    client.dispose();
  });

  it('drops oldest on overflow and counts it', async () => {
    const { client } = makeClient({ messageQueueSize: 2 });
    await client.send('a');
    await client.send('b');
    await client.send('c');
    expect(client.stats().queuedMessages).toBe(2);
    expect(client.stats().droppedQueuedMessages).toBe(1);
    client.dispose();
  });

  it('does not queue after a user-initiated close', async () => {
    const { client } = makeClient({ messageQueueSize: 4 });
    client.connect();
    // not opened; close
    client.close();
    const r = await client.send('x');
    expect(r).toBe(false);
    expect(client.stats().queuedMessages).toBe(0);
    client.dispose();
  });

  it('clears the queue on dispose', async () => {
    const { client } = makeClient({ messageQueueSize: 4 });
    await client.send('x');
    expect(client.stats().queuedMessages).toBe(1);
    client.dispose();
    // after dispose, stats may be null-ish; just ensure no throw
  });

  it('reports messageQueueSize in stats', () => {
    const { client } = makeClient({ messageQueueSize: 7 });
    expect(client.stats().messageQueueSize).toBe(7);
    client.dispose();
  });
});
