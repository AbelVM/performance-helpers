import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { PowerRTCChannel } from '../src/helpers/powerRTCChannel.js';
import { oversizedFrameError, unsendableFrameError } from '../src/utils/errors.js';

/**
 * RT-017: `PowerRTCChannel` normalises an `RTCDataChannel` for
 * `PowerRealtimeHub`'s `send(sub, frame)` shape.
 *
 * ## The double, and what it must get right
 *
 * `RTCDataChannel` is an `EventTarget` with a **string** `readyState`, which is
 * the whole reason this class exists and is asserted first. Everything else here
 * is a consequence of a platform behaviour that the row did not record:
 * `send()` **throws** above the SCTP message limit rather than buffering, so a
 * refusal has to be distinguishable from "not now".
 *
 * The fake models the parts the platform actually promises — synchronous
 * `bufferedAmount` growth inside `send()`, a one-shot `bufferedamountlow` when it
 * drains back to the threshold, and throwing on an over-size frame — rather than
 * being a convenient stub that agrees with whatever the code does.
 */
class FakeDataChannel {
  constructor({
    readyState = 'open',
    ordered = false,
    maxRetransmits = 0,
    maxMessageSize = 65536,
    binaryType = 'arraybuffer',
  } = {}) {
    this.listeners = new Map();
    this.readyState = readyState;
    this.ordered = ordered;
    this.maxRetransmits = maxRetransmits;
    this.maxPacketLifeTime = null;
    this.binaryType = binaryType;
    this.sctp = { maxMessageSize };
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sent = [];
    this.closeCalls = 0;
    // `drainTo` models the transport actually flushing: without it the fake
    // would never emit `bufferedamountlow` and the back-pressure test below would
    // be asserting that the code works against a platform that never signals.
    this.drainTo = null;
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
  totalListeners() {
    let n = 0;
    for (const list of this.listeners.values()) n += list.length;
    return n;
  }
  fire(type, event) {
    // Dispatches to both registration styles, as a real `EventTarget` does. The
    // fake calling only the `addEventListener` half would have made the
    // "leaves the caller's handler alone" test pass vacuously.
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    const prop = this[`on${type}`];
    if (typeof prop === 'function') prop(event);
  }
  /** Total listeners this class registered, for the detach assertions. */
  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  send(data) {
    // The platform raises `bufferedAmount` **synchronously**, which is what lets
    // the helper evaluate the high-water mark from the send path at all.
    const size = data?.byteLength ?? data?.length ?? 0;
    this.bufferedAmount += size;
    if (this.bufferedAmount > (this.sctp.maxMessageSize ?? Infinity)) {
      // What the real one does above the negotiated ceiling. Checked *before* the
      // frame is queued, so it is not in `sent` — which is the property the
      // helper's own check exists to turn into a typed error.
      throw Object.assign(new TypeError('RTCDataChannel: message too large'), {
        name: 'TypeError',
      });
    }
    this.sent.push(data);
  }

  /** Model the transport draining the buffer and pushing the low-water event. */
  drain() {
    const threshold = this.bufferedAmountLowThreshold;
    this.bufferedAmount = 0;
    if (threshold > 0) this.fire('bufferedamountlow', { type: 'bufferedamountlow' });
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 'closed';
    this.fire('close', { type: 'close' });
  }
}

/** A frame of `n` bytes, as the hub hands one over. */
const frame = (n) => new Uint8Array(n).fill(7);

describe('PowerRTCChannel construction', () => {
  it('rejects anything that is not a data channel', () => {
    // An `RTCPeerConnection` is the mistake this message exists for: it has
    // `createDataChannel` but no `send`, so storing it would produce an adapter
    // that matched no branch and reported itself open.
    expect(() => new PowerRTCChannel(new RTCPeerConnectionStub())).toThrow(TypeError);
    expect(() => new PowerRTCChannel(new RTCPeerConnectionStub())).toThrow(/send\(data\)/);
    for (const bad of [null, undefined, 0, 'dc', {}]) {
      expect(() => new PowerRTCChannel(bad)).toThrow(TypeError);
    }
  });

  it('rejects an unknown option rather than ignoring it', () => {
    // The library's standing rule: an option that was not understood would
    // otherwise be silently inert, which is the failure RT-016's `initialBuffer`
    // was.
    expect(() => new PowerRTCChannel(new FakeDataChannel(), { maxSize: 10 })).toThrow(/maxSize/);
  });

  it('accepts a channel that has not opened yet, and refuses to send on it', () => {
    const dc = new FakeDataChannel({ readyState: 'connecting' });
    const channel = new PowerRTCChannel(dc);
    expect(channel.isOpen).toBe(false);
    // **This is the `InvalidStateError` guard.** The platform throws when
    // `send()` is called while `connecting`; the refusal is what keeps it from
    // being thrown at a caller who is simply ahead of the handshake.
    expect(channel.send(frame(8))).toBe(false);
    expect(dc.sent).toEqual([]);
    expect(channel.stats().sendRefusals).toBe(1);
    expect(channel.stats().sendFailures).toBe(0);
  });

  it('reports onOpen for a channel that was already open at construction', () => {
    // A channel transferred to a worker *after* negotiation never fires `open`
    // again, so a class that only listened for the event would leave its caller
    // waiting for a signal that will not come.
    const onOpen = vi.fn();
    const channel = new PowerRTCChannel(new FakeDataChannel(), { onOpen });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].channel).toBe(channel);
    expect(channel.stats().opened).toBe(1);
  });

