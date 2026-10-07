import { describe, it, expect, vi } from 'vitest';
import { createBroadcastBus } from '../src/helpers/powerBroadcastBus.js';
import { encodeNativeEnvelope } from '../src/helpers/powerMessageCodec.js';

function mockChannel() {
  const listeners = [];
  const posted = [];
  const channel = {
    postMessage(msg) {
      posted.push(msg);
    },
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    get messageListeners() {
      return listeners.filter((l) => l.type === 'message');
    },
    get postedMessages() {
      return posted;
    },
    dispatch(data) {
      for (const l of listeners) {
        if (l.type === 'message') l.fn({ data });
      }
    },
  };
  return channel;
}

describe('createBroadcastBus', () => {
  it('throws when channel is missing', () => {
    expect(() => createBroadcastBus({})).toThrow(/channel.*must be a BroadcastChannel/);
  });

  it('throws when channel has no postMessage', () => {
    expect(() => createBroadcastBus({ channel: {} })).toThrow(/postMessage/);
  });

  it('send posts a frame with _bc marker, seq and receiverId', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    const sub = { id: 'r1' };

    bus.send(sub, { hello: 'world' });

    expect(channel.postedMessages.length).toBe(1);
    const msg = channel.postedMessages[0];
    expect(msg._bc).toBe(true);
    expect(msg.seq).toBe(1);
    expect(msg.receiverId).toBe('r1');
    expect(msg.frame).toEqual({ hello: 'world' });
  });

  it('send increments sequence numbers', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    bus.send({ id: 'r1' }, 1);
    bus.send({ id: 'r1' }, 2);
    expect(channel.postedMessages[0].seq).toBe(1);
    expect(channel.postedMessages[1].seq).toBe(2);
  });

  it('send returns false when closed', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    bus.dispose();
    expect(bus.send({ id: 'r1' }, 1)).toBe(false);
  });

  it('send throws when sub.id is not a string', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    expect(() => bus.send({ id: 123 }, 1)).toThrow(/sub\.id.*must be a string/);
    expect(() => bus.send(null, 1)).toThrow(/sub\.id.*must be a string/);
  });

  it('close clears pending timers and resets counts for the receiver', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 1000 });
    const sub = { id: 'r1' };

    bus.send(sub, 1);
    bus.send(sub, 2);
    bus.close(sub);

    // No more pending acks for r1
    expect(bus.getSlowConsumerIds().has('r1')).toBe(false);
  });

  it('close is a no-op when sub.id is missing', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    expect(() => bus.close({})).not.toThrow();
    expect(() => bus.close(undefined)).not.toThrow();
  });

  it('getSlowConsumerIds returns a copy', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    const copy = bus.getSlowConsumerIds();
    expect(copy).not.toBe(bus.getSlowConsumerIds());
    expect(copy.size).toBe(0);
  });

  it('dispose removes listener and clears all state', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    bus.send({ id: 'r1' }, 1);
    bus.dispose();

    expect(channel.messageListeners.length).toBe(0);
    expect(bus.getSlowConsumerIds().size).toBe(0);
    expect(bus.send({ id: 'r1' }, 1)).toBe(false);
  });

  it('dispose is idempotent', () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    bus.dispose();
    expect(() => bus.dispose()).not.toThrow();
  });

  it('marks receiver slow when ack times out and calls onSlowConsumer', async () => {
    const channel = mockChannel();
    const onSlow = vi.fn();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 100, onSlowConsumer: onSlow });

    bus.send({ id: 'r1' }, 1);
    expect(onSlow).not.toHaveBeenCalled();

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 150));

    expect(onSlow).toHaveBeenCalledWith('r1');
    expect(bus.getSlowConsumerIds().has('r1')).toBe(true);
  });

  it('clears slow status when ack arrives before timeout', async () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 1000 });

    bus.send({ id: 'r1' }, 1);
    expect(bus.getSlowConsumerIds().has('r1')).toBe(false);

    // Simulate ack as a native envelope
    const ackPayload = new TextEncoder().encode(JSON.stringify({ seq: 1, receiverId: 'r1' }));
    channel.dispatch(encodeNativeEnvelope({ type: 'ack', payload: ackPayload }));

    // Wait past the timeout to ensure the timer would have fired if not cleared
    await new Promise((r) => setTimeout(r, 1100));

    expect(bus.getSlowConsumerIds().has('r1')).toBe(false);
  });

  it('ignores acks for unknown sequences', async () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 100 });

    bus.send({ id: 'r1' }, 1);
    const ackPayload = new TextEncoder().encode(JSON.stringify({ seq: 999, receiverId: 'r1' }));
    channel.dispatch(encodeNativeEnvelope({ type: 'ack', payload: ackPayload }));

    // Wait for timeout - the real ack for seq 1 never arrived
    await new Promise((r) => setTimeout(r, 150));

    expect(bus.getSlowConsumerIds().has('r1')).toBe(true);
  });

  it('ignores non-native-envelope messages', async () => {
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 100 });

    bus.send({ id: 'r1' }, 1);
    channel.dispatch({ notAnEnvelope: true });

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 150));

    expect(bus.getSlowConsumerIds().has('r1')).toBe(true);
  });
});
