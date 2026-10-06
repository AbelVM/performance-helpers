import { describe, it, expect } from 'vitest';
import { PowerDatagramChannel } from '../src/helpers/powerDatagramChannel.js';

/**
 * WT-003: `PowerDatagramChannel` — opt-in, own bounded queue, hard
 * `maxDatagramSize` check that throws.
 *
 * The row's premise was checked first: an oversize datagram must be refused
 * loudly and counted, not silently discarded. The class is not a hub
 * `send(sub, frame)` adapter — `retain` and datagrams contradict each other —
 * so these tests exercise the standalone channel shape.
 */

class FakeTransport {
  constructor() {
    this.sent = [];
    this._closed = false;
    this.readyState = 'open';
  }

  send(data) {
    if (this._closed) throw new Error('transport is closed');
    this.sent.push(data);
  }

  close() {
    this._closed = true;
  }
}

describe('PowerDatagramChannel', () => {
  it('sends a datagram to the transport', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    const result = channel.send(new Uint8Array([1, 2, 3]));

    expect(result).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toBeInstanceOf(Uint8Array);
  });

  it('counts bytes sent', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    channel.send(new Uint8Array([1, 2, 3]));
    channel.send(new Uint8Array([4, 5]));

    const stats = channel.stats();
    expect(stats.sentCount).toBe(2);
    expect(stats.bytesOut).toBe(5);
  });

  it('throws on an oversize datagram', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport, {
      maxDatagramSizeBytes: 4,
    });

    expect(() => channel.send(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(TypeError);
    expect(transport.sent).toHaveLength(0);

    const stats = channel.stats();
    expect(stats.oversizeDatagrams).toBe(1);
  });

  it('does not throw when maxDatagramSizeBytes is 0 (disabled)', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport, {
      maxDatagramSizeBytes: 0,
    });

    const result = channel.send(new Uint8Array([1, 2, 3, 4, 5]));

    expect(result).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(channel.stats().oversizeDatagrams).toBe(0);
  });

  it('returns false when the transport is closed', () => {
    const transport = new FakeTransport();
    transport.close();
    const channel = new PowerDatagramChannel(transport);

    const result = channel.send(new Uint8Array([1]));

    expect(result).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('queues datagrams when the transport is not open', () => {
    const transport = new FakeTransport();
    transport.readyState = 'connecting';
    const channel = new PowerDatagramChannel(transport, { maxQueue: 2 });

    expect(channel.send(new Uint8Array([1]))).toBe(true);
    expect(channel.send(new Uint8Array([2]))).toBe(true);

    expect(channel.stats().queued).toBe(2);
    expect(transport.sent).toHaveLength(0);
  });

  it('drops oldest when the queue is full', () => {
    const transport = new FakeTransport();
    transport.readyState = 'connecting';
    const channel = new PowerDatagramChannel(transport, { maxQueue: 2 });

    channel.send(new Uint8Array([1]));
    channel.send(new Uint8Array([2]));
    const result = channel.send(new Uint8Array([3]));

    expect(result).toBe(true);
    expect(channel.stats().droppedCount).toBe(1);
    expect(channel.stats().queued).toBe(2);
    // The oldest ([1]) was dropped, [2] and [3] remain.
    expect(transport.sent).toHaveLength(0);
  });

  it('flushes the queue when the transport opens', () => {
    const transport = new FakeTransport();
    transport.readyState = 'connecting';
    const channel = new PowerDatagramChannel(transport, { maxQueue: 4 });

    channel.send(new Uint8Array([1]));
    channel.send(new Uint8Array([2]));
    transport.readyState = 'open';

    const sent = channel.flush();

    expect(sent).toBe(2);
    expect(transport.sent).toHaveLength(2);
    expect(channel.stats().queued).toBe(0);
  });

  it('reports oversize datagrams sent to an open transport', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport, {
      maxDatagramSizeBytes: 2,
    });

    expect(() => channel.send(new Uint8Array([1, 2, 3]))).toThrow(TypeError);
    expect(channel.stats().oversizeDatagrams).toBe(1);
    expect(channel.stats().queued).toBe(0);
  });

  it('calls onError for oversize datagrams', () => {
    const transport = new FakeTransport();
    const errors = [];
    const channel = new PowerDatagramChannel(transport, {
      maxDatagramSizeBytes: 2,
      onError: (err, ctx) => errors.push({ err, ctx }),
    });

    try {
      channel.send(new Uint8Array([1, 2, 3]));
    } catch {
      // expected
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].err).toBeInstanceOf(TypeError);
    expect(errors[0].ctx.datagramSize).toBe(3);
    expect(errors[0].ctx.limit).toBe(2);
  });

  it('calls onError for transport throws', () => {
    const transport = new FakeTransport();
    transport.send = () => {
      throw new Error('boom');
    };
    const errors = [];
    const channel = new PowerDatagramChannel(transport, {
      onError: (err) => errors.push(err),
    });

    const result = channel.send(new Uint8Array([1]));

    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('boom');
    expect(channel.stats().errorCount).toBe(1);
  });

  it('is idempotent on close and dispose', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    channel.close();
    channel.close();
    channel.dispose();
    channel.dispose();

    // no throw
    expect(channel.stats().disposed).toBe(true);
  });

  it('reports disposed state in stats', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    expect(channel.stats().disposed).toBe(false);

    channel.dispose();

    expect(channel.stats().disposed).toBe(true);
  });

  it('getStats is an alias for stats', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    expect(channel.getStats()).toStrictEqual(channel.stats());
  });

  it('throws on construction for a non-transport', () => {
    expect(() => new PowerDatagramChannel(null)).toThrow(TypeError);
    expect(() => new PowerDatagramChannel({})).toThrow(TypeError);
  });

  it('accepts string datagrams', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    const result = channel.send('hello');

    expect(result).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(channel.stats().bytesOut).toBe(5);
  });

  it('defaults maxDatagramSizeBytes to 65535', () => {
    const transport = new FakeTransport();
    const channel = new PowerDatagramChannel(transport);

    // 65535 bytes should pass.
    const big = new Uint8Array(65535);
    expect(channel.send(big)).toBe(true);

    // 65536 bytes should throw.
    expect(() => channel.send(new Uint8Array(65536))).toThrow(TypeError);
  });
});
