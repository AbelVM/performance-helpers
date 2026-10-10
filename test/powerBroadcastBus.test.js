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

  it('close leaves no zero entry behind for the receiver (AUD-014)', () => {
    // `close()` used to `set(receiverId, 0)` when the count was positive. Every
    // pending send for the receiver is cleared by the loop just above, so the
    // count *is* zero — but a zero entry is not a state, it is a leftover.
    // Nothing decrements it, because the timers that would have were cleared, so
    // it survives until the bus is disposed and the map grows one key per closed
    // subscriber.
    //
    // Asserted through `getPendingCounts()`, which exists for this: the defect is
    // pure retention with no behavioural symptom, so a test written against the
    // rest of the public surface passes either way — which is exactly what the
    // `close` test above did before this one was added.
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 1000 });
    const sub = { id: 'r1' };

    bus.send(sub, 1);
    bus.send(sub, 2);
    expect(bus.getPendingCounts().get('r1')).toBe(2);

    bus.close(sub);

    // Absent, not zero. `has` rather than `get(...) === 0`, because a leftover
    // `0` and a correct absence are the same value and only differ in whether
    // the key is still there.
    expect(bus.getPendingCounts().has('r1')).toBe(false);
    expect(bus.getPendingCounts().size).toBe(0);
  });

  it('close leaves no entry for a receiver with no pending sends (AUD-014)', () => {
    // The other arm of the old branch, pinned so the unconditional delete cannot
    // regress it: a receiver that never sent has nothing to clean up.
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel });
    bus.close({ id: 'never-sent' });
    expect(bus.getPendingCounts().has('never-sent')).toBe(false);
  });

  it('getPendingCounts returns a copy, so a caller cannot corrupt the bus', () => {
    // Same contract as `getSlowConsumerIds()`, and for the same reason: a
    // diagnostic that hands out the live map lets a caller delete a receiver's
    // bookkeeping and silently disable its slow-consumer detection.
    const channel = mockChannel();
    const bus = createBroadcastBus({ channel, ackTimeoutMs: 1000 });
    bus.send({ id: 'r1' }, 1);

    const snapshot = bus.getPendingCounts();
    expect(snapshot).not.toBe(bus.getPendingCounts());
    snapshot.set('r1', 999);
    snapshot.delete('r1');

    expect(bus.getPendingCounts().get('r1')).toBe(1);
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

  it('reuses one TextDecoder across acks instead of building one per ack (AUD-020)', async () => {
    // The ack path used to do `new TextDecoder().decode(...)` **per ack**. A
    // `TextDecoder` is not free to construct, and an ack arrives once per frame
    // per receiver, so this sat on the bus's hottest path for no reason a caller
    // could observe.
    //
    // A pure performance change has no behavioural symptom, so the only honest
    // test is the one that counts constructions: revert to a per-ack `new` and
    // this goes red. The decoder is module-level and lazily created, so the
    // count is asserted as "at most one" rather than "exactly one" — a test that
    // required exactly one would fail for a caller who never sent a frame, which
    // is the lazy path working correctly.
    const RealDecoder = globalThis.TextDecoder;
    let constructions = 0;
    class CountingDecoder extends RealDecoder {
      constructor(...args) {
        super(...args);
        constructions += 1;
      }
    }
    globalThis.TextDecoder = CountingDecoder;

    try {
      const channel = mockChannel();
      const bus = createBroadcastBus({ channel, ackTimeoutMs: 1000 });

      // Three frames, three acks — the shape that used to cost three decoders.
      for (let seq = 1; seq <= 3; seq++) {
        bus.send({ id: 'r1' }, seq);
        const payload = new TextEncoder().encode(JSON.stringify({ seq, receiverId: 'r1' }));
        channel.dispatch(encodeNativeEnvelope({ type: 'ack', payload }));
      }

      expect(constructions).toBeLessThanOrEqual(1);
      // And the acks were genuinely processed, so the shared decoder is not a
      // decoder that silently fails: no receiver is left marked slow.
      expect(bus.getSlowConsumerIds().size).toBe(0);
      expect(bus.getPendingCounts().size).toBe(0);
    } finally {
      globalThis.TextDecoder = RealDecoder;
    }
  });
});
