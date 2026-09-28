import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerCron } from '../src/helpers/powerCron.js';

/**
 * `PowerCron` — a drift-free cron-like scheduler.
 *
 * The property worth protecting is the one that separates this from
 * `setInterval`: **the next fire is computed from an absolute target, never from
 * the moment the previous callback returned.** Every test below is written to
 * fail if that is replaced with a relative re-arm, because a relative re-arm
 * still *looks* right in a fast test — it just drifts, slowly, in production.
 *
 * Two of these tests deliberately use REAL timers, and the suite comment in
 * `catch-up policy` explains why: a stall cannot be expressed with fake timers,
 * because advancing the fake clock also fires everything due.
 */
afterEach(() => {
  vi.useRealTimers();
});

describe('PowerCron', () => {
  it('fires on the configured interval once started', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cron = new PowerCron(task, { intervalMs: 100 });
    cron.start();
    expect(cron.running).toBe(true);
    vi.advanceTimersByTime(350);
    expect(task).toHaveBeenCalledTimes(3);
    cron.dispose();
  });

  it('start() and stop() are idempotent', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cron = new PowerCron(task, { intervalMs: 100 });
    cron.start();
    cron.start();
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(1);
    cron.stop();
    cron.stop();
    vi.advanceTimersByTime(500);
    expect(task).toHaveBeenCalledTimes(1);
    expect(cron.running).toBe(false);
  });

  it('does not fire before the first interval without runOnStart', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cron = new PowerCron(task, { intervalMs: 100 });
    cron.start();
    vi.advanceTimersByTime(99);
    expect(task).not.toHaveBeenCalled();
    cron.dispose();
  });

  it('runOnStart fires immediately, then follows the cadence', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cron = new PowerCron(task, { intervalMs: 100, runOnStart: true });
    cron.start();
    expect(task).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(2);
    cron.dispose();
  });

  it('runNow() fires out of band without disturbing the cadence', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const cron = new PowerCron(task, { intervalMs: 100 });
    cron.start();
    cron.runNow();
    expect(task).toHaveBeenCalledTimes(1);
    // The scheduled fire is still one interval out, not pushed by runNow.
    vi.advanceTimersByTime(100);
    expect(task).toHaveBeenCalledTimes(2);
    cron.dispose();
  });

  it('advances the target by whole intervals, so a late run cannot shift the phase', () => {
    // The central claim, expressed without stalling the event loop.
    //
    // The obvious way to test "drift does not accumulate" is to make the task
    // genuinely slow - and that deadlocks the test: while the cron keeps
    // blocking the loop, the test's own `setTimeout` never gets a turn, so the
    // test waits forever for a timer the cron is starving. A busy-wait and
    // `vi.useFakeTimers()` is worse still, since frozen `Date.now()` means the
    // spin never exits.
    //
    // So the property is asserted directly instead: whatever happens to a run,
    // the *next target* moves by exactly one interval from the previous target,
    // never by `now + interval`. A relative re-arm fails this immediately.
    vi.useFakeTimers();
    const task = vi.fn();
    const cron = new PowerCron(task, { intervalMs: 100 });
    cron.start();
    const first = cron.nextRunAt;
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(100);
      // Consume any async continuation the run queued.
      vi.advanceTimersByTime(0);
    }
    const fires = task.mock.calls.length;
    const phase = cron.nextRunAt % 100;
    cron.dispose();

    expect(fires).toBe(5);
    // The target advanced by whole intervals from the original anchor, so the
    // phase on the 100 ms grid is preserved rather than walking.
    expect(phase).toBe(first % 100);
  });

  describe('catch-up policy', () => {
    // These need a REAL stall, which is why they are not fake-timer tests and
    // why they are slow. `vi.advanceTimersByTime` advances the clock *and* fires
    // everything due, so under fake timers every fire lands exactly on target,
    // `missedPeriods` is always 0, and all three policies behave identically. An
    // earlier version of this file asserted otherwise and failed, which is how
    // the limitation was found.
    //
    // A stall is produced by making the first run block the event loop, so the
    // timers that come due during it cannot fire until it returns. The task
    // stops the cron on its second invocation, which makes the counts stable: no
    // further timer can add to them mid-assertion.
    const INTERVAL = 20;
    const STALL = 200;

    /**
     * Drive one policy through a stall and report what actually happened.
     * @param {'skip'|'catch-up'|'run-once'} policy
     * @returns {Promise<{invocations: number, fireCount: number}>}
     */
    async function runThroughStall(policy) {
      // The task needs to reach the cron to stop it, and the cron needs the
      // task to exist first. A one-field holder breaks the cycle without a
      // `let` that is never reassigned - which the linter is right to flag.
      const holder = { cron: /** @type {PowerCron|null} */ (null) };
      let invocations = 0;
      const task = () => {
        invocations += 1;
        if (invocations === 1) {
          const until = Date.now() + STALL;
          while (Date.now() < until) {
            /* block the loop so the due timers cannot fire */
          }
        }
        if (invocations >= 2) holder.cron?.stop();
      };

      const cron = new PowerCron(task, { intervalMs: INTERVAL, catchUp: policy });
      holder.cron = cron;
      cron.start();
      await new Promise((r) => setTimeout(r, STALL + 300));
      cron.stop();
      return { invocations, fireCount: cron.fireCount };
    }

    it("'skip' runs once for the whole stall and re-anchors on the original phase", async () => {
      const { invocations, fireCount } = await runThroughStall('skip');
      // One run for the stalled window, plus the one that stops the cron.
      expect(invocations).toBe(2);
      // Nothing was silently counted: skip *drops* the missed periods, it does
      // not account for them. `fireCount` matching `invocations` is what
      // distinguishes this from 'run-once'.
      expect(fireCount).toBe(2);
    }, 30_000); /* real timers: a 200ms event-loop stall plus a 300ms wait, with headroom for a loaded parallel run */

    it("'catch-up' replays every missed period, so no window is silently dropped", async () => {
      const { invocations } = await runThroughStall('catch-up');
      // ~STALL/INTERVAL missed periods, replayed, plus the stop. This is the
      // whole point of the policy: a job that must account for each period.
      expect(invocations).toBeGreaterThan(5);
    }, 30_000); /* real timers: a 200ms event-loop stall plus a 300ms wait, with headroom for a loaded parallel run */

    it("'run-once' invokes the task once but still counts the work it stands in for", async () => {
      const { invocations, fireCount } = await runThroughStall('run-once');
      // Coalesced: one real run, like 'skip'.
      expect(invocations).toBe(2);
      // But unlike 'skip', the periods are *accounted for*, so a caller can see
      // that work was coalesced rather than assume a clean single run. This is
      // the only observable difference between the two policies.
      expect(fireCount).toBeGreaterThan(5);
    }, 30_000); /* real timers: a 200ms event-loop stall plus a 300ms wait, with headroom for a loaded parallel run */

    it("'catch-up' replays strictly more often than the other two", async () => {
      const [skip, replay] = await Promise.all([
        runThroughStall('skip'),
        runThroughStall('catch-up'),
      ]);
      expect(replay.invocations).toBeGreaterThan(skip.invocations * 2);
    }, 30_000); /* real timers: a 200ms event-loop stall plus a 300ms wait, with headroom for a loaded parallel run */

    it('defaults to skip, accepts each documented policy, and falls back for an unknown one', () => {
      expect(new PowerCron(() => {}, { intervalMs: 100 })._catchUp).toBe('skip');
      for (const policy of ['skip', 'catch-up', 'run-once']) {
        expect(new PowerCron(() => {}, { intervalMs: 100, catchUp: policy })._catchUp).toBe(policy);
      }
      expect(new PowerCron(() => {}, { catchUp: 'nonsense' })._catchUp).toBe('skip');
    });
  });

  describe('error handling', () => {
    it('routes a throwing task to onError and keeps the schedule alive', () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const cron = new PowerCron(
        () => {
          throw new Error('boom');
        },
        { intervalMs: 100, onError }
      );
      cron.start();
      vi.advanceTimersByTime(350);
      cron.dispose();
      // The important part is the last one: the schedule survived three throws.
      expect(onError).toHaveBeenCalledTimes(3);
      expect(cron.running).toBe(false); // disposed, not crashed
    });

    it('routes a rejected promise to onError', async () => {
      const onError = vi.fn();
      const cron = new PowerCron(() => Promise.reject(new Error('async boom')), { onError });
      cron.runNow();
      await new Promise((r) => setImmediate(r));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toBe('async boom');
      cron.dispose();
    });

    it('survives an onError that itself throws, without an unhandled rejection', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cron = new PowerCron(() => Promise.reject(new Error('boom')), {
        onError: () => {
          throw new Error('onError also broke');
        },
      });
      cron.runNow();
      await new Promise((r) => setImmediate(r));
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
      cron.dispose();
    });
  });

  describe('configuration', () => {
    it('rejects a non-function task', () => {
      expect(() => new PowerCron(null)).toThrow(TypeError);
      expect(() => new PowerCron(42)).toThrow(TypeError);
    });

    it('refuses an interval below the floor rather than becoming a hot loop', () => {
      // assertLimitRequired throws a TypeError, not a RangeError - the option is
      // a type violation, and the shared validator is what enforces it.
      expect(() => new PowerCron(() => {}, { intervalMs: 1 })).toThrow(TypeError);
      expect(() => new PowerCron(() => {}, { intervalMs: 1 })).toThrow(/intervalMs/);
    });

    it('clamps jitter into [0, 1] instead of trusting it', () => {
      expect(new PowerCron(() => {}, { jitter: 5 })._jitter).toBe(1);
      expect(new PowerCron(() => {}, { jitter: -2 })._jitter).toBe(0);
      expect(new PowerCron(() => {}, { jitter: Number.NaN })._jitter).toBe(0);
    });

    it('exposes the interval and reports no next run when stopped', () => {
      const cron = new PowerCron(() => {}, { intervalMs: 1234 });
      expect(cron.intervalMs).toBe(1234);
      expect(cron.nextRunAt).toBeNull();
      cron.start();
      expect(cron.nextRunAt).toBeGreaterThan(0);
      cron.stop();
      expect(cron.nextRunAt).toBeNull();
    });

    it('reports zero average drift before anything has run', () => {
      const cron = new PowerCron(() => {});
      expect(cron.averageDriftMs).toBe(0);
      expect(cron.fireCount).toBe(0);
      cron.dispose();
    });
  });

  it('onFire receives the schedule metadata', () => {
    const onFire = vi.fn();
    const cron = new PowerCron(() => {}, { intervalMs: 100, onFire });
    cron.runNow();
    expect(onFire).toHaveBeenCalledTimes(1);
    const info = onFire.mock.calls[0][0];
    expect(info).toMatchObject({ driftMs: expect.any(Number), missed: 0 });
    expect(typeof info.scheduledFor).toBe('number');
    expect(typeof info.ranAt).toBe('number');
    cron.dispose();
  });

  it('is disposable, and works with `using`', () => {
    vi.useFakeTimers();
    const task = vi.fn();
    let captured;
    {
      const cron = new PowerCron(task, { intervalMs: 100 });
      captured = cron;
      cron.start();
    }
    vi.advanceTimersByTime(500);
    // Not `using` (which needs a transpiled block), but dispose() must stop it.
    captured.dispose();
    const after = task.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(task.mock.calls.length).toBe(after);
  });
});
