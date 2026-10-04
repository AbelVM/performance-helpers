import { describe, it, expect, vi } from 'vitest';
import { PowerRTCChannel } from '../src/helpers/powerRTCChannel.js';
import { READY_STATE } from '../src/helpers/constants.js';

/**
 * RT-017, back-pressure half: a data channel **pushes** `bufferedamountlow`, so
 * the helper needs no poll timer — and RT-018's trap, inherited unchanged.
 *
 * ## What RT-017 claimed, and what it missed
 *
 * The row said the client "has to emulate [back-pressure] with a backing-off
 * timer" and that a data channel offers `bufferedamountlow` instead. Both true.
 * What the row did not say is the part a caller feels: the emulation is
 * **`PowerWebSocketClient`'s four options** — `highWaterMarkBytes`,
 * `lowWaterMarkBytes`, `pollIntervalMs`, `maxPollIntervalMs` — plus a timer that
 * has to be kept running and torn down. Here it is one number, handed to the
 * platform as `bufferedAmountLowThreshold`, and a boolean read.
 *
 * The first test pins that arithmetic, because "we have fewer options" is only
 * interesting if the flag is right: a producer has to be able to stop, and stop
 * being told to stop.
 *
 * ## RT-018 is not re-litigated here
 *
 * RT-018 established that `bufferedAmount` does not come back down after a close
 * and that a producer waiting on it spins forever. That fix was the
 * `PowerWebSocketClient` test suite and its guide, and RT-018's row explicitly
 * left the WebRTC guide's copy as outstanding work to be done with RT-017.
 * {@link PowerRTCChannel#bufferedAmount} inherits the same gate, and the tests
 * below cover the five cases RT-018's suite uses, so the trap cannot be
 * reintroduced here without a test going red.
 */

/**
 * A data channel that behaves as the platform promises: `bufferedAmount` rises
 * synchronously inside `send()`, and the transport **pushes**
 * `bufferedamountlow` once the buffer has drained back to the threshold.
 */
class DrainyDataChannel {
  constructor() {
    this.listeners = new Map();
    this.readyState = 'open';
    this.ordered = false;
    this.maxRetransmits = 0;
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sctp = { maxMessageSize: 1 << 20 };
    this.sent = [];
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
    this.bufferedAmount += data.byteLength;
    this.sent.push(data);
  }
  /** Model the transport draining: the buffer empties and the event is pushed. */
  drain() {
    this.bufferedAmount = 0;
    if (this.bufferedAmountLowThreshold > 0) {
      this.fire('bufferedamountlow', { type: 'bufferedamountlow' });
    }
  }
  close() {
    this.readyState = 'closed';
    this.fire('close', { type: 'close' });
  }
  /** RT-018's shape: a closed channel whose buffered amount never comes down. */
  strandBufferedAmount() {
    this.readyState = 'closed';
  }
}

const frame = (n) => new Uint8Array(n);

describe('the push signal replaces the poll timer', () => {
  it('arms the platform threshold from one option', () => {
    const dc = new DrainyDataChannel();
    new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    // **The whole mechanism.** The platform compares against this itself; the
    // client had to run a timer to notice the same thing.
    expect(dc.bufferedAmountLowThreshold).toBe(4096);
  });

  it('raises the flag on send and clears it from the event, with no timer', () => {
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    expect(channel.isBackpressured).toBe(false);

    // **Evaluated synchronously from the send path**, because the platform raises
    // `bufferedAmount` inside `send()`. A poll interval would have needed a
    // window in which this answer was wrong.
    channel.send(frame(4096));
    expect(channel.isBackpressured).toBe(false); // exactly at the mark is not above
    channel.send(frame(1));
    expect(channel.isBackpressured).toBe(true);
    expect(channel.stats().backpressureEvents).toBe(1);

    dc.drain();
    expect(channel.isBackpressured).toBe(false);
    expect(channel.stats().lowBufferEvents).toBe(1);
  });

  it('counts the transition into back-pressure once, not once per send', () => {
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 1024 });
    for (let i = 0; i < 5; i += 1) channel.send(frame(2048));
    // **The distinction is the counter's whole purpose.** Counting sends-while-
    // over-the-mark would report 5 and make the number agree with `sent` for no
    // reason; "how often did this channel back up" is the question a dashboard
    // asks, and it is 1.
    expect(channel.stats()).toMatchObject({ backpressureEvents: 1, sent: 5 });
  });

  it('stops serving a producer loop the way the client does', () => {
    // The usage the whole design exists for, run as a loop rather than described.
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    // Drained rather than shifted: the point is that a frame is only *offered*
    // once the producer is allowed to offer it, so a refused offer stays queued.
    const queue = [frame(3000), frame(3000), frame(3000), frame(3000)];
    let sent = 0;
    const pump = () => {
      while (queue.length && !channel.isBackpressured) {
        const next = queue[0];
        channel.send(next);
        queue.shift();
        sent += 1;
      }
    };
    pump();
    // Two frames: 6000 bytes buffered against a 4096 mark. The third is not
    // offered because the check happens **before** each send, so the flag is
    // already true when the loop reaches it.
    expect(sent).toBe(2);
    expect(queue).toHaveLength(2);
    expect(channel.isBackpressured).toBe(true);

    dc.drain();
    // Cleared by the event, not by anything this class scheduled.
    expect(channel.isBackpressured).toBe(false);
    pump();
    // The loop runs until the flag rises again, so it takes both: 3000 is under
    // the mark, 6000 is over it.
    expect(sent).toBe(4);
    expect(queue).toHaveLength(0);
    expect(channel.isBackpressured).toBe(true);

    // Nothing left to send, so the flag stays up until the transport drains —
    // the exact condition a stranded buffer would create, and the reason the
    // flag is cleared on close as well as on the event.
    dc.drain();
    expect(channel.isBackpressured).toBe(false);
  });

  it('uses exactly one watermark option, where the client needs four', () => {
    // A structural claim, asserted structurally. If this helper ever grows
    // `lowWaterMarkBytes` or a poll interval, the push signal stopped being
    // usable and this is the test that says so.
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    expect(channel.stats().highWaterMarkBytes).toBe(4096);
    for (const absent of ['lowWaterMarkBytes', 'pollIntervalMs', 'maxPollIntervalMs']) {
      expect(channel.stats(), absent).not.toHaveProperty(absent);
      expect(() => new PowerRTCChannel(new DrainyDataChannel(), { [absent]: 20 })).toThrow(
        /absent|unknown|not/i
      );
    }
  });

  it('highWaterMarkBytes: 0 disables without writing the platform property', () => {
    const dc = new DrainyDataChannel();
    dc.bufferedAmountLowThreshold = 123;
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 0 });
    // **Not overwritten with 0.** The platform default is 0, and a threshold of 0
    // makes `bufferedamountlow` fire whenever the buffer reaches empty — so
    // "disable the watermark" implemented as "write 0" would turn the push signal
    // into a metronome. `0` therefore leaves the caller's value alone and reports
    // no back-pressure at all.
    expect(dc.bufferedAmountLowThreshold).toBe(123);
    expect(channel.isBackpressured).toBe(false);
    channel.send(frame(1 << 20));
    expect(channel.isBackpressured).toBe(false);
    expect(channel.stats().backpressureEvents).toBe(0);
  });

  it('rejects a nonsensical watermark', () => {
    expect(() => new PowerRTCChannel(new DrainyDataChannel(), { highWaterMarkBytes: NaN })).toThrow(
      TypeError
    );
    expect(() => new PowerRTCChannel(new DrainyDataChannel(), { highWaterMarkBytes: -1 })).toThrow(
      TypeError
    );
  });
});

