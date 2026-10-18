import { describe, it, expect } from 'vitest';
import { PowerDatagramChannel } from '../src/helpers/powerDatagramChannel.js';

class FakeTransport {
  constructor() {
    this.sent = [];
    this._closed = false;
  }
  send(data) {
    if (this._closed) throw new Error('transport is closed');
    this.sent.push(data);
  }
  close() {
    this._closed = true;
  }
}

describe('PowerDatagramChannel fragmentation', () => {
  it('fragments a datagram larger than fragmentSize', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport, { fragmentSize: 4 });

    const data = new Uint8Array(10);
    for (let i = 0; i < 10; i++) data[i] = i;
    const result = channel.send(data);

    expect(result).toBe(true);
    // 10 bytes / 4 = 3 chunks (4,4,2)
    expect(transport.sent).toHaveLength(3);
    const stats = channel.stats();
    expect(stats.fragmentedDatagrams).toBe(1);
    expect(stats.fragmentsSent).toBe(3);
  });

  it('fragments an oversize datagram when fragmentSize set', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport, {
      maxDatagramSizeBytes: 4,
      fragmentSize: 2,
    });

    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const result = channel.send(data);
    expect(result).toBe(true);
    expect(transport.sent.length).toBeGreaterThan(1);
    const stats = channel.stats();
    expect(stats.fragmentedDatagrams).toBe(1);
  });

  it('returns false when transport throws mid-fragment', () => {
    const transport = new FakeTransport();
    let calls = 0;
    const origSend = transport.send.bind(transport);
    transport.send = (d) => {
      calls++;
      if (calls === 2) throw new Error('boom');
      origSend(d);
    };
    const channel = new PowerDatagramChannel(transport, { fragmentSize: 2 });
    const data = new Uint8Array(6);
    const result = channel.send(data);
    expect(result).toBe(false);
  });
});