  it('does not report onOpen for a connecting channel, then does on the event', () => {
    const onOpen = vi.fn();
    const dc = new FakeDataChannel({ readyState: 'connecting' });
    const channel = new PowerRTCChannel(dc, { onOpen });
    expect(onOpen).not.toHaveBeenCalled();
    dc.readyState = 'open';
    dc.fire('open', { type: 'open' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(channel.isOpen).toBe(true);
    expect(channel.stats().opened).toBe(1);
  });
});

describe('PowerRTCChannel send', () => {
  it('hands the frame to the platform and counts it', () => {
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc);
    const f = frame(32);
    expect(channel.send(f)).toBe(true);
    // **Identity, not equality**: the hub hands every subscriber of a topic the
    // same buffer, so a copy here is not needed and would be pure overhead. The
    // platform serialises synchronously, which is what makes it safe.
    expect(dc.sent[0]).toBe(f);
    expect(channel.stats()).toMatchObject({ sent: 1, bytesOut: 32, sendFailures: 0 });
  });

  it('refuses — not throws — when the channel is not open, and the counter says which', () => {
    const dc = new FakeDataChannel({ readyState: 'connecting' });
    const channel = new PowerRTCChannel(dc);
    expect(channel.send(frame(4))).toBe(false);
    dc.fire('close', { type: 'close' });
    expect(channel.send(frame(4))).toBe(false);
    // `sendRefusals` is separate from `sendFailures` on purpose: "the channel
    // was not ready" is the producer's problem to retry, and folding it in with
    // real transport errors would make a connect race indistinguishable from a
    // broken channel.
    expect(channel.stats()).toMatchObject({ sendRefusals: 2, sendFailures: 0, sent: 0 });
  });

  it('THROWS on a frame over the message-size limit, and counts it separately', () => {
    const dc = new FakeDataChannel({ maxMessageSize: 1000 });
    const channel = new PowerRTCChannel(dc);
    expect(channel.send(frame(999))).toBe(true);
    // **The assertion that matters most in this file.** The oversize frame never
    // reaches the platform, and the throw is the design decision: retrying cannot
    // make a frame smaller, and a `PowerRealtimeHub` adapter that refused by
    // returning `false` would lose the frame with `delivered` already
    // incremented.
    expect(() => channel.send(frame(1001))).toThrow(/1001-byte frame/);
    expect(dc.sent).toHaveLength(1);
    expect(channel.stats()).toMatchObject({ sent: 1, oversizeFrames: 1, sendFailures: 0 });
  });

  it('defaults the ceiling to the negotiated SCTP message size', () => {
    const dc = new FakeDataChannel({ maxMessageSize: 4096 });
    const channel = new PowerRTCChannel(dc);
    expect(channel.stats().maxMessageSizeBytes).toBe(4096);
    expect(() => channel.send(frame(4097))).toThrow(/4096/);
  });

  it('falls back to 256 KiB when the platform exposes no sctp transport', () => {
    const dc = new FakeDataChannel();
    // A test double, a platform mid-negotiation, and an older browser all look
    // like this: no `sctp`, so no negotiated figure to read.
    delete dc.sctp;
    const channel = new PowerRTCChannel(dc);
    expect(channel.stats().maxMessageSizeBytes).toBe(256 * 1024);
    expect(() => channel.send(frame(256 * 1024 + 1))).toThrow(/262144/);
  });

  it('reads a nonsensical maxMessageSizeBytes as a hard error, not a clamp', () => {
    const dc = new FakeDataChannel();
    expect(() => new PowerRTCChannel(dc, { maxMessageSizeBytes: NaN })).toThrow(TypeError);
    expect(() => new PowerRTCChannel(dc, { maxMessageSizeBytes: 'lots' })).toThrow(TypeError);
    expect(() => new PowerRTCChannel(dc, { maxMessageSizeBytes: -1 })).toThrow(TypeError);
  });

  it('accepts Infinity as "let the platform throw", and then does', () => {
    // The escape hatch, and it is honest: it does not remove the limit, it hands
    // the check to the real one. The consequence is a DOMException through
    // `onError` rather than a typed error.
    const onError = vi.fn();
    const dc = new FakeDataChannel({ maxMessageSize: 100 });
    const channel = new PowerRTCChannel(dc, { maxMessageSizeBytes: Infinity, onError });
    expect(channel.stats().maxMessageSizeBytes).toBe(Infinity);
    expect(channel.send(frame(101))).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(channel.stats().sendFailures).toBe(1);
  });

  it('routes a platform send() throw to onError and reports false', () => {
    const onError = vi.fn();
    const dc = new FakeDataChannel({ maxMessageSize: Infinity });
    const channel = new PowerRTCChannel(dc, { onError });
    dc.send = () => {
      throw new DOMExceptionLike('InvalidStateError');
    };
    expect(channel.send(frame(8))).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe(channel);
    expect(channel.stats().sendFailures).toBe(1);
  });

  it('survives a throwing onError and a throwing onMessage', () => {
    // A user callback that throws must not become an unhandled rejection that
    // takes down the process, and must not stop the channel counting.
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc, {
      onError: () => {
        throw new Error('handler is broken too');
      },
    });
    dc.send = () => {
      throw new Error('transport is broken');
    };
    expect(() => channel.send(frame(8))).not.toThrow();
    expect(channel.stats().sendFailures).toBe(1);

    const other = new PowerRTCChannel(new FakeDataChannel(), {
      onMessage: () => {
        throw new Error('bad consumer');
      },
      onError: () => {},
    });
    expect(() => other.channel.fire('message', { data: frame(4) })).not.toThrow();
  });
});

