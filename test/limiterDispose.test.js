import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';

/**
 * QUAL-011 (F12): the clock-driven limiters can be disposed.
 *
 * ## Why these three
 *
 * Twenty helpers have `dispose()` and `[Symbol.dispose]`; twelve had neither. For
 * a stateless value type — `PowerDefer`, `PowerLogger`, `PowerBuffer` — that
 * absence is obviously right. For the **clock-driven limiters** it is a real gap:
 * these are the helpers a caller holds for the process lifetime, and without
 * `dispose()` they cannot take part in `using` / `await using` or a DI
 * container's teardown, which is the one shape every other long-lived helper here
 * supports.
 *
 * ## What `dispose()` does, and what it deliberately does not
 *
 * **No timer is cancelled, because there is no timer.** Each of these refills
 * lazily: the elapsed time is computed from a stored timestamp whenever the
 * helper is read. So `dispose()` is a *state reset* — a half-spent bucket is
 * dropped, recorded history is cleared — and saying "cancels the interval" would
 * describe work that is not happening.
 *
 * That distinction is the reason the rule is worth writing down: **a helper that
 * owns a timer, a listener registry, or a `FinalizationRegistry` must implement
 * `dispose()`; a lazy one must implement it as a reset.** The interface is the
 * same, the reason is not.
 */
describe('the clock-driven limiters can be disposed', () => {
  it('PowerThrottle: dispose drops a spent bucket', () => {
    const t = new PowerThrottle({ capacity: 2, refillRate: 0 });
    t.tryConsume(2);
    expect(t.tokens).toBe(0);
    t.dispose();
    // A disposed-and-reused throttle must not immediately admit a request the
    // previous instance "spent".
    expect(t.tokens).toBe(2);
  });

  it('PowerSlidingWindow: dispose clears the recorded history', () => {
    const w = new PowerSlidingWindow({ capacity: 2, windowMs: 60_000 });
    expect(w.tryConsume(2)).toBe(true);
    expect(w.available()).toBe(0);
    w.dispose();
    expect(w.available()).toBe(2);
  });

  it('all three support `using` via [Symbol.dispose]', () => {
    // The point of the change: these three are now usable with `using`, which
    // they were not before.
    for (const [name, make] of [
      ['PowerThrottle', () => new PowerThrottle({ capacity: 1 })],
      ['PowerSlidingWindow', () => new PowerSlidingWindow({ capacity: 1 })],
      ['PowerGCRA', () => new PowerGCRA({ rate: 1, per: 1000 })],
    ]) {
      const instance = make();
      expect(typeof instance.dispose, `${name}.dispose`).toBe('function');
      expect(typeof instance[Symbol.dispose], `${name}[Symbol.dispose]`).toBe('function');
      // Idempotent: scope exit must not throw because both ran.
      instance.dispose();
      expect(() => instance.dispose(), `${name}.dispose() twice`).not.toThrow();
    }
  });

  it('works through `using` itself', () => {
    // Not a proxy for the assertion above: this is the call site the gap
    // actually blocked, and it fails at *parse* time without the symbol.
    const seen = [];
    {
      using scope = new PowerThrottle({ capacity: 2, refillRate: 0 });
      scope.tryConsume(2);
      seen.push(scope.tokens);
    }
    // The point is that the block parsed at all: without `[Symbol.dispose]` on
    // this class, `using` is a syntax error, which is the gap this closes.
    expect(seen, 'a spent bucket inside the using block').toEqual([0]);
  });
});
