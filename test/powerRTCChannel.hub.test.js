import { describe, it, expect, vi } from 'vitest';
import { PowerRTCChannel } from '../src/helpers/powerRTCChannel.js';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';

/**
 * RT-017, integration half: `PowerRTCChannel` as a transport for
 * `PowerRealtimeHub`'s `send(sub, frame)` adapter.
 *
 * ## Why the over-size case is the load-bearing test in this file
 *
 * `PowerRealtimeHub` increments `stats().delivered` **before** calling
 * `send(sub, frame)`, and it reports a failure only through a **throw** — a
 * `send` that returns without throwing has been accepted, full stop. So an
 * adapter that refused an over-size frame by returning `false`, which is what
 * `PowerSocketAdapter.send` does for "not now", would drop the frame with
 * `delivered` already incremented and the subscriber's handler never invoked.
 *
 * Nothing in either helper's own test suite would have caught that. The
 * adapter's contract is satisfied, the hub's contract is satisfied, and the
 * frame is gone. This file asserts the two together, because the interaction
 * between them is the whole design decision:
 *
 * - **transient** refusal (not open) → `false` → the producer retries;
 * - **permanent** refusal (over the SCTP ceiling) → `throw` → the hub's
 *   `onError` sees it.
 *
 * Getting this backwards costs a frame; getting it right costs nothing.
 */