describe('RT-018: bufferedAmount is gated on open, so a producer cannot spin', () => {
  it('reads the real figure while open', () => {
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    channel.send(frame(3000));
    expect(channel.bufferedAmount).toBe(3000);
  });

  it('reports 0 the moment the channel is not open', () => {
    // **RT-018's fix, unchanged and re-tested here.** MDN documents that a
    // `WebSocket`'s `bufferedAmount` does not come back down after close;
    // `RTCSctpTransport.bufferedAmount` is the same shape of number with the same
    // "queued to be sent" meaning. A producer looping on `bufferedAmount >
    // highWaterMark` would therefore wait on a figure that never falls, with no
    // diagnostic — the review's "silent total failure" again, one layer down.
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    channel.send(frame(9000));
    expect(dc.bufferedAmount).toBe(9000);

    dc.fire('close', { type: 'close' });
    expect(channel.readyState).toBe(READY_STATE.CLOSED);
    expect(channel.bufferedAmount).toBe(0);
    // The platform's own field is untouched — the gate is the adapter's, not a
    // mutation of the caller's object.
    expect(dc.bufferedAmount).toBe(9000);
  });

  it('reports 0 for a channel that is connecting, never opening', () => {
    const dc = new DrainyDataChannel();
    dc.readyState = 'connecting';
    const channel = new PowerRTCChannel(dc);
    expect(channel.bufferedAmount).toBe(0);
    expect(channel.stats().bufferedAmount).toBe(0);
  });

  it('reports 0 after dispose, when the channel reference is gone', () => {
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc);
    channel.dispose();
    // `channel` is null after disposal, so an unguarded read would throw from a
    // getter a stats loop calls.
    expect(channel.bufferedAmount).toBe(0);
    expect(() => channel.stats()).not.toThrow();
  });

  it('reads a numeric string, and coerces an unreadable one to 0', () => {
    // The hazard is specific and it is worth being precise about, because a
    // vaguer version of this test would pass for the wrong reason.
    // `bufferedAmount > mark` with a `NaN` figure is **false**, so an unreadable
    // value reads as *never backed up* and silently defeats back-pressure — the
    // quieter and worse direction. A *numeric* string, by contrast, is read as
    // the number, which is correct: a platform reporting `'9000'` means 9000.
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    dc.bufferedAmount = Number.NaN;
    expect(channel.bufferedAmount).toBe(0);
    dc.bufferedAmount = 'not a number';
    expect(channel.bufferedAmount).toBe(0);
    dc.bufferedAmount = '9000';
    expect(channel.bufferedAmount).toBe(9000);
    dc.bufferedAmount = 8192;
    expect(channel.bufferedAmount).toBe(8192);
  });

  it('clears the flag on close, so a stranded buffer is not a permanent stall', () => {
    const dc = new DrainyDataChannel();
    const channel = new PowerRTCChannel(dc, { highWaterMarkBytes: 4096 });
    channel.send(frame(8192));
    expect(channel.isBackpressured).toBe(true);
    dc.strandBufferedAmount();
    dc.fire('close', { type: 'close' });
    // Without this, a stranded buffer would leave `isBackpressured` stuck true
    // forever with no event coming — the same infinite wait RT-018 found, reached
    // through the flag rather than through the number.
    expect(channel.isBackpressured).toBe(false);
  });

  it('never arms the listener when the watermark is off', () => {
    const dc = new DrainyDataChannel();
    const onLow = vi.fn();
    new PowerRTCChannel(dc, { highWaterMarkBytes: 0, onError: onLow });
    dc.drain();
    // Nothing to assert beyond "no crash and no number": with the watermark off
    // the platform has no threshold to push against, and this class does not
    // synthesise one.
    expect(onLow).not.toHaveBeenCalled();
  });
});
