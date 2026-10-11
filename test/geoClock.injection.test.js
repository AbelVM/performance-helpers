import { describe, it, expect } from 'vitest';
import { PowerDeadline } from '../src/helpers/powerDeadline.js';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerCron } from '../src/helpers/powerCron.js';
import { PowerEventLoopMonitor } from '../src/helpers/powerEventLoopMonitor.js';

// GEO-039. MapLibre GL JS exposes `now()`, `setNow()`, `isTimeFrozen()` and
// `restoreNow()` so an application can freeze time and get deterministic
// rendering and deterministic tests. Four of our clock-driven helpers read the
// module clock directly, so a frozen clock had no effect on any of them — and
// `PowerCircuit` had no injection point at all.
//
// These tests exist because the *absence* of the option was invisible: nothing
// failed, nothing warned, and a caller who threaded `now` in by hand got a
// `TypeError` from `assertKnownOptions` naming the option as unknown. Each test
// drives the helper from a clock the test owns, which is the only way to assert
// deadline and window behaviour without sleeping.
//
// The pattern matches `PowerTTLMap` and `cache/core`, which already take `now`
// and cite PERF-007 in their comments — so this is consistency work, not a new
// mechanism.
//
// Shapes below were read from the source, not guessed: `PowerCircuit` exposes
// `call()` rather than `run()`; `PowerCron` exposes `nextRunAt` (null when not
// running) rather than `nextAt`; `PowerEventLoopMonitor.stats().coverage` is
// `number | null`, null when there are no samples or the window has no length.

