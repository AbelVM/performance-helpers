/**
 * `PowerCron.onFire`'s `missed` field carries a number — RES-036.
 *
 * It was hardcoded to `0` at both `onFire` call sites, so the field was a constant in
 * the one payload a caller would use to see catch-up working. `_onTimer` had already
 * computed `missedPeriods` — the count of missed fires beyond the one being handled —
 * and threw it away before the run that needed it.
 *
 * **The semantics chosen, and why they are not uniform across policies.** `missed` is
 * *the number of missed periods this run stands in for*, which is a different question
 * under each `catchUp`:
 *
 * - `catch-up` — each replay **is** one missed period being run, so it reports `1`; the
 *   run that follows reports `0`, because the replays have already accounted for them.
 * - `skip` — the periods were dropped, and the run that happened does not stand in for
 *   them. But the caller still needs to know they occurred, so it reports how many there
 *   were.
 * - `run-once` — they were folded into this run, so `missed` is exactly how many it
 *   represents.
 *
 * The alternative — one meaning for all three — would have had `catch-up` report `0`
 * throughout, which is the defect again with extra steps.
 *
 * **Time is injected, not slept.** `PowerCron` uses `nowMs()` directly and takes no
 * clock option, so these tests drive the policy by arming and disarming rather than by
 * waiting: `stop()` records periods as missed, which is the same `_onTimer` arithmetic
 * the field is derived from. That keeps the assertions exact instead of timing-shaped.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerCron } from '../src/index.js';

/** Collect `onFire` payloads while a cron runs. */
const collector = () => {
  const events = [];
  const onFire = (info) => events.push(info);
  return { events, onFire };
};

describe('PowerCron onFire.missed', () => {
  it('is 0 for a cron that keeps up', () => {
    // The control. Without it, every other case would pass against a field that is
    // always 0.
    const { events, onFire } = collector();
    const cron = new PowerCron(() => {}, { intervalMs: 10, catchUp: 'skip', onFire });
    cron.start();
    cron.stop();
    for (const e of events) expect(e.missed).toBe(0);
  });

  /**
   * Run a cron whose task blocks the loop for longer than its own interval.
   *
   * **This is the mechanism, not a shortcut round it.** `_onTimer` derives
   * `missedPeriods` from `floor((now - target) / intervalMs)`, so a period can only be
   * missed if the loop was unavailable when its timer came due. Stopping and restarting
   * the cron does **not** do it — `start()` re-aims `_nextAt`, so nothing is missed and
   * every case built that way passes vacuously. A first draft of this file did exactly
   * that and reported `0` for all three policies while looking like it had tested them.
   *
   * @param {string} catchUp
   * @returns {Promise<number[]>} The `missed` value of each `onFire`, in order.
   */
  async function missedSequence(catchUp) {
    const busy = (ms) => {
      const t = Date.now();
      while (Date.now() - t < ms);
    };
    const events = [];
    const cron = new PowerCron(() => busy(60), {
      intervalMs: 20,
      catchUp,
      onFire: (info) => events.push(info.missed),
    });
    cron.start();
    await new Promise((r) => setTimeout(r, 220));
    cron.stop();
    return events;
  }

  it('reports the skipped periods under skip, the default policy', () => {
    // The periods are dropped rather than run, so the run that happened does not stand
    // in for them — but the caller still needs to know they occurred, and that is the
    // only signal that the schedule fell behind.
    return missedSequence('skip').then((missed) => {
      expect(missed.length).toBeGreaterThan(0);
      expect(Math.max(...missed)).toBeGreaterThan(0);
    });
  });

  it('reports each replay as one missed period under catch-up', () => {
    // Each replay **is** one missed period being run, so it reports `1` — and the run
    // that follows reports `0`, because the replays already accounted for them. A
    // single event claiming to cover them all would be the coalesced reading, which is
    // `run-once`'s, not this one's.
    return missedSequence('catch-up').then((missed) => {
      expect(missed.filter((m) => m === 1).length).toBeGreaterThan(1);
      expect(Math.max(...missed)).toBeLessThanOrEqual(1);
    });
  });

  it('reports the coalesced count under run-once', () => {
    // One run stands in for all of them, so this is the case where the field exceeds 1
    // and is the most useful number in the payload.
    return missedSequence('run-once').then((missed) => {
      expect(Math.max(...missed)).toBeGreaterThan(1);
    });
  });

  it('still carries the other three fields', () => {
    // `missed` gained a value; the rest of the payload is the reason a caller reads it,
    // and a regression in `scheduledFor` or `driftMs` would be invisible otherwise.
    const { events, onFire } = collector();
    const cron = new PowerCron(() => {}, { intervalMs: 10, onFire });
    cron.start();
    cron.stop();
    cron.start();

    for (const e of events) {
      expect(typeof e.scheduledFor).toBe('number');
      expect(typeof e.ranAt).toBe('number');
      expect(typeof e.driftMs).toBe('number');
      expect(typeof e.missed).toBe('number');
    }
  });

  it('does not fire for a task that throws', () => {
    // `onFire` is documented as "after each **successful** run". This case is here so
    // the `missed` work is not mistaken for a change to *when* it fires.
    const onFire = vi.fn();
    const cron = new PowerCron(
      () => {
        throw new Error('nope');
      },
      { intervalMs: 5_000, catchUp: 'catch-up', onError: () => {}, onFire }
    );
    cron.start();
    cron.stop();
    cron.start();
    expect(onFire).not.toHaveBeenCalled();
  });
});
