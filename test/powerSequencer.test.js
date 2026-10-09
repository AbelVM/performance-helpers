import { describe, it, expect } from 'vitest';
import { PowerSequencer } from '../src/helpers/powerSequencer.js';

// Every test here drives the sequencer directly rather than through a fake
// transport. It is a pure state machine with no timer, so there is nothing to
// fake and nothing to wait for — which is the point: a reassembler whose tests
// need a clock is a reassembler that has grown a retransmission policy it
// should not have.

describe('PowerSequencer', () => {
  describe('in-order delivery', () => {
    it('releases a contiguous run immediately', () => {
      const seen = [];
      const seq = new PowerSequencer({ onMessage: (s, p) => seen.push([s, p]) });
      expect(seq.push(0, 'a')).toBe(true);
      expect(seq.push(1, 'b')).toBe(true);
      expect(seq.push(2, 'c')).toBe(true);
      expect(seen).toEqual([
        [0, 'a'],
        [1, 'b'],
        [2, 'c'],
      ]);
      expect(seq.nextExpected).toBe(3);
    });

    it('releases several at once when a gap is filled', () => {
      // The whole reason this is not a one-deep buffer: datagrams 1 and 2
      // arrived early and were held, and filling 0 releases all three in one
      // pass rather than one per subsequent call.
      const seen = [];
      const seq = new PowerSequencer({ onMessage: (s) => seen.push(s) });
      seq.push(1, 'b');
      seq.push(2, 'c');
      expect(seen).toEqual([]);
      expect(seq.missing()).toEqual([0]);

      seq.push(0, 'a');
      expect(seen).toEqual([0, 1, 2]);
      expect(seq.missing()).toEqual([3]);
    });

    it('starts from startAt when the peer does not number from zero', () => {
      const seen = [];
      const seq = new PowerSequencer({ startAt: 100, onMessage: (s) => seen.push(s) });
      expect(seq.push(100, 'a')).toBe(true);
      expect(seq.push(101, 'b')).toBe(true);
      expect(seen).toEqual([100, 101]);
      expect(seq.nextExpected).toBe(102);
    });
  });

  describe('gap detection', () => {
    it('reports the missing number and fires onGap once', () => {
      const gaps = [];
      const seq = new PowerSequencer({ onGap: (s, missing) => gaps.push([s, missing]) });
      seq.push(0, 'a');
      seq.push(2, 'c');
      expect(gaps).toEqual([[2, [1]]]);
      expect(seq.missing()).toEqual([1]);
    });

    it('does not re-fire onGap for datagrams inside an existing gap', () => {
      // Firing per datagram would turn one gap into a storm of callbacks, and
      // the NACK they trigger is per gap, not per arrival.
      const gaps = [];
      const seq = new PowerSequencer({ onGap: (s) => gaps.push(s) });
      seq.push(0, 'a');
      seq.push(3, 'd');
      seq.push(4, 'e');
      seq.push(5, 'f');
      expect(gaps).toEqual([3]);
      expect(seq.stats().gapsOpened).toBe(1);
    });

    it('fires again for a genuinely new gap', () => {
      const gaps = [];
      const seq = new PowerSequencer({ onGap: (s) => gaps.push(s) });
      seq.push(0, 'a');
      seq.push(2, 'c'); // gap at 1
      seq.push(1, 'b'); // fills it, releases 0,1,2
      seq.push(4, 'e'); // new gap at 3
      expect(gaps).toEqual([2, 4]);
      expect(seq.stats().gapsOpened).toBe(2);
    });

    it('reports only the first absent number as missing', () => {
      // `missing()` is the NACK payload. Reporting every number above the gap
      // would ask the peer to retransmit datagrams that are already buffered
      // here and merely waiting.
      const seq = new PowerSequencer();
      seq.push(0, 'a');
      seq.push(2, 'c');
      seq.push(3, 'd');
      expect(seq.missing()).toEqual([1]);
      expect(seq.buffered).toBe(2);
    });
  });
});