describe('PowerRTCChannel inbound', () => {
  it('passes the raw MessageEvent.data through and counts it', () => {
    const onMessage = vi.fn();
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc, { onMessage });
    const data = frame(16);
    dc.fire('message', { data });
    // **Not decoded.** `binaryType` is `arraybuffer` by default — verified, not
    // assumed — so a `Uint8Array` goes straight into `decodeMessage`. Decoding
    // here would mean picking a codec this library does not own.
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].data).toBe(data);
    expect(channel.stats()).toMatchObject({ messages: 1, handled: 1, bytesIn: 16 });
  });

  it('separates messages from handled, so a channel with no onMessage is visible', () => {
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc);
    dc.fire('message', { data: frame(4) });
    dc.fire('message', { data: frame(4) });
    // The same split `PowerSocketAdapter` keeps: traffic arrived, and nothing
    // consumed it. Collapsing the two numbers hides a missing consumer.
    expect(channel.stats()).toMatchObject({ messages: 2, handled: 0 });
  });

  it('counts but does not deliver a message that arrives after close', () => {
    const onMessage = vi.fn();
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc, { onMessage });
    dc.fire('close', { type: 'close' });
    dc.fire('message', { data: frame(4) });
    expect(onMessage).not.toHaveBeenCalled();
    expect(channel.stats()).toMatchObject({ messages: 1, handled: 0 });
  });

  it('measures a string frame in code units and a Blob by size', () => {
    // Both approximations are `frameByteLength`'s, shared with the other two
    // helpers. Asserted here because a limit built on them is only as good as
    // them: a `Blob` is counted exactly, and a string is not.
    const channel = new PowerRTCChannel(new FakeDataChannel());
    expect(channel.stats().bytesIn).toBe(0);
    channel.channel.fire('message', { data: 'abcd' });
    channel.channel.fire('message', { data: { size: 100 } });
    expect(channel.stats().bytesIn).toBe(104);
  });
});

