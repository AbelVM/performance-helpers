/**
 * The degenerate-clock cases of OBS-007, and two contracts the sibling file
 * cannot reach.
 *
 * `powerEventLoopMonitor.coverage.test.js` covers the three new fields against
 * real wall-clock time, which is the right default and is why the arithmetic it
 * asserts is exact. It runs entirely on **real timers**, though, and three of the
 * states `coverage` has to answer for cannot be produced that way:
 *
 * - `elapsed === 0` — a window of no length. The ratio is `0 / 0`, so this is
 *   the `NaN` case, and `NaN` compares false against *every* threshold: a
 *   coverage alert would be silenced by a value that still looks like a number.
 * - `elapsed < 0` — the wall clock stepping backwards. That file's own comment
 *   says "a backwards clock makes `elapsed` negative", but nothing in it moves
 *   the clock, so its `coverage <= 1` assertion passes on any value at all.
 * - The `reset()` re-base. That file asserts `coverage === null` after a reset,
 *   which is true **whether or not** `_startedAt` is re-based — the samples are
 *   gone, so the guard returns `null` either way. The re-base is only observable
 *   once a *new* sample lands in a *new* window, which is what the test below does.
 *
 * So these use `vi.setSystemTime` instead, which is the documented way to move
 * this clock and is what makes the numbers here exact rather than approximate:
 * `nowMs()` prefers `performance.timeOrigin + performance.now()` only while it is
 * within a second of `Date.now()`, so a jump past that threshold makes it read
 * the faked `Date.now()`. Verified rather than assumed before being relied on —
 * a 5 000 ms jump moved `nowMs()` by exactly 5 000, and a 20 000 ms step
 * backwards by exactly −20 000.
 *
 * The fourth test is unrelated to the clock: a refused sample must not reach
 * `onDrift`, which is the alerting path.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerEventLoopMonitor } from '../src/index.js';

/**
 * Move the wall clock `nowMs()` reads, leaving the fake timer itself alone.
 *
 * @param {number} ms - Signed milliseconds. Negative steps the clock backwards.
 * @returns {void}
 */
function advanceClock(ms) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