describe('PowerSequencer refusals, reset and lifecycle', () => {
  describe('refusals', () => {
    it('counts a duplicate rather than buffering it twice', () => {
      const seen = [];
      const seq = new PowerSequencer({ onMessage: (s) => seen.push(s) });
      seq.push(0, 'a');
      expect(seq.push(0, 'a-again')).toBe(false);
      expect(seen).toEqual([0]);
      expect(seq.stats().duplicates).toBe(1);
      expect(seq.buffered).toBe(0);
    });

    it('counts a datagram below nextExpected as a duplicate', () => {
      // A retransmission of something already released. Normal on a lossy link,
      // and a climbing rate is the signal the NACK path is misbehaving.
      const seq = new PowerSequencer();
      seq.push(0, 'a');
      seq.push(1, 'b');
      expect(seq.push(0, 'stale')).toBe(false);
      expect(seq.stats().duplicates).toBe(1);
    });

    it('refuses a datagram beyond the window', () => {
      // Buffering it would let a peer that jumped ahead grow this without
      // limit, which is the failure the window exists to prevent.
      //
      // The window is measured from `next`, which **advances** as messages are
      // released — so after `push(0)` releases, `next` is 1 and the window is
      // [1, 5). My first draft of this test expected `push(4)` to be refused
      // and it was not, because I had forgotten the release had moved the
      // window. Pinning the arithmetic rather than the intuition.
      const seq = new PowerSequencer({ windowSize: 4 });
      expect(seq.push(0, 'a')).toBe(true);
      expect(seq.nextExpected).toBe(1);
      expect(seq.push(4, 'e')).toBe(true); // 4 < 1 + 4
      expect(seq.push(5, 'f')).toBe(false); // 5 >= 1 + 4
      expect(seq.stats().outOfWindow).toBe(1);
    });

    it('accepts the last datagram inside the window', () => {
      // The boundary is `next + windowSize`, exclusive. Off-by-one here either
      // refuses a datagram the window was sized for or admits one past it.
      const seq = new PowerSequencer({ windowSize: 4 });
      expect(seq.push(3, 'd')).toBe(true);
      expect(seq.push(4, 'e')).toBe(false);
    });

    it('rejects a fractional sequence number rather than renumbering it', () => {
      // `Math.floor` would silently shift every message after it, which is a
      // corruption with no error — the exact failure this library refuses
      // elsewhere.
      const seq = new PowerSequencer();
      expect(() => seq.push(1.5, 'x')).toThrow(/must be an integer/);
      expect(() => seq.push(Number.NaN, 'x')).toThrow(/must be an integer/);
    });
  });

  describe('validation', () => {
    it('accepts a bare number as the window size', () => {
      const seq = new PowerSequencer(8);
      expect(seq.stats().windowSize).toBe(8);
    });

    it('rejects a window below 1', () => {
      // A window of 0 would refuse every datagram including the expected one,
      // so the sequencer would be inert rather than merely strict.
      expect(() => new PowerSequencer({ windowSize: 0 })).toThrow(/>= 1/);
    });

    it('rejects an unknown option', () => {
      expect(() => new PowerSequencer({ windowSize: 8, windowSze: 8 })).toThrow(/unknown option/);
    });

    it('rejects a non-integer startAt', () => {
      expect(() => new PowerSequencer({ startAt: 1.5 })).toThrow(/whole number/);
    });
  });

  describe('handler isolation', () => {
    it('keeps releasing when onMessage throws', () => {
      // The messages behind a throwing handler are already contiguous.
      // Abandoning the walk would leave them buffered forever behind a gap that
      // no longer exists — a permanent stall with `missing()` reporting nothing,
      // which is the hardest kind of bug to see from outside.
      const seen = [];
      const seq = new PowerSequencer({
        onMessage: (s) => {
          if (s === 1) throw new Error('boom');
          seen.push(s);
        },
      });
      expect(() => seq.push(0, 'a')).not.toThrow();
      expect(() => seq.push(1, 'b')).not.toThrow();
      expect(() => seq.push(2, 'c')).not.toThrow();
      expect(seen).toEqual([0, 2]);
      expect(seq.nextExpected).toBe(3);
      expect(seq.missing()).toEqual([3]);
    });

    it('keeps accepting when onGap throws', () => {
      const seq = new PowerSequencer({
        onGap: () => {
          throw new Error('boom');
        },
      });
      expect(() => seq.push(1, 'b')).not.toThrow();
      expect(seq.buffered).toBe(1);
    });
  });

  describe('reset and clear', () => {
    it('resumes from startAt, not from zero', () => {
      // Restarting at 0 on a peer whose numbering began at 100 would make every
      // subsequent datagram read as out-of-window.
      const seq = new PowerSequencer({ startAt: 100 });
      seq.push(100, 'a');
      seq.push(101, 'b');
      seq.reset();
      expect(seq.nextExpected).toBe(100);
      expect(seq.buffered).toBe(0);
      expect(seq.push(100, 'a2')).toBe(true);
    });

    it('clears the counters', () => {
      const seq = new PowerSequencer();
      seq.push(0, 'a');
      seq.push(0, 'dup');
      seq.push(99, 'far');
      expect(seq.stats().delivered).toBe(1);
      seq.reset();
      expect(seq.stats()).toMatchObject({
        delivered: 0,
        duplicates: 0,
        outOfWindow: 0,
        gapsOpened: 0,
        buffered: 0,
      });
    });

    it('clear is an alias of reset', () => {
      const seq = new PowerSequencer();
      seq.push(1, 'b');
      seq.clear();
      expect(seq.buffered).toBe(0);
      expect(seq.nextExpected).toBe(0);
    });
  });

  describe('disposal', () => {
    it('is a state reset, because this helper owns no timer', () => {
      // The dispose rule's second half. A sequencer is a pure state machine, so
      // there is nothing to cancel — and describing `dispose()` as "cancels the
      // interval" would document work that is not happening.
      const seq = new PowerSequencer();
      seq.push(1, 'b');
      seq.dispose();
      expect(seq.buffered).toBe(0);
      expect(seq.nextExpected).toBe(0);
    });

    it('refuses pushes after dispose', () => {
      const seq = new PowerSequencer();
      seq.dispose();
      expect(seq.push(0, 'a')).toBe(false);
    });

    it('is idempotent', () => {
      const seq = new PowerSequencer();
      seq.dispose();
      expect(() => seq.dispose()).not.toThrow();
    });

    it('supports using and await using', () => {
      {
        using s = new PowerSequencer();
        s.push(1, 'b');
        expect(s.buffered).toBe(1);
      }
      expect(typeof PowerSequencer.prototype[Symbol.dispose]).toBe('function');
      expect(typeof PowerSequencer.prototype[Symbol.asyncDispose]).toBe('function');
    });
  });

  describe('stats', () => {
    it('reports the shape a caller would alert on', () => {
      const seq = new PowerSequencer({ windowSize: 8 });
      seq.push(0, 'a'); // released; next -> 1
      seq.push(2, 'c'); // buffered; opens the gap at 1
      seq.push(2, 'dup'); // duplicate
      seq.push(99, 'far'); // out of window (1 + 8 = 9)
      expect(seq.stats()).toEqual({
        nextExpected: 1,
        buffered: 1,
        missing: 1,
        delivered: 1,
        duplicates: 1,
        outOfWindow: 1,
        gapsOpened: 1,
        windowSize: 8,
      });
    });

    it('getStats is an alias of stats', () => {
      const seq = new PowerSequencer();
      expect(seq.getStats()).toEqual(seq.stats());
    });
  });

  describe('metrics', () => {
    it('registers and detaches like every other helper', () => {
      // The attach/detach symmetry B2 audited family-wide. A sequencer added
      // without it would be the tenth helper the source-count guard catches.
      const seq = new PowerSequencer({ observability: true });
      expect(seq._metrics).not.toBeNull();
      seq.dispose();
      expect(seq._metrics).toBeNull();
    });

    it('attaches nothing by default', () => {
      const seq = new PowerSequencer();
      expect(seq._metrics).toBeNull();
    });
  });
});
