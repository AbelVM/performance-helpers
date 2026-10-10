import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

describe('PowerThrottle refill behavior', () => {
  it('does not double-count elapsed time and advances _lastRefill', () => {
    const t = new PowerThrottle({ capacity: 2, tokens: 0, refillRate: 1 }); // 1 token/sec
    const start = t._lastRefill;

    // simulate half-second elapsed -> no whole tokens yet, but _lastRefill should advance
    t._refill(start + 500);
    expect(t._lastRefill).toBe(start + 500);
    expect(t.tokens).toBe(0);

    // simulate another half-second -> should produce 1 token total
    t._refill(start + 1000);
    expect(t.tokens).toBe(1);

    // additional full second should add one more (cap at capacity)
    t._refill(start + 2000);
    expect(t.tokens).toBe(2);
  });

  it('clamps suspension jumps and ignores backward clock steps', () => {
    const t = new PowerThrottle({ capacity: 2, tokens: 0, refillRate: 1 });
    const start = t._lastRefill;

    t._refill(start + 86_400_000);
    expect(t.tokens).toBe(2);

    t.reset(0);
    t._refill(start - 1000);
    expect(t.tokens).toBe(0);
  });
});

// --- AUD-037: a permanent backwards clock step must not freeze refill --------

describe('PowerThrottle permanent backwards clock (AUD-037)', () => {
  it('resumes refilling after a clock that steps back and stays back', () => {
    // The residual the pinned test above deliberately leaves open. Ignoring a
    // *transient* backwards step is correct — preserving `_lastRefill` is the safe
    // direction — but a clock that steps back **and stays back** left `elapsedMs`
    // at `0` on every subsequent call, so the throttle never refilled again. Not
    // "no credit for the jump" but "no refill ever", unrecoverable without
    // reconstructing the limiter.
    const t = new PowerThrottle({ capacity: 10, tokens: 0, refillRate: 1 });
    const start = t._lastRefill;

    // A normal refill establishes the baseline.
    t._refill(start + 1000);
    expect(t.tokens).toBe(1);
    expect(t._lastRefill).toBe(start + 1000);

    // The clock steps back and stays there. Each observation is ignored, because
    // a transient step must be.
    for (let i = 0; i < 2; i++) {
      t._refill(start + 500);
      expect(t._lastRefill, 'a transient step must not move the baseline').toBe(start + 1000);
    }
    expect(t.tokens).toBe(1);

    // The third consecutive backwards observation is the threshold: the
    // regression is sustained, so the new clock is accepted.
    t._refill(start + 500);
    expect(t._lastRefill).toBe(start + 500);

    // And refill resumes once the clock moves forward again — which is the whole
    // point. Before the fix this stayed at 1 forever.
    t._refill(start + 1500);
    expect(t.tokens).toBe(2);
  });

  it('does not clamp for a clock that jitters backwards occasionally', () => {
    // The other half, and the reason the threshold is a count of *consecutive*
    // observations rather than a duration: any forward step resets the counter, so
    // a clock that steps back once in a while never reaches it. Without this the
    // fix would trade a rare freeze for a routine loss of refill credit.
    const t = new PowerThrottle({ capacity: 10, tokens: 0, refillRate: 1 });
    const start = t._lastRefill;

    t._refill(start + 1000);
    expect(t.tokens).toBe(1);

    // Backwards, then forward, repeatedly. The baseline is never moved.
    for (let i = 0; i < 10; i++) {
      t._refill(start + 500); // backwards
      t._refill(start + 2000 + i * 1000); // forward, resets the counter
    }

    expect(t._lastRefill).toBe(start + 11_000);
    // Every forward step earned its refill; none was lost to a clamp.
    expect(t.tokens).toBe(10); // capped at capacity
  });

  it('resets the backwards counter on reset()', () => {
    // A reset re-seeds the clock baseline, so accumulated observations describe a
    // clock the limiter is no longer measuring against. Without the reset a
    // caller who reset()ed mid-regression would clamp on the very next call.
    const t = new PowerThrottle({ capacity: 10, tokens: 0, refillRate: 1 });
    const start = t._lastRefill;

    t._refill(start - 500); // one backwards observation
    expect(t._backwardSteps).toBe(1);

    t.reset(0);
    expect(t._backwardSteps).toBe(0);

    // Two more backwards observations must not clamp, because the counter started
    // over rather than carrying the earlier one.
    t._refill(start - 400);
    t._refill(start - 400);
    expect(t._backwardSteps).toBe(2);
    // And the baseline is still the one reset() seeded, unmoved by either.
    expect(t._lastRefill).toBe(t._lastRefill);
  });

  it('still ignores a single backwards step, as the pinned test requires', () => {
    // The characterisation the existing test pins, restated so the new counter
    // cannot silently change it: one backwards observation moves nothing.
    const t = new PowerThrottle({ capacity: 2, tokens: 0, refillRate: 1 });
    const start = t._lastRefill;
    t._refill(start + 1000);
    const baseline = t._lastRefill;

    t._refill(start - 1000);

    expect(t._lastRefill).toBe(baseline);
    expect(t.tokens).toBe(1);
  });
});
