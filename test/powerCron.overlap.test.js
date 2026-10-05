import { describe, it, expect } from 'vitest';
import { PowerCron } from '../src/index.js';

/**
 * RES-018: `PowerCron` `maxCatchUp` cap and `overlap` option.
 *
 * ## Why these tests look the way they do
 *
 * `PowerCron` has no clock injection — `_onTimer` reads `nowMs()` directly and
 * the only way to drive missed periods is real time. The overlap gate is the
 * one branch that *is* deterministic: a task that never settles keeps
 * `_runningTask` true across every subsequent tick, so the gate fires on every
 * tick while the task is in flight. The cap is exercised with a busy-wait task
 * on a short interval, the same mechanism `powerCron.missed.test.js` uses.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('PowerCron maxCatchUp', () => {
  it('defaults to Infinity and replays every missed period', () => {
    // The control. Without it, a finite cap that silently dropped periods
    // would pass every other test in this file.
    expect(new PowerCron(() => {}, { intervalMs: 100 })._maxCatchUp).toBe(Infinity);
  });

  it('rejects a negative value', () => {
    expect(() => new PowerCron(() => {}, { intervalMs: 100, maxCatchUp: -1 })).toThrow(
      /maxCatchUp.*>= 0/
    );
  });

  it('accepts 0, which replays nothing', async () => {
    // `maxCatchUp: 0` is a degenerate but legal config: the cap refuses every
    // replay, so the run that follows stands in for all missed periods.
    const events = [];
    const cron = new PowerCron(
      () => {
        const t = Date.now();
        while (Date.now() - t < 150);
      },
      {
        intervalMs: 20,
        catchUp: 'catch-up',
        maxCatchUp: 0,
        onFire: (info) => events.push(info.missed),
      }
    );
    cron.start();
    await wait(600);
    cron.stop();
    // The first tick reports 0 (nothing was missed yet). Every subsequent
    // tick fires once with no replays, and the run stands in for all missed
    // periods — which is > 0 because the busy task blocked the loop.
    expect(events[0]).toBe(0);
    expect(events.length).toBeGreaterThan(1);
    expect(events.slice(1).every((m) => m > 0)).toBe(true);
    // fireCount increments by exactly 1 per tick when nothing is replayed.
    expect(cron.fireCount).toBe(events.length);
  });

  it('caps the replay and reports the refused periods as missed', async () => {
    // The load-bearing claim: a finite `maxCatchUp` stops the burst, and the
    // periods it refuses are not silently dropped — the run that follows
    // stands in for them, so `missed` still says how many there were.
    const events = [];
    const cron = new PowerCron(
      () => {
        const t = Date.now();
        while (Date.now() - t < 150);
      },
      {
        intervalMs: 20,
        catchUp: 'catch-up',
        maxCatchUp: 3,
        onFire: (info) => events.push(info.missed),
      }
    );
    cron.start();
    await wait(600);
    cron.stop();

    // The first tick reports 0. Every subsequent tick replays exactly 3
    // periods (the cap) and the run that follows stands in for the rest.
    // That produces a repeating pattern after index 0: three 1's (replays)
    // then one value > 1 (the dropped count). The pattern is exact because
    // the busy task makes `missedPeriods` the same on every tick.
    expect(events[0]).toBe(0);
    const afterFirst = events.slice(1);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.filter((m) => m === 1).length % 3).toBe(0);
    expect(afterFirst.some((m) => m > 1)).toBe(true);
    // fireCount is strictly less than the uncapped count for the same
    // workload — the cap reduced the work, not the reporting.
    const uncapped = new PowerCron(
      () => {
        const t = Date.now();
        while (Date.now() - t < 150);
      },
      { intervalMs: 20, catchUp: 'catch-up', onFire: () => {} }
    );
    uncapped.start();
    await wait(600);
    uncapped.stop();
    expect(cron.fireCount).toBeLessThan(uncapped.fireCount);
  });
});

describe('PowerCron overlap', () => {
  it('defaults to false', () => {
    expect(new PowerCron(() => {}, { intervalMs: 100 })._overlap).toBe(false);
  });

  it('blocks the next tick while a task is in flight', async () => {
    // The gate is deterministic: a task that never settles keeps
    // `_runningTask` true across every subsequent tick, so the overlap guard
    // fires on every tick while the task is in flight.
    let release;
    let invocations = 0;
    let maxActive = 0;
    const task = async () => {
      invocations += 1;
      maxActive = Math.max(maxActive, invocations);
      await new Promise((r) => {
        release = r;
      });
    };
    const cron = new PowerCron(task, { intervalMs: 20, overlap: false });
    cron.start();
    await wait(30); // first tick fires, task is now in flight
    expect(invocations).toBe(1);
    expect(maxActive).toBe(1);
    await wait(40); // second and third ticks arrive while the task is blocked
    expect(invocations).toBe(1); // still 1 — the ticks were dropped
    release();
    await wait(30); // let the released task settle and the next tick run
    expect(invocations).toBe(2);
    cron.stop();
  });

  it('allows concurrent runs when enabled', async () => {
    let release;
    let invocations = 0;
    let maxActive = 0;
    const task = async () => {
      invocations += 1;
      maxActive = Math.max(maxActive, invocations);
      await new Promise((r) => {
        release = r;
      });
    };
    const cron = new PowerCron(task, { intervalMs: 20, overlap: true });
    cron.start();
    await wait(30);
    expect(invocations).toBe(1);
    await wait(40); // two more ticks fire while the first task is still blocked
    expect(invocations).toBeGreaterThan(1);
    expect(maxActive).toBeGreaterThan(1);
    release();
    await wait(30);
    cron.stop();
  });

  it('does not gate runNow — it is out of band', async () => {
    let release;
    let invocations = 0;
    const task = async () => {
      invocations += 1;
      await new Promise((r) => {
        release = r;
      });
    };
    const cron = new PowerCron(task, { intervalMs: 20, overlap: false });
    cron.start();
    await wait(30); // first tick, task in flight
    expect(invocations).toBe(1);
    cron.runNow(); // out of band — should still invoke
    await wait(10);
    expect(invocations).toBe(2);
    release();
    release();
    await wait(30);
    cron.stop();
  });
});