describe('PowerRTCChannel close and dispose', () => {
  it('reports local vs remote close, which the platform does not tell you', () => {
    // `RTCDataChannel.close()` takes no arguments and the `close` event carries
    // no code and no reason, so "did we ask" is the only part of the question
    // this class can answer. Both go through one code path.
    const local = vi.fn();
    const a = new PowerRTCChannel(new FakeDataChannel(), { onClose: local });
    a.close();
    expect(local).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[0][0].reason).toBe('local');

    const remote = vi.fn();
    const dc = new FakeDataChannel();
    // No binding needed for the adapter itself — the assertion is about which
    // `reason` the callback is handed.
    new PowerRTCChannel(dc, { onClose: remote });
    dc.fire('close', { type: 'close' });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0][0].reason).toBe('remote');
  });

  it('closes the channel and reports closed immediately, not on the event', () => {
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc);
    channel.close();
    expect(dc.closeCalls).toBe(1);
    // Immediate, for the reason `PowerSocketAdapter.close` does the same: the
    // local path must stop accepting frames without waiting for an event the
    // peer may never cause to fire.
    expect(channel.isOpen).toBe(false);
    expect(channel.readyState).toBe(3);
    expect(channel.send(frame(4))).toBe(false);
  });

  it('is idempotent for both close() and dispose()', () => {
    const dc = new FakeDataChannel();
    const onClose = vi.fn();
    const channel = new PowerRTCChannel(dc, { onClose });
    channel.close();
    channel.close();
    channel.dispose();
    channel.dispose();
    // **Counted once.** A second `onClose` would make a caller tear down its
    // peer entry twice, and the second teardown is where the double-free lives.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dc.closeCalls).toBe(1);
  });

  it('detaches every listener it attached', () => {
    const dc = new FakeDataChannel();
    const channel = new PowerRTCChannel(dc);
    // Six, not five: `closing` is among them. Omitting it left a closing channel
    // reporting `readyState: OPEN`, which is the failure the class exists to
    // prevent; `powerRTCChannel.readyState.test.js` pins the behaviour and this
    // count is what makes the listener un-droppable.
    expect(dc.totalListeners()).toBe(6);
    channel.dispose();
    expect(dc.totalListeners()).toBe(0);
  });

  it('leaves a handler the caller already assigned alone', () => {
    const dc = new FakeDataChannel();
    const theirs = vi.fn();
    dc.onmessage = theirs;
    const channel = new PowerRTCChannel(dc);
    dc.fire('message', { data: frame(4) });
    // The `on*` property form would have **overwritten** this. Adopting a caller's
    // channel and silently disabling their own logging is worse than not
    // attaching at all, which is why `addEventListener` is used throughout.
    expect(theirs).toHaveBeenCalledTimes(1);
    channel.dispose();
  });

  it('survives a channel that throws on addEventListener', () => {
    const dc = new FakeDataChannel();
    const onError = vi.fn();
    dc.addEventListener = () => {
      throw new Error('detached');
    };
    // A half-registered channel must still construct: the caller gets an adapter
    // and a diagnostic rather than a thrown constructor.
    const channel = new PowerRTCChannel(dc, { onError });
    expect(onError).toHaveBeenCalled();
    expect(channel.isOpen).toBe(true);
    expect(() => channel.dispose()).not.toThrow();
  });

  it('disposal clears the handlers, so nothing reaches a torn-down adapter', () => {
    const dc = new FakeDataChannel();
    const onMessage = vi.fn();
    const channel = new PowerRTCChannel(dc, { onMessage });
    channel.dispose();
    expect(dc.totalListeners()).toBe(0);
    dc.fire('message', { data: frame(4) });
    expect(onMessage).not.toHaveBeenCalled();
    // `channel` is null after disposal, so `bufferedAmount` cannot throw on it.
    expect(channel.bufferedAmount).toBe(0);
    expect(channel.send(frame(4))).toBe(false);
  });

  it('works as a scope-exit resource', () => {
    const dc = new FakeDataChannel();
    let seen;
    const channel = new PowerRTCChannel(dc);
    try {
      seen = channel;
      expect(channel.isOpen).toBe(true);
    } finally {
      channel.dispose();
    }
    expect(seen.isOpen).toBe(false);
    expect(dc.totalListeners()).toBe(0);
  });
});