describe('OBS-007: coverage against a clock that is not behaving', () => {
  it('is null when the window has no length, where the ratio would be NaN', () => {
    // Fake timers freeze `nowMs()`, so this is the state **every** fake-timer
    // test in this repository is in — which is why it is the first thing a
    // future test here will hit. One zero-drift sample makes `accounted` 0 too,
    // so the unguarded expression is `0 / 0`.
    vi.useFakeTimers();
    try {
      const m = new PowerEventLoopMonitor({ intervalMs: 20 });
      m._record(0);
      const coverage = m.stats().coverage;
      expect(coverage, 'a zero-length window has no fraction to report').toBeNull();
      // Named separately, because `toBeNull` documents the *choice* and this
      // documents the hazard: the value a caller would otherwise be handed is
      // the one that silently disables `coverage < 0.5`.
      expect(Number.isNaN(coverage), 'NaN compares false against every threshold').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is null when the wall clock steps backwards, not 1', () => {
    vi.useFakeTimers();
    try {
      const m = new PowerEventLoopMonitor({ intervalMs: 20 });
      m._record(5);
      advanceClock(-20_000);

      // `1` is the answer this returned first, and it is the worst one available:
      // "fully covered" is the single reading that silences a coverage alert. The
      // window runs the wrong way, so there is no fraction in it to report.
      expect(m.stats().coverage, 'a backwards window is not a covered one').toBeNull();
      // The sample itself is untouched, so this is a reporting decision and not
      // a discarded measurement.
      expect(m.stats().samples).toBe(1);
      expect(m.stats().mean).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers the two clock directions differently, because they are different facts', () => {
    vi.useFakeTimers();
    try {
      const forward = new PowerEventLoopMonitor({ intervalMs: 20 });
      forward._record(5);
      advanceClock(20_000);
      // Forward is the honest low reading: the denominator grew, so the monitor
      // genuinely accounts for a small share of a longer life. 5 ms of drift
      // over 20 s — `accounted` is `0 * intervalMs + 5` for a single sample.
      //
      // Read into a variable rather than compared against a second live call: the
      // next step moves the clock, so a `stats()` call made *after* it describes
      // the backwards window. The first version of this test did exactly that
      // and failed on a comparison between two nulls.
      const forwardCoverage = forward.stats().coverage;
      expect(forwardCoverage).toBeCloseTo(5 / 20_000, 8);

      const backward = new PowerEventLoopMonitor({ intervalMs: 20 });
      backward._record(5);
      advanceClock(-20_000);
      // Backward is not the mirror image. A negative window cannot be a fraction
      // at all, so symmetry here would mean reporting a number nobody can act on.
      expect(backward.stats().coverage).not.toBe(forwardCoverage);
      expect(backward.stats().coverage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset() re-bases the window, observable only once a new sample lands in it', () => {
    vi.useFakeTimers();
    try {
      const m = new PowerEventLoopMonitor({ intervalMs: 20 });
      // 5 s of life, three samples: `2 * 20 + 15`.
      advanceClock(5_000);
      m._record(5);
      m._record(5);
      m._record(5);
      expect(m.stats().coverage).toBeCloseTo(55 / 5_000, 8);

      m.reset();
      expect(m.stats().coverage, 'no samples, so no window').toBeNull();

      // **The assertion that can fail.** One fresh sample, 20 ms of fresh window.
      advanceClock(20);
      m._record(5);
      // 5 / 20. Without the re-base this is 5 / 5_020 — a monitor reporting that
      // it covered a thousandth of its life immediately after being told to
      // forget it, which is the defect the re-base exists to prevent and which
      // the sibling file's post-reset `null` assertion cannot see.
      expect(m.stats().coverage).toBeCloseTo(5 / 20, 8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OBS-007: a refused sample reaches no listener either', () => {
  it('counts a tick over 10ms and nothing else, so the threshold is one number', () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 20 });
    // **Found by a surviving mutant, not by reading.** Loosening `drift > 10` to
    // `drift > 5` passed every other test in both files, because every drift
    // either of them uses is comfortably above 5ms — so a value above 5 is also
    // above 10, and the loosened threshold is invisible. Pinning the number needs
    // values *at* the boundary: 10 is not blocked, because the comparison is
    // `> 10` and not `>= 10`, and 9 is not blocked either, which is the half the
    // loosened mutant actually gets wrong.
    m._record(10);
    m._record(9);
    m._record(10.5);

    const s = m.stats();
    expect(s.blockedOver10ms, 'one tick, and it is the 10.5').toBe(1);
    // The same population, so the two fields cannot drift apart onto different
    // thresholds — a second threshold on the millisecond branch is the mutation
    // that most looks like an improvement.
    expect(s.blockedMs).toBe(10.5);
    expect(s.samples, 'all three are still recorded').toBe(3);
  });

  it('does not call onDrift for a reading it refused', () => {
    const seen = [];
    const m = new PowerEventLoopMonitor({ intervalMs: 20, onDrift: (d) => seen.push(d) });
    // Both halves of the guard, not just the negative: `!(drift >= 0)` refuses a
    // `NaN` for the same reason, and a counter that counted only one of them
    // would be measuring half of what it drops.
    m._record(-1);
    m._record(Number.NaN);
    m._record(7);

    // `onDrift` is the alerting path. A negative reading delivered to it would
    // read as "the loop is 1 ms *ahead*", which is not a thing a loop does — and
    // the guard that refuses to record the sample has to refuse to report it.
    expect(seen).toEqual([7]);
    // Counted, and dropped: the counter is not a substitute for the refusal.
    expect(m.stats().droppedSamples).toBe(2);
    expect(m.stats().samples).toBe(1);
    expect(m.stats().max).toBe(7);
    expect(m.lastDelay()).toBe(7);
  });
});
