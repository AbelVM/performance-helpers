import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';

describe('PowerSlidingWindow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows up to capacity within the window and then blocks until window passes', () => {
    const limiter = new PowerSlidingWindow({ capacity: 3, windowMs: 1000 });
    expect(limiter.tryConsume(3)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
    // advance beyond the window
    vi.advanceTimersByTime(1000);
    expect(limiter.tryConsume(1)).toBe(true);
  });

  it('available() reflects remaining slots', () => {
    const limiter = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });
    expect(limiter.available()).toBe(2);
    limiter.tryConsume(1);
    expect(limiter.available()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(limiter.available()).toBe(2);
  });
});

// --- AUD-016: the ring must settle, not oscillate ----------------------------

describe('PowerSlidingWindow ring capacity (AUD-016)', () => {
  /**
   * Count real reallocations by watching the backing array's identity. Both
   * `_grow()` and `shrink()` replace `_buffer`, so a change of identity is a
   * reallocation — which is the thing being counted, rather than a capacity
   * reading that would miss a shrink immediately followed by a grow.
   *
   * @param {PowerSlidingWindow} limiter
   * @param {number} perWindow
   * @param {number} windows
   * @returns {number}
   */
  function countReallocs(limiter, perWindow, windows) {
    const q = limiter._timestamps;
    let reallocs = 0;
    const origGrow = q._grow.bind(q);
    q._grow = function () {
      reallocs += 1;
      return origGrow();
    };
    const origShrink = q.shrink.bind(q);
    q.shrink = function (m) {
      const before = q._buffer;
      const r = origShrink(m);
      if (q._buffer !== before) reallocs += 1;
      return r;
    };
    let t = 1_000_000;
    for (let win = 0; win < windows; win++) {
      t += 1001; // past the window boundary
      for (let i = 0; i < perWindow; i++) limiter.tryConsume(1, { now: t });
    }
    return reallocs;
  }

  /** A limiter whose ring has been grown by a burst, on an explicit clock. */
  function afterBurst(size) {
    const limiter = new PowerSlidingWindow({ capacity: size, windowMs: 1000 });
    for (let i = 0; i < size; i++) limiter.tryConsume(1, { now: 1_000_000 });
    return limiter;
  }

  it('does not reallocate on every window boundary under steady load', () => {
    // The defect. `_prune()` called `shrink()` unconditionally, and a sliding
    // window is **empty at every boundary by design** — so the ring was shrunk
    // to the initial capacity and then immediately regrown, on every boundary,
    // for the lifetime of the limiter. Measured on the real class: 4
    // reallocations per window at 100-per-window traffic, 6 at 400.
    //
    // Traffic at or below the initial capacity never thrashed, which is why this
    // went unnoticed — 10-per-window fits in the initial 16 and never regrows.
    for (const perWindow of [10, 100, 400]) {
      const limiter = afterBurst(1000);
      const reallocs = countReallocs(limiter, perWindow, 200);
      // One settle, then nothing. Not 4–6 per window.
      expect(reallocs, `${perWindow}/window reallocated ${reallocs} times`).toBeLessThanOrEqual(2);
    }
  });

  it('still releases the ring after a burst has passed', () => {
    // The other half, and the reason the shrink exists at all: a helper whose job
    // is bounding what it remembers must not keep the memory of the worst moment
    // it saw. Hysteresis delays the release by one window; it must not prevent it.
    const limiter = afterBurst(1000);
    expect(limiter._timestamps.capacity).toBe(1024);

    let t = 1_000_000;
    for (let win = 0; win < 5; win++) {
      t += 1001;
      for (let i = 0; i < 10; i++) limiter.tryConsume(1, { now: t });
    }

    expect(limiter._timestamps.capacity).toBe(16);
    expect(limiter._timestamps.length).toBe(10);
  });

  it('settles at a capacity that covers steady demand, not the initial one', () => {
    // Shrinking to the *initial* capacity is what caused the regrow. The floor is
    // now the demand of the window that just ended, so the ring settles at
    // something that covers it.
    const limiter = afterBurst(1000);
    let t = 1_000_000;
    for (let win = 0; win < 5; win++) {
      t += 1001;
      for (let i = 0; i < 100; i++) limiter.tryConsume(1, { now: t });
    }
    // 100 needs 128, and it stays there rather than falling back to 16.
    expect(limiter._timestamps.capacity).toBe(128);
    expect(limiter._timestamps.length).toBe(100);
  });

  it('does not shrink on a mid-window prune that removed nothing', () => {
    // The first version of this fix recorded the demand on every `tryConsume`, so
    // the *second* consume of a window saw a demand of 1 and shrank the ring to
    // 2 — making the thrash worse (7 per window instead of 4). A prune that
    // removes nothing is not evidence about demand.
    const limiter = afterBurst(1000);
    let t = 1_000_000;
    t += 1001;
    // First consume of the new window: the prune crosses the boundary.
    limiter.tryConsume(1, { now: t });
    const afterBoundary = limiter._timestamps.capacity;
    // The rest of the window: every prune removes nothing.
    for (let i = 1; i < 100; i++) limiter.tryConsume(1, { now: t });
    expect(limiter._timestamps.capacity).toBe(afterBoundary);
    expect(limiter._timestamps.length).toBe(100);
  });

  it('still limits correctly across the boundary', () => {
    // The characterisation that matters most: none of the capacity bookkeeping
    // may change what the window allows. Pinned because a shrink that dropped
    // live timestamps would show up here and nowhere else.
    const limiter = new PowerSlidingWindow({ capacity: 3, windowMs: 1000 });
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.tryConsume(1, { now: 5000 })) allowed += 1;
    expect(allowed).toBe(3);

    let allowedAfter = 0;
    for (let i = 0; i < 10; i++) if (limiter.tryConsume(1, { now: 5000 + 1001 })) allowedAfter += 1;
    expect(allowedAfter).toBe(3);
    expect(limiter.available({ now: 5000 + 1001 })).toBe(0);
  });
});