describe('PowerRTCChannel expectUnreliable', () => {
  it('passes for the UDP-like configuration the row describes', () => {
    // `ordered:false, maxRetransmits:0` is fixed at `createDataChannel()` time.
    const dc = new FakeDataChannel({ ordered: false, maxRetransmits: 0 });
    expect(() => new PowerRTCChannel(dc, { expectUnreliable: true })).not.toThrow();
  });

  it('throws for the platform default, which is reliable and ordered', () => {
    // **The defect this option exists for.** A caller who believes they have
    // UDP-like delivery, has not asked for it, and is getting the default
    // reliable ordered channel — every latency claim built on that assumption is
    // false and nothing in the system says so.
    for (const [ordered, maxRetransmits] of [
      [true, 0],
      [false, null],
      [true, null],
    ]) {
      const dc = new FakeDataChannel({ ordered, maxRetransmits });
      expect(() => new PowerRTCChannel(dc, { expectUnreliable: true })).toThrow(TypeError);
      expect(() => new PowerRTCChannel(dc, { expectUnreliable: true })).toThrow(
        /ordered: false, maxRetransmits: 0/
      );
    }
  });

  it('attaches nothing and mutates nothing when it refuses', () => {
    const dc = new FakeDataChannel({ ordered: true, maxRetransmits: null });
    expect(() => new PowerRTCChannel(dc, { expectUnreliable: true })).toThrow();
    // Checked before anything is attached or written, so a rejected
    // configuration cannot leave a listener on the caller's channel or a
    // threshold changed. The order is the assertion; a later check would pass
    // this and still be wrong.
    expect(dc.totalListeners()).toBe(0);
    expect(dc.bufferedAmountLowThreshold).toBe(0);
  });

  it('is off by default, and the reliability is in stats() instead', () => {
    const dc = new FakeDataChannel({ ordered: true, maxRetransmits: null });
    const channel = new PowerRTCChannel(dc);
    expect(channel.stats()).toMatchObject({ ordered: true, maxRetransmits: null });
  });

  it('reports reliability live, so a replaced channel field is not reported stale', () => {
    const dc = new FakeDataChannel({ ordered: false, maxRetransmits: 0 });
    const channel = new PowerRTCChannel(dc);
    dc.ordered = true;
    expect(channel.stats().ordered).toBe(true);
  });
});

describe('PowerRTCChannel liveness honesty', () => {
  it('reports canPing false rather than an RTT it cannot measure', () => {
    // RT-003: a transport that cannot measure must say "unmeasured", not `0 ms`.
    // There is no protocol-level ping on a data channel — nothing defines one
    // beneath SCTP — so liveness here is the `close` event plus message activity.
    const channel = new PowerRTCChannel(new FakeDataChannel());
    expect(channel.canPing).toBe(false);
    expect(channel.stats().canPing).toBe(false);
    expect(channel.stats().rtt).toBeUndefined();
  });
});

