import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerHeartbeat } from '../src/helpers/powerHeartbeat.js';

// Every test here drives the injected clock and fake timers rather than
// wall-clock durations. A heartbeat is a timer, and a test that waits on a
// real one is a test that fails on a loaded CI machine for a reason that has
// nothing to do with the defect it names.

describe('PowerHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it('accepts a bare number as the interval', () => {
      // The shorthand is what every other helper here takes, and a caller who
      // writes `new PowerHeartbeat(1000)` getting a 30s default instead would
      // be failed for a peer that is beating perfectly.
      const hb = new PowerHeartbeat(1000);
      expect(hb.isRunning()).toBe(false);
      hb.dispose();
    });

    it('rejects a jitter above 1', () => {
      // `jitter: 2` schedules the next check in the past, so the timer fires
      // immediately and the decorrelation inverts into a busy loop. This is
      // the one option whose out-of-range value is not merely useless.
      expect(() => new PowerHeartbeat({ interval: 1000, jitter: 2 })).toThrow(/jitter.*0\.\.1/);
    });

    it('rejects an unknown option', () => {
      // `intervall` is a real misspelling of a real option, and the whole
      // point of assertKnownOptions is that it is caught here rather than
      // silently defaulting to 30s.
      expect(() => new PowerHeartbeat({ intervall: 1000 })).toThrow(/unknown option/);
    });

    it('derives the timeout from the interval when omitted', () => {
      // A caller who sets only `interval` expects a missed beat to be caught;
      // a default of `Infinity` would make the helper inert.
      const hb = new PowerHeartbeat({ interval: 1000 });
      hb.start();
      hb.beat();
      vi.advanceTimersByTime(1999);
      expect(hb.timedOut).toBe(false);
      vi.advanceTimersByTime(2);
      expect(hb.timedOut).toBe(true);
      hb.dispose();
    });
  });

  describe('liveness', () => {
    it('does not time out while beats keep arriving', () => {
      const hb = new PowerHeartbeat({ interval: 100, timeout: 500 });
      hb.start();
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(100);
        hb.beat();
      }
      expect(hb.timedOut).toBe(false);
      expect(hb.missedBeats).toBe(0);
      hb.dispose();
    });

    it('fires onTimeout once per missed check, with the counters', () => {
      const seen = [];
      const hb = new PowerHeartbeat({
        interval: 100,
        timeout: 250,
        onTimeout: (missed, last) => seen.push([missed, last]),
      });
      hb.start();
      hb.beat();
      vi.advanceTimersByTime(1000);
      // Four checks at 100ms each find no beat after the 250ms deadline.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0][0]).toBe(1);
      expect(seen[seen.length - 1][0]).toBe(seen.length);
      hb.dispose();
    });

    it('stops firing onTimeout after a beat, and reports recovery', () => {
      // The recovery path is the one that matters: a peer that comes back must
      // clear `timedOut`, or the caller reconnects forever against a peer that
      // is answering.
      const hb = new PowerHeartbeat({ interval: 100, timeout: 250 });
      hb.start();
      hb.beat();
      vi.advanceTimersByTime(400);
      expect(hb.timedOut).toBe(true);
      hb.beat();
      expect(hb.timedOut).toBe(false);
      expect(hb.missedBeats).toBe(0);
      vi.advanceTimersByTime(400);
      expect(hb.timedOut).toBe(true);
      hb.dispose();
    });

    it('counts a peer that never beat as immediately overdue', () => {
      // `lastBeatAt === 0` means "no beat ever". Treating that as `now - 0`
      // would compare against the epoch and pass for ~56 years, so the first
      // check must treat it as infinitely stale.
      const hb = new PowerHeartbeat({ interval: 100, timeout: 250 });
      hb.start();
      vi.advanceTimersByTime(100);
      expect(hb.timedOut).toBe(true);
      hb.dispose();
    });

    it('fires onBeat with the timestamp', () => {
      const beats = [];
      const hb = new PowerHeartbeat({ interval: 100, onBeat: (t) => beats.push(t) });
      hb.beat();
      hb.beat();
      expect(beats).toHaveLength(2);
      expect(typeof beats[0]).toBe('number');
      hb.dispose();
    });
  });

  describe('start/stop', () => {
    it('is idempotent on start', () => {
      // A second `start()` must not reset the deadline. The caller that
      // re-enters `start()` after a reconnect would otherwise postpone the
      // very deadline it is trying to enforce.
      const hb = new PowerHeartbeat({ interval: 100, timeout: 250 });
      hb.start();
      hb.beat();
      vi.advanceTimersByTime(200);
      hb.start();
      vi.advanceTimersByTime(100);
      expect(hb.timedOut).toBe(true);
      hb.dispose();
    });

    it('stops scheduling after stop()', () => {
      const hb = new PowerHeartbeat({ interval: 100, timeout: 250 });
      hb.start();
      hb.beat();
      hb.stop();
      vi.advanceTimersByTime(10000);
      expect(hb.timedOut).toBe(false);
      expect(hb.isRunning()).toBe(false);
      hb.dispose();
    });

    it('resumes the same deadline after stop/start', () => {
      // State survives a stop, so a stop/start pair does not grant the peer a
      // fresh timeout it did not earn.
      const hb = new PowerHeartbeat({ interval: 100, timeout: 250 });
      hb.start();
      hb.beat();
      vi.advanceTimersByTime(200);
      hb.stop();
      vi.advanceTimersByTime(10000);
      hb.start();
      vi.advanceTimersByTime(100);
      expect(hb.timedOut).toBe(true);
      hb.dispose();
    });
  });

  describe('jitter', () => {
    it('keeps the mean interval and never schedules in the past', () => {
      // Jitter decorrelates a fleet; it must not change the mean rate, and a
      // negative delay would fire the check immediately.
      const hb = new PowerHeartbeat({ interval: 1000, jitter: 0.5 });
      const delays = [];
      for (let i = 0; i < 200; i++) {
        delays.push(hb._nextDelay());
      }
      const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(500);
      expect(Math.max(...delays)).toBeLessThanOrEqual(1500);
      expect(mean).toBeGreaterThan(900);
      expect(mean).toBeLessThan(1100);
      hb.dispose();
    });

    it('produces more than one distinct delay', () => {
      // A jitter that always returns the same number is not jitter, and the
      // lockstep it exists to prevent would still happen.
      const hb = new PowerHeartbeat({ interval: 1000, jitter: 0.5 });
      const distinct = new Set();
      for (let i = 0; i < 50; i++) distinct.add(hb._nextDelay());
      expect(distinct.size).toBeGreaterThan(1);
      hb.dispose();
    });

    it('is a no-op at jitter 0', () => {
      const hb = new PowerHeartbeat({ interval: 1000, jitter: 0 });
      for (let i = 0; i < 20; i++) expect(hb._nextDelay()).toBe(1000);
      hb.dispose();
    });
  });

  describe('disposal', () => {
    it('clears the timer so the process can exit', () => {
      // This helper owns a timer. A heartbeat left scheduled after its owner
      // is gone keeps the event loop alive, which is the defect the dispose
      // rule exists to prevent.
      const hb = new PowerHeartbeat({ interval: 100 });
      hb.start();
      expect(vi.getTimerCount()).toBe(1);
      hb.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops firing callbacks after dispose', () => {
      let calls = 0;
      const hb = new PowerHeartbeat({
        interval: 100,
        timeout: 250,
        onTimeout: () => {
          calls += 1;
        },
      });
      hb.start();
      hb.beat();
      hb.dispose();
      vi.advanceTimersByTime(10000);
      expect(calls).toBe(0);
    });

    it('is idempotent', () => {
      const hb = new PowerHeartbeat({ interval: 100 });
      hb.dispose();
      expect(() => hb.dispose()).not.toThrow();
    });

    it('supports using / await using', async () => {
      // The interface is identical to every other long-lived helper here; the
      // reason it exists is that a heartbeat is exactly the thing a DI
      // teardown holds.
      {
        using hb = new PowerHeartbeat({ interval: 100 });
        hb.start();
        expect(vi.getTimerCount()).toBe(1);
      }
      expect(vi.getTimerCount()).toBe(0);

      {
        await using hb = new PowerHeartbeat({ interval: 100 });
        hb.start();
        expect(vi.getTimerCount()).toBe(1);
      }
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores beat() after dispose', () => {
      // A late beat from a peer whose owner is gone must not resurrect the
      // schedule.
      const hb = new PowerHeartbeat({ interval: 100 });
      hb.start();
      hb.dispose();
      hb.beat();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('callback isolation', () => {
    it('keeps scheduling when onTimeout throws', () => {
      // One bad callback must not stop the schedule: the next check is what
      // eventually reports a peer that recovered, and losing it turns a
      // throwing handler into a silent heartbeat.
      let calls = 0;
      const hb = new PowerHeartbeat({
        interval: 100,
        timeout: 250,
        onTimeout: () => {
          calls += 1;
          throw new Error('boom');
        },
      });
      hb.start();
      hb.beat();
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(calls).toBeGreaterThan(1);
      hb.dispose();
    });

    it('replaces the handler registered via onTimeout()', () => {
      // The method form exists for the object built before the thing that
      // knows how to react; it must replace, not append.
      const first = vi.fn();
      const second = vi.fn();
      const hb = new PowerHeartbeat({ interval: 100, timeout: 250 });
      hb.onTimeout(first);
      hb.onTimeout(second);
      hb.start();
      hb.beat();
      vi.advanceTimersByTime(400);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
      hb.dispose();
    });
  });

  describe('injected clock', () => {
    it('uses now() for the deadline rather than the timer', () => {
      // The deadline is measured from the last beat, not from when the timer
      // happened to fire, so a slow event loop cannot fail a healthy peer.
      let t = 1000;
      const hb = new PowerHeartbeat({
        interval: 100,
        timeout: 250,
        now: () => t,
      });
      hb.start();
      hb.beat();
      t = 1249;
      vi.advanceTimersByTime(100);
      expect(hb.timedOut).toBe(false);
      t = 1250;
      vi.advanceTimersByTime(100);
      expect(hb.timedOut).toBe(true);
      hb.dispose();
    });
  });
});