class HubDataChannel {
  constructor({ readyState = 'open', maxMessageSize = 1024 } = {}) {
    this.listeners = new Map();
    this.readyState = readyState;
    this.ordered = false;
    this.maxRetransmits = 0;
    this.binaryType = 'arraybuffer';
    this.sctp = { maxMessageSize };
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.closeCalls = 0;
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
  fire(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
  send(data) {
    this.sent.push(data);
    this.bufferedAmount += data.byteLength;
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 'closed';
    this.fire('close', { type: 'close' });
  }
}

/** The wiring from `guides/powerRTCChannel.md`, verbatim. */
function hubWith(channel, { onError } = {}) {
  return new PowerRealtimeHub({
    send: (sub, frame) => sub.transport.send(frame),
    close: (sub) => sub.transport.close(),
    onError,
    batch: false,
  });
}

describe('a PowerRTCChannel as a hub transport', () => {
  it('delivers a published frame to the transport', async () => {
    const dc = new HubDataChannel();
    const channel = new PowerRTCChannel(dc);
    const hub = hubWith(channel);
    const received = [];
    hub.subscribe('ticks', (payload) => received.push(payload), { transport: channel });

    hub.publish('ticks', { n: 1 });
    await hub.flush();

    expect(received).toEqual([{ n: 1 }]);
    expect(dc.sent).toHaveLength(1);
    // The frame is the hub's own encoded buffer, handed over by reference. The
    // hub gives every subscriber of a topic **the same** buffer (its RT-006 encode
    // memo), so a transport that wrote into it would corrupt every other
    // subscriber — and a copy here would be pure overhead, since the platform
    // serialises synchronously.
    expect(dc.sent[0]).toBeInstanceOf(Uint8Array);
    expect(channel.stats().sent).toBe(1);
  });

  it('hands two subscribers the identical buffer, and the transport did not copy it', async () => {
    // The shared-buffer contract, asserted from the transport side. Two
    // subscribers **on the same topic**, one publish: if `send()` copied, the
    // frames would differ, and the check that both are the same object is what
    // makes the "no copy" claim in `send()`'s docblock true rather than merely
    // asserted.
    const dc = new HubDataChannel();
    const channel = new PowerRTCChannel(dc);
    const hub = hubWith(channel);
    hub.subscribe('ticks', () => {}, { transport: channel });
    hub.subscribe('ticks', () => {}, { transport: channel });
    hub.publish('ticks', { n: 1 });
    await hub.flush();

    expect(dc.sent).toHaveLength(2);
    expect(dc.sent[0]).toBe(dc.sent[1]);
  });

  it('does NOT close the channel on unsubscribe — one channel carries many topics', async () => {
    // **A property of the hub, and a load-bearing one for a data channel.**
    // `unsubscribe(id)` calls `_detach(sub)` *without* `{ close: true }`: the
    // close adapter fires only for `hub.close()` and for a slow-consumer
    // disconnect. That is correct for a fan-out hub, and for `RTCDataChannel` it
    // is more than correct — `close()` cannot be undone, so closing on
    // unsubscribe would kill the peer's connection over one topic leaving.
    //
    // This test exists because I wrote the opposite assertion first and it
    // failed: the hub's behaviour is the surprising part, not the expectation.
    const dc = new HubDataChannel();
    const channel = new PowerRTCChannel(dc);
    const hub = hubWith(channel);
    const unsubscribe = hub.subscribe('ticks', () => {}, { transport: channel });
    hub.subscribe('other', () => {}, { transport: channel });

    unsubscribe();
    expect(dc.closeCalls).toBe(0);
    expect(channel.isOpen).toBe(true);
  });

  it('closes the channel on hub.close(), and the reason survives only in the hub', async () => {
    const dc = new HubDataChannel();
    const onClose = vi.fn();
    const channel = new PowerRTCChannel(dc, { onClose });
    const hub = hubWith(channel);
    hub.subscribe('ticks', () => {}, { transport: channel });
    hub.subscribe('other', () => {}, { transport: channel });

    hub.close();
    expect(dc.closeCalls).toBe(1);
    expect(channel.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    // `'local'`, because this class called `close()`. **The hub's reason is gone.**
    // `RTCDataChannel.close()` takes no arguments and the `close` event carries
    // neither code nor reason, so `hub-closed` exists only in the hub's own
    // bookkeeping — take it from the `close(sub, reason)` adapter's argument if
    // you need to log why, which is what the guide tells you to do.
    expect(onClose.mock.calls[0][0].reason).toBe('local');
  });

  it('the hub ignores a `false` from send — so a not-open frame reaches the handler anyway', async () => {
    // **The half of the throw-vs-`false` decision that is uncomfortable, and the
    // reason `sendRefusals` is a counter rather than a comment.**
    //
    // The hub treats "returned without throwing" as delivered: it increments
    // `delivered` before calling the adapter and invokes the handler on the
    // success path of the returned value's promise. A `false` is not a rejection,
    // so the consumer is told it processed a frame the transport never carried.
    // `PowerSocketAdapter` behaves identically — this is a property of the hub's
    // adapter contract, not of this helper.
    //
    // So `false` is still the right answer for a *transient* refusal (it is what
    // the sibling returns, and it must not become an `onError` per frame during
    // every connect race), but it is **invisible at the consumer**, and
    // `stats().sendRefusals` is the only signal. The guide says so; this test
    // says so mechanically.
    const dc = new HubDataChannel({ readyState: 'connecting' });
    const onError = vi.fn();
    const channel = new PowerRTCChannel(dc);
    const hub = hubWith(channel, { onError });
    const received = [];
    hub.subscribe('ticks', (p) => received.push(p), { transport: channel });

    hub.publish('ticks', { n: 1 });
    await hub.flush();

    // The handler ran, believing the frame went out. Nothing did.
    expect(received).toEqual([{ n: 1 }]);
    expect(dc.sent).toEqual([]);
    // No error: nothing went wrong, the handshake is simply unfinished. An
    // `onError` per frame during a connect race is noise that trains a caller to
    // ignore the handler.
    expect(onError).not.toHaveBeenCalled();
    // **The only trace.** A caller who never reads this is running a transport
    // that looks connected and has sent nothing.
    expect(channel.stats().sendRefusals).toBe(1);
    expect(channel.stats().sent).toBe(0);

    // And it recovers once open, which is what makes `false` the right answer.
    dc.readyState = 'open';
    dc.fire('open', { type: 'open' });
    hub.publish('ticks', { n: 2 });
    await hub.flush();
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    expect(channel.stats().sent).toBe(1);
  });

  it('routes an over-size frame to onError and does not deliver it', async () => {
    // **The assertion the whole throw-vs-`false` decision rests on.** Refused
    // before the platform saw it, reported through the hub's `onError`, and the
    // subscriber's handler is never invoked with it. Returning `false` here would
    // have produced all three of the opposite answers with no error anywhere.
    const dc = new HubDataChannel({ maxMessageSize: 512 });
    const onError = vi.fn();
    const channel = new PowerRTCChannel(dc);
    const hub = hubWith(channel, { onError });
    const received = [];
    hub.subscribe('ticks', (p) => received.push(p), { transport: channel });

    hub.publish('ticks', { blob: 'x'.repeat(2048) });
    await hub.flush();

    expect(received).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [error] = onError.mock.calls[0];
    expect(error.code).toBe('ERR_FRAME_TOO_LARGE');
    expect(error.limit).toBe(512);
    expect(error.message).toMatch(/stopped before send\(\)/);
    // Never reached the platform.
    expect(dc.sent).toEqual([]);
    // Counted as its own thing, distinct from a transport failure — this is a
    // local payload decision, not a broken channel.
    expect(channel.stats()).toMatchObject({ oversizeFrames: 1, sendFailures: 0, sent: 0 });
  });

  it('keeps serving after an over-size frame', async () => {
    // A throw must not poison the subscriber: the next publish has to work, or one
    // bad payload silently detaches a topic.
    const dc = new HubDataChannel({ maxMessageSize: 512 });
    const onError = vi.fn();
    const channel = new PowerRTCChannel(dc);
    const hub = hubWith(channel, { onError });
    const received = [];
    hub.subscribe('ticks', (p) => received.push(p), { transport: channel });

    hub.publish('ticks', { blob: 'x'.repeat(2048) });
    await hub.flush();
    hub.publish('ticks', { n: 1 });
    await hub.flush();

    expect(received).toEqual([{ n: 1 }]);
    expect(dc.sent).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('works end to end over a hub round trip, inbound included', async () => {
    // The shape the guide shows, with both directions live: the hub publishes, the
    // transport carries it to the peer, and an inbound `message` is handed back
    // to the caller. A one-way assertion would leave the receive half — which is
    // where a `binaryType` surprise shows up — untested.
    const dc = new HubDataChannel();
    const inbound = [];
    const channel = new PowerRTCChannel(dc, {
      onMessage: ({ data }) => inbound.push(data),
      highWaterMarkBytes: 4096,
    });
    const hub = hubWith(channel);
    const delivered = [];
    hub.subscribe('ticks', (p) => delivered.push(p), { transport: channel });

    hub.publish('ticks', { n: 1 });
    await hub.flush();
    // What the peer would receive.
    dc.fire('message', { data: dc.sent[0] });

    expect(delivered).toEqual([{ n: 1 }]);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toBe(dc.sent[0]);
    expect(channel.stats()).toMatchObject({
      sent: 1,
      messages: 1,
      handled: 1,
      canPing: false,
      ordered: false,
      maxRetransmits: 0,
    });
    channel.dispose();
    hub.close();
  });
});
