import { describe, it, expect } from 'vitest';
import { PowerSlidingWindow } from '../src/index.js';
import { POWER_QUEUE_INITIAL_CAPACITY } from '../src/helpers/constants.js';

/**
 * BUG-001 — `PowerSlidingWindow.dispose()` drained the timestamp queue with an
 * O(n) `shift()` loop and never shrank it, so a disposed window kept its ring
 * buffer fully allocated.
 *
 * **Measured before the fix:** `capacity: 8192` with 5000 recorded timestamps
 * left **8192 slots retained** after `dispose()`. Not a leak in the sense of an
 * unreachable object — the instance is still there — but the whole point of
 * `dispose()` is that a caller who has finished with a helper should not be
 * holding its buffers, and this one was holding the largest array it ever
 * allocated.
 *
 * **Two defects and two false comments, all in one method.**
 *
 * 1. An O(n) drain where an O(1) `clear()` existed. The comment claimed
 *    "`PowerQueue` exposes `length` and `shift`; there is no `clear`" — **and
 *    that is simply false**; `clear()` has existed alongside `reset()` since the
 *    class did. A stale note is what kept the slow path in place.
 * 2. No `shrink()` anywhere, which is the half that actually retained memory.
 * 3. The docblock claimed `dispose()` "clears the recorded history **and
 *    re-seeds the clock**". It does not, and should not: `_now` is the *caller's*
 *    injected clock and `_nowExplicit` records that it was injected, so writing
 *    either would discard caller configuration rather than release a resource.
 *
 * **`reset()` is deliberately NOT changed**, and one test below pins that, because
 * the finding's own suggested fix (`clear(); shrink()`) would apply there too and
 * that would be wrong. `reset()` is a logical reset of a live window — possibly on
 * a hot path — where reallocating the ring every call is worse than holding it.
 * `dispose()` is teardown. Logical against physical.
 */

/** A window filled to `n` recorded timestamps, with room to have grown. */
function filled(n, capacity = 8192) {
  const w = new PowerSlidingWindow({ windowMs: 600_000, capacity });
  for (let i = 0; i < n; i += 1) w.tryConsume(1);
  return w;
}

describe('BUG-001: dispose() releases the ring buffer it allocated', () => {
  it('shrinks the timestamp ring back to its initial capacity', () => {
    // **The defect.** 5000 entries grew the ring to 8192; after dispose it was
    // still 8192. A test asserting `length === 0` would have passed before the
    // fix, which is why the assertion is on capacity.
    const w = filled(5000);
    expect(w._timestamps._capacity, 'the ring really did grow').toBe(8192);

    w.dispose();

    expect(w._timestamps.length, 'history dropped').toBe(0);
    expect(w._timestamps._capacity, 'and the ring was released rather than merely emptied').toBe(
      POWER_QUEUE_INITIAL_CAPACITY
    );
  });

  it('releases the ring for a window that grew to an awkward capacity', () => {
    // Not just the 8192 case the finding quoted. `shrink()` rounds down to a
    // power of two, so a fix that hard-coded a capacity would pass the first test
    // and miss this.
    const w = filled(3000, 4096);
    expect(w._timestamps._capacity).toBeGreaterThan(POWER_QUEUE_INITIAL_CAPACITY);

    w.dispose();

    expect(w._timestamps._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
  });

  it('is idempotent, so a second dispose is not a second shrink', () => {
    // `dispose()` is reachable twice — explicitly and through `[Symbol.dispose]` —
    // and `shrink()` is a no-op below the floor rather than an error, but the
    // contract should say so rather than leave a caller guessing.
    const w = filled(5000);
    w.dispose();
    w.dispose();
    w[Symbol.dispose]();

    expect(w._timestamps.length).toBe(0);
    expect(w._timestamps._capacity).toBe(POWER_QUEUE_INITIAL_CAPACITY);
    expect(w.available(), 'and the window is fully available afterwards').toBe(8192);
  });

  it('empties via clear(), so the cost does not scale with the history', () => {
    // **The O(1)-versus-O(n) half.** Not asserted as a duration — the harness
    // measures a 28.61 % median min/max spread, so a timing assertion finer than
    // that is noise. Asserted structurally instead: `clear()` is called and
    // `shift()` is not, which is the property that makes the cost independent of
    // how much history the window accumulated.
    const cleared = [];
    const shifted = [];
    const w = filled(1000);

    // Count the queue operations rather than the elapsed time. `_timestamps` is
    // reached directly because the point is which queue method dispose uses, and
    // that is not observable from outside without instrumenting a private.
    const queue = w._timestamps;
    const realClear = queue.clear.bind(queue);
    const realShift = queue.shift.bind(queue);
    queue.clear = () => {
      cleared.push(1);
      return realClear();
    };
    queue.shift = () => {
      shifted.push(1);
      return realShift();
    };

    w.dispose();

    expect(cleared.length, 'clear() called exactly once').toBe(1);
    expect(shifted.length, 'and no per-item drain at all').toBe(0);
  });

  it('leaves the caller-supplied clock alone', () => {
    // The docblock used to promise a clock re-seed that never happened. Writing
    // `_now` would be actively wrong: it is the caller's injected clock, so
    // "re-seeding" it would swap out caller configuration under a teardown that
    // is supposed to be the opposite of a reconfiguration.
    let ticks = 0;
    const clock = () => {
      ticks += 1;
      return ticks;
    };
    const w = new PowerSlidingWindow({ windowMs: 1000, capacity: 64, now: clock });
    const before = w._now;

    w.dispose();

    expect(w._now, 'the injected clock is untouched').toBe(before);
    expect(w._nowExplicit, 'and the flag recording that it was injected').toBe(true);
  });
});

describe('BUG-001: reset() deliberately keeps the ring, and that is the decision', () => {
  it('empties without shrinking, because a live window may reset often', () => {
    // **The counter-test, and the reason this finding needed a judgement rather
    // than a mechanical fix.** The suggested fix — `clear(); shrink()` — would
    // apply to `reset()` as well, and would be wrong there. `reset()` puts a live
    // window back to empty; a caller clearing a per-tenant window between
    // requests would then reallocate the ring on every call, trading a retained
    // buffer for repeated allocation on a hot path. `dispose()` is teardown.
    //
    // So this test exists to make the asymmetry deliberate: if a future change
    // makes `reset()` shrink too, this fails and says why.
    const w = filled(5000);

    w.reset();

    expect(w._timestamps.length, 'history dropped').toBe(0);
    expect(w._timestamps._capacity, 'but the ring is kept: reset() is logical, not physical').toBe(
      8192
    );
  });

  it('clear() is a true synonym for reset() and inherits that decision', () => {
    // `clear()` delegates to `reset()`, so it must shrink neither more nor less.
    // If it ever gained a shrink of its own, the two would stop being synonyms,
    // which is the one thing that JSDoc claims they are.
    //
    // **The capacity is compared against what it actually grew to, not a
    // literal.** An earlier draft asserted `4096` and failed at 2048: the ring
    // grows to the next power of two above the entry count, so any hard-coded
    // number is a guess about how much history this particular test filled. The
    // property under test is "unchanged", and that holds for any fill.
    const w = filled(2000);
    const grew = w._timestamps._capacity;
    expect(grew, 'the ring did grow').toBeGreaterThan(POWER_QUEUE_INITIAL_CAPACITY);

    w.clear();

    expect(w._timestamps.length, 'history dropped').toBe(0);
    expect(w._timestamps._capacity, 'and the ring is untouched, as reset() leaves it').toBe(grew);
  });
});