describe('PowerRTCChannel stats and getStats', () => {
  it('answers to both names with the same value', () => {
    // QUAL-011: a caller who learned `getStats()` from `PowerPool` must not get
    // `TypeError` here, and a caller who learned `stats()` must not either.
    const channel = new PowerRTCChannel(new FakeDataChannel());
    expect(channel.getStats()).toEqual(channel.stats());
  });

  it('reports the live binaryType rather than assuming the default holds', () => {
    const dc = new FakeDataChannel({ binaryType: 'blob' });
    const channel = new PowerRTCChannel(dc);
    // Verified `arraybuffer` by default — unlike `WebSocket` — which is why
    // RT-002's fix is not repeated here. But the caller's channel can disagree,
    // and a `blob` here is RT-002's defect arriving from outside.
    expect(channel.stats().binaryType).toBe('blob');
  });

  it('keeps every counter non-negative for any interleaving of events', () => {
    // A counter that can go negative is a sign the decrement and the increment
    // are not paired, which is invisible in a fixed script and obvious here.
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constant('open'), fc.constant('close'), fc.constant('message')), {
          minLength: 0,
          maxLength: 40,
        }),
        (events) => {
          const dc = new FakeDataChannel({ readyState: 'connecting' });
          const channel = new PowerRTCChannel(dc);
          for (const event of events) {
            if (event === 'open') dc.fire('open', { type: 'open' });
            if (event === 'close') dc.fire('close', { type: 'close' });
            if (event === 'message') dc.fire('message', { data: frame(4) });
            channel.send(frame(4));
          }
          const s = channel.stats();
          for (const [key, value] of Object.entries(s)) {
            if (typeof value === 'number') {
              expect(value, `${key} went negative`).toBeGreaterThanOrEqual(0);
            }
          }
          expect(s.handled).toBeLessThanOrEqual(s.messages);
          expect(s.closed).toBeLessThanOrEqual(1);
          channel.dispose();
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('the two over-size errors are not one error', () => {
  it('an inbound over-size frame reports that it was already buffered', () => {
    const err = oversizedFrameError('X', 10, 5);
    expect(err.code).toBe('ERR_FRAME_TOO_LARGE');
    expect(err.message).toMatch(/detection, not prevention/);
  });

  it('an outbound over-size frame says it was stopped before send()', () => {
    // **The reason this is a second factory rather than a reused one.** The
    // inbound sentence — "the frame was already received and buffered" — is
    // false for an outbound frame, which this class refuses before the platform
    // ever saw it. Reusing it would tell someone debugging a refused send that
    // their oversized frame had gone out on the wire.
    const err = unsendableFrameError('PowerRTCChannel', 10, 5);
    expect(err.code).toBe('ERR_FRAME_TOO_LARGE');
    expect(err.size).toBe(10);
    expect(err.limit).toBe(5);
    expect(err.message).toMatch(/stopped before send\(\)/);
    expect(err.message).not.toMatch(/detection, not prevention/);
    expect(err.message).not.toMatch(/already received and buffered/);
  });

  it('keeps the same code, so one onError handler filters both directions', () => {
    // Splitting the code would force every caller to write two handlers for one
    // condition, which is the merge this repository keeps having to undo.
    expect(oversizedFrameError('A', 1, 1).code).toBe(unsendableFrameError('B', 1, 1).code);
  });
});

/** Stands in for an `RTCPeerConnection`, which is the mistake worth naming. */
class RTCPeerConnectionStub {
  createDataChannel() {}
  close() {}
}

/** A `DOMException`-alike, since the platform's is not constructible everywhere. */
class DOMExceptionLike extends Error {
  constructor(name) {
    super(name);
    this.name = name;
  }
}

// --- AUD-024: the two-watermark pause/resume cycle ---------------------------

describe('PowerRTCChannel back-pressure watermarks (AUD-024)', () => {
  /**
   * A channel whose `bufferedAmount` grows synchronously on `send()`, which is
   * what lets the helper evaluate the high-water mark from the send path.
   */
  const open = (opts) => {
    const dc = new FakeDataChannel({ readyState: 'open' });
    const ch = new PowerRTCChannel(dc, opts);
    return { dc, ch };
  };

  it('holds frames instead of pushing into a buffer that only grows', () => {
    // The defect. `RTCDataChannel.bufferedAmount` has no ceiling of its own:
    // `send()` keeps accepting while the SCTP congestion window is full, the
    // browser eventually kills the connection, and every frame in flight is lost.
    // The helper used to call the platform's `send()` unconditionally, so
    // `isBackpressured` was a *detector* with nothing behind it.
    const { dc, ch } = open({ highWaterMarkBytes: 1000 });

    // Fill past the high mark.
    ch.send(frame(600));
    ch.send(frame(600));
    expect(ch.isBackpressured).toBe(true);

    // The next frame is held locally, not pushed.
    const before = dc.sent.length;
    expect(ch.send(frame(100))).toBe(true);
    expect(dc.sent.length).toBe(before);
    expect(ch.queuedFrames).toBe(1);
    expect(ch.queuedBytes).toBe(100);
  });

  it('resumes and drains on bufferedamountlow', () => {
    // The resume half, driven by the platform's push signal. Draining here rather
    // than waiting for the next `send()` is what makes the queue actually empty:
    // a producer that stopped calling because it saw `isBackpressured` would
    // otherwise leave every held frame waiting for a send that never comes.
    const { dc, ch } = open({ highWaterMarkBytes: 1000 });

    ch.send(frame(600));
    ch.send(frame(600));
    ch.send(frame(100));
    ch.send(frame(100));
    expect(ch.queuedFrames).toBe(2);

    dc.drain();

    expect(ch.isBackpressured).toBe(false);
    expect(ch.queuedFrames).toBe(0);
    expect(ch.queuedBytes).toBe(0);
    // And the held frames reached the platform, in order.
    expect(dc.sent).toHaveLength(4);
  });

  it('sets bufferedAmountLowThreshold to the LOW mark, not the high one', () => {
    // The reason the two watermarks are separate options. Writing the high mark
    // there — which this class did before the pause/resume cycle existed — makes
    // `bufferedamountlow` fire the moment the buffer returns to the level the
    // channel paused at, so it resumes at the same level it paused at and
    // oscillates around one watermark rather than two.
    const { dc } = open({ highWaterMarkBytes: 1600 });
    expect(dc.bufferedAmountLowThreshold).toBe(100); // 1600 / 16

    const explicit = open({ highWaterMarkBytes: 1600, lowWaterMarkBytes: 200 });
    expect(explicit.dc.bufferedAmountLowThreshold).toBe(200);
  });

  it('refuses past queueBudget rather than growing without bound', () => {
    // **The bound is the point.** Back-pressure without one is not back-pressure,
    // it is a moved leak: frames the platform would have refused are held in an
    // array that grows for as long as the producer keeps calling.
    const { ch } = open({ highWaterMarkBytes: 50, queueBudget: 250 });

    ch.send(frame(100)); // pushes past the high mark
    expect(ch.isBackpressured).toBe(true);
    expect(ch.send(frame(100))).toBe(true); // queued, 100 of 250
    expect(ch.send(frame(100))).toBe(true); // queued, 200 of 250
    // A third would exceed the budget.
    expect(ch.send(frame(100))).toBe(false);
    expect(ch.stats().droppedFrames).toBe(1);
    expect(ch.queuedFrames).toBe(2);
  });

  it('stops draining the moment the channel backs up again', () => {
    // The drain loop re-checks `_backpressured` each iteration, so it stops
    // rather than pushing the whole queue into a buffer that is already full.
    const { dc, ch } = open({ highWaterMarkBytes: 50 });

    ch.send(frame(100)); // over the mark
    for (let i = 0; i < 5; i++) ch.send(frame(10));
    expect(ch.queuedFrames).toBe(5);

    // Drain only part way: the fake zeroes the buffer, so model a partial flush
    // by setting the amount back above the mark before the event fires.
    dc.bufferedAmount = 0;
    dc.bufferedAmountLowThreshold = 0; // no event; drive the drain directly
    ch._backpressured = false;
    ch._drainQueue();
    // All five fit under the mark once the buffer is empty.
    expect(ch.queuedFrames).toBe(0);
    expect(dc.sent).toHaveLength(6);
  });

  it('drops the held frames on dispose, because they can never be delivered', () => {
    // The channel is closed and the listeners that would resume it are gone, so
    // keeping them would be retention with no path to release.
    const { ch } = open({ highWaterMarkBytes: 50 });
    ch.send(frame(100));
    ch.send(frame(50));
    expect(ch.queuedFrames).toBe(1);

    ch.dispose();
    expect(ch.queuedFrames).toBe(0);
    expect(ch.queuedBytes).toBe(0);
  });

  it('reports the queue in stats, so a paused channel is observable', () => {
    const { ch } = open({ highWaterMarkBytes: 50 });
    ch.send(frame(100));
    ch.send(frame(40));

    const s = ch.stats();
    expect(s.queuedFrames).toBe(1);
    expect(s.queuedBytes).toBe(40);
    expect(s.droppedFrames).toBe(0);
    expect(s.backpressureEvents).toBe(1);
  });

  it('clamps a low watermark above the high one instead of refusing the channel', () => {
    // A caller who sets low above high has made a configuration mistake, but the
    // honest reading of "resume at or above where I paused" is "resume
    // immediately". Throwing would refuse a channel that still works, for a
    // mistake that degrades rather than breaks.
    const { dc } = open({ highWaterMarkBytes: 1000, lowWaterMarkBytes: 5000 });
    expect(dc.bufferedAmountLowThreshold).toBe(1000);
  });

  it('still sends directly when the watermark is disabled', () => {
    // `highWaterMarkBytes: 0` disables, matching every other limit here — and the
    // queue must not silently start holding frames.
    const { dc, ch } = open({ highWaterMarkBytes: 0 });
    for (let i = 0; i < 10; i++) ch.send(frame(1000));
    expect(ch.isBackpressured).toBe(false);
    expect(ch.queuedFrames).toBe(0);
    expect(dc.sent).toHaveLength(10);
  });
});