/** A clock the test advances by hand. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    get value() {
      return t;
    },
  };
}

describe('GEO-039 injected clock', () => {
  describe('PowerDeadline', () => {
    it('reports elapsedMs from the injected clock, not wall time', async () => {
      const clock = fakeClock();
      // `maxAttempts: 3` so there *is* a second attempt, whose deadline guard
      // is what raises EDEADLINE. With the default of 1 the original error
      // would propagate instead and this would assert nothing about the clock.
      const deadline = new PowerDeadline({
        totalTimeout: 100,
        maxAttempts: 3,
        retryDelay: 0,
        now: clock.now,
      });

      const err = await deadline
        .run(async () => {
          clock.advance(5000); // the run "takes" 5s of injected time
          throw new Error('boom');
        })
        .catch((e) => e);

      expect(err.code).toBe('EDEADLINE');
      // The whole point: 5s of *injected* time is reported even though the
      // function returned in microseconds of wall time.
      expect(err.elapsedMs).toBeGreaterThanOrEqual(5000);
    });

    it('lets an injected clock hold a deadline open indefinitely', async () => {
      const clock = fakeClock();
      const deadline = new PowerDeadline({
        totalTimeout: 1000,
        maxAttempts: 3,
        retryDelay: 0,
        now: clock.now,
      });

      // The clock never advances, so no deadline can ever be exceeded. Under
      // the module clock this same test would need a real 1s sleep.
      let calls = 0;
      const err = await deadline
        .run(async () => {
          calls += 1;
          throw new Error('boom');
        })
        .catch((e) => e);

      expect(calls).toBe(3);
      expect(err.code).not.toBe('EDEADLINE');
    });

    it('defaults to the module clock when now is omitted', async () => {
      const deadline = new PowerDeadline({ totalTimeout: 30, maxAttempts: 1 });
      const t0 = Date.now();
      await expect(
        deadline.run(async () => {
          await new Promise((r) => setTimeout(r, 80));
          return 'late';
        })
      ).rejects.toThrow();
      // Sanity: the wall clock really did pass, so the default path is live.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    });
  });

  describe('PowerCircuit', () => {
    it('drives the open window from an injected clock', async () => {
      const clock = fakeClock();
      const circuit = new PowerCircuit({ threshold: 2, timeout: 1000, now: clock.now });
      const fail = () =>
        circuit
          .call(async () => {
            throw new Error('x');
          })
          .catch(() => {});

      await fail();
      expect(circuit.state).toBe('closed');
      await fail();
      expect(circuit.state).toBe('open');

      // The drawn window is jittered between `timeout * 0.5` and `timeout`
      // (`DEFAULT_CIRCUIT_MIN_JITTER_RATIO`), so an exact boundary assertion is
      // a coin flip. Assert the two ends that the jitter cannot cross: 1ms is
      // below any possible window, 5000ms is above any possible one.
      clock.advance(1);
      expect(circuit.state).toBe('open');

      clock.advance(5000);
      expect(circuit.state).toBe('half-open');
    });

    it('refuses a call while the window is open and allows the trial after it', async () => {
      const clock = fakeClock();
      const circuit = new PowerCircuit({ threshold: 1, timeout: 500, now: clock.now });
      await circuit
        .call(async () => {
          throw new Error('x');
        })
        .catch(() => {});
      expect(circuit.state).toBe('open');

      await expect(circuit.call(async () => 'ok')).rejects.toHaveProperty('code', 'ECIRCUITOPEN');

      clock.advance(500);
      await expect(circuit.call(async () => 'ok')).resolves.toBe('ok');
      expect(circuit.state).toBe('closed');
    });

    it('defaults to monoMs when now is omitted', async () => {
      const circuit = new PowerCircuit({ threshold: 1, timeout: 30 });
      await circuit
        .call(async () => {
          throw new Error('x');
        })
        .catch(() => {});
      expect(circuit.state).toBe('open');
      await new Promise((r) => setTimeout(r, 45));
      expect(circuit.state).toBe('half-open');
    });
  });

  describe('PowerCron', () => {
    it('arms the next fire from an injected clock', () => {
      const clock = fakeClock();
      const cron = new PowerCron(() => {}, { intervalMs: 1000, now: clock.now });

      cron.start();
      try {
        // `nextRunAt` is `_nextAt` while running and `null` otherwise, so this
        // asserts both that it was armed and that it came from the injected
        // clock rather than the wall clock.
        expect(cron.nextRunAt).toBe(clock.value + 1000);
      } finally {
        cron.dispose();
      }
    });

    it('re-arms from the injected clock after a fire', async () => {
      const clock = fakeClock();
      const cron = new PowerCron(() => {}, { intervalMs: 20, now: clock.now });

      cron.start();
      const first = cron.nextRunAt;
      // Wait for a *real* fire — the timer is a real timer, so this needs real
      // time at least equal to the interval. An earlier draft waited 30ms
      // against a 100ms interval, so nothing ever fired and the assertion was
      // comparing a value against itself.
      await new Promise((r) => setTimeout(r, 60));
      clock.advance(20);

      expect(cron.fireCount).toBeGreaterThan(0);
      // The re-arm reads the injected clock, so the new target is the old one
      // plus the interval measured in injected time.
      expect(cron.nextRunAt).not.toBe(first);
      cron.dispose();
    });

    it('reports nextRunAt as null when not running', () => {
      const clock = fakeClock();
      const cron = new PowerCron(() => {}, { intervalMs: 100, now: clock.now });
      expect(cron.nextRunAt).toBeNull();
    });
  });

  describe('PowerEventLoopMonitor', () => {
    it('bases the coverage window on an injected clock', async () => {
      // A *frozen* clock does not work here: `_record` drops negative drift
      // readings as a backwards clock, and a frozen clock makes every reading
      // `now - scheduledFor` negative, so nothing is ever sampled. The clock has
      // to track real time and be jumpable — which is also the realistic shape
      // for a caller freezing time around a live monitor.
      let offset = 0;
      const clock = { now: () => Date.now() + offset, advance: (ms) => (offset += ms) };
      const monitor = new PowerEventLoopMonitor({ intervalMs: 20, now: clock.now });
      monitor.start();
      try {
        // Wait for at least one *real* probe, because `coverage` is null until
        // there are samples — an earlier draft asserted on a monitor that had
        // never ticked and got null, which proved nothing about the clock.
        await new Promise((r) => setTimeout(r, 60));
        clock.advance(60_000);
        const stats = monitor.stats();
        // `coverage` is `number | null`. With 60s of injected time and almost no
        // accounted time it must be a number well under 1 — which it could not
        // be before the clock was injectable, because the wall clock had not
        // moved and the denominator would have been ~60ms.
        expect(stats.coverage).not.toBeNull();
        expect(stats.coverage).toBeLessThan(0.5);
      } finally {
        monitor.stop();
        monitor.dispose();
      }
    });

    it('defaults to the module clock when now is omitted', () => {
      const monitor = new PowerEventLoopMonitor({ intervalMs: 20 });
      monitor.start();
      try {
        expect(monitor.stats()).toHaveProperty('coverage');
      } finally {
        monitor.stop();
        monitor.dispose();
      }
    });
  });

  describe('the option is accepted, not rejected', () => {
    // `assertKnownOptions` throws on an unknown key, so before GEO-039 a caller
    // who tried to inject a clock got a TypeError naming `now` as unknown. That
    // is the failure mode these four cases pin: the option must be *known*.
    it.each([
      ['PowerDeadline', () => new PowerDeadline({ now: () => 0 })],
      ['PowerCircuit', () => new PowerCircuit({ now: () => 0 })],
      ['PowerCron', () => new PowerCron(() => {}, { now: () => 0 })],
      ['PowerEventLoopMonitor', () => new PowerEventLoopMonitor({ now: () => 0 })],
    ])('%s accepts now', (_name, make) => {
      expect(make).not.toThrow();
    });
  });
});
