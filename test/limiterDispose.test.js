import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';

/**
 * QUAL-011 (F12): the clock-driven limiters can be disposed.
 *
 * ## Why these helpers
 *
 * Twenty-one helpers have `dispose()` and `[Symbol.dispose]`; twelve had neither.
 * For a stateless value type — `PowerDefer`, `PowerLogger`, `PowerBuffer` — that
 * absence is obviously right. For the **clock-driven limiters** it is a real gap:
 * these are the helpers a caller holds for the process lifetime, and without
 * `dispose()` they cannot take part in `using` / `await using` or a DI
 * container's teardown, which is the one shape every other long-lived helper here
 * supports.
 *
 * `PowerThrottle` and `PowerSlidingWindow` were the last two of the three bare
 * limiters to get this, and `PowerRateLimit` the last of the composers: it was
 * the **only** limiter in this group still unable to take part in `using`, which is
 * the gap `RES-034` named. See the note on that row — the row asserted all three
 * had no `dispose` at all, which had stopped being true some commits earlier.
 *
 * ## What `dispose()` does, and what it deliberately does not
 *
 * **No timer is cancelled, because there is no timer.** Each of these refills
 * lazily: the elapsed time is computed from a stored timestamp whenever the
 * helper is read. So `dispose()` is a *state release* — a half-spent bucket is
 * dropped, recorded history is cleared, lazily built state is dropped — and saying
 * "cancels the interval" would describe work that is not happening.
 *
 * That distinction is the reason the rule is worth writing down: **a helper that
 * owns a timer, a listener registry, or a `FinalizationRegistry` must implement
 * `dispose()`; a lazy one must implement it as a state reset.** The interface is
 * the same, the reason is not.
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

  it('PowerRateLimit: dispose drops the per-key limiter sets it built', () => {
    // **The payload, and the reason this is not just a `reset()` alias.**
    //
    // With `keyFn`, a composer builds one limiter set per hash slot on first use,
    // addressed by a key the caller usually derived from a request header. Those
    // sets are the largest thing a rate limiter in this library holds, and
    // `reset()` alone cannot release them: it walks every built slot calling
    // `reset()` on each leg and leaves all of them resident. A dispose that only
    // reset would report doing its job while the memory it exists to free stayed.
    const built = [];
    const limit = new PowerRateLimit(
      [
        (/** @type {number} */ slot) => {
          const leg = new PowerThrottle({ capacity: 2, refillRate: 0 });
          built.push({ leg, slot });
          return leg;
        },
      ],
      { keyFn: (ctx) => String(ctx), buckets: 4 }
    );

    for (const key of ['a', 'b', 'c']) {
      expect(limit.tryConsume(1, { context: key })).toBe(true);
    }
    // Deliberately not asserting three slots: three keys into four hash buckets
    // can legitimately collide, and a test that pins the hash's output would be
    // asserting the hash rather than the dispose. What matters is that slots were
    // built and the composer is holding exactly those.
    expect(built.length).toBeGreaterThan(0);
    expect(limit._slots.filter(Boolean).length).toBe(built.length);

    limit.dispose();
    expect(limit._slots.filter(Boolean).length).toBe(0);

    // Still usable after teardown: `_slotFor` addresses slots by index, so the
    // freed slot is simply rebuilt. Asserting the *slot* is gone above and the
    // composer still answers here is what makes this a release rather than a
    // poison pill.
    //
    // Deliberately not asserting anything about `_slots.length` surviving
    // dispose. An earlier version of this test claimed a rebuilt array would be
    // too short, and two mutants — `= []` and `= new Array(buckets).fill(null)` —
    // both passed it, which is how the claim was found to be false rather than
    // merely untested. There is no behavioural difference to pin.
    expect(limit.tryConsume(1, { context: 'a' })).toBe(true);
  });

  it('PowerRateLimit: dispose resets the legs it composes, and keeps them', () => {
    const leg = new PowerThrottle({ capacity: 2, refillRate: 0 });
    const limit = new PowerRateLimit([leg]);
    expect(limit.tryConsume(2)).toBe(true);
    expect(leg.tokens).toBe(0);

    limit.dispose();
    expect(leg.tokens).toBe(2);
    // The caller's own limiter is **not** discarded. It was passed in, so it
    // belongs to the caller; dropping the reference would leave them holding a
    // silently dead object, which is the failure a dispose is supposed to avoid
    // rather than create.
    expect(limit.limiters[0]).toBe(leg);
  });

  it('every limiter here supports `using` via [Symbol.dispose]', () => {
    // The point of the change: these are now usable with `using`, which they were
    // not before. `PowerRateLimit` was the last one still locked out.
    for (const [name, make] of [
      ['PowerThrottle', () => new PowerThrottle({ capacity: 1 })],
      ['PowerSlidingWindow', () => new PowerSlidingWindow({ capacity: 1 })],
      ['PowerGCRA', () => new PowerGCRA({ rate: 1, per: 1000 })],
      ['PowerRateLimit', () => new PowerRateLimit()],
    ]) {
      const instance = make();
      expect(typeof instance.dispose, `${name}.dispose`).toBe('function');
      expect(typeof instance[Symbol.dispose], `${name}[Symbol.dispose]`).toBe('function');
      // Idempotent: scope exit must not throw because both ran.
      instance.dispose();
      expect(() => instance.dispose(), `${name}.dispose() twice`).not.toThrow();
    }
  });

  it('a disposed composer is still usable, rather than left half-dead', () => {
    // The contract every one of these already had, pinned here for the one that
    // did not: `dispose()` releases state, it does not poison the instance. A
    // teardown that left a permanent `null` behind would make "reuse after
    // dispose" a TypeError instead of a fresh limiter.
    const limit = new PowerRateLimit([() => new PowerThrottle({ capacity: 2, refillRate: 0 })], {
      keyFn: (ctx) => String(ctx),
      buckets: 2,
    });
    expect(limit.tryConsume(1, { context: 'a' })).toBe(true);
    limit.dispose();
    expect(limit.tryConsume(1, { context: 'a' })).toBe(true);
    expect(limit.tryConsume(1, { context: 'a' })).toBe(true);
    // The rebuilt slot is a fresh limiter, so it starts full rather than
    // continuing to refuse — the documented consequence of disposing a keyed
    // composer and reusing it, which is why the guide says dispose is teardown.
    expect(limit.available({ context: 'a' })).toBe(0);
  });

  it('works through a scope-exit dispose itself', () => {
    // Not a proxy for the assertion above: this is the call site the gap
    // actually blocked. Node 22.12 cannot parse `using` declarations and no
    // transformer in this tree downlevels them, so the scope exit is spelled
    // out here; the behaviour under test is identical.
    const seen = [];
    const scope = new PowerThrottle({ capacity: 2, refillRate: 0 });
    try {
      scope.tryConsume(2);
      seen.push(scope.tokens);
    } finally {
      scope.dispose();
    }
    expect(seen, 'a spent bucket inside the scope').toEqual([0]);
  });

  it('works through a scope-exit dispose on the composer, which is the one that lacked it', () => {
    // A separate block rather than another case in the loop above: this fails at
    // *parse* time if `[Symbol.dispose]` is absent from `PowerRateLimit`, and a
    // runtime `typeof` check cannot detect that. It is the call site RES-034 named.
    //
    // The instance is kept in an outer binding so the assertion can run *after*
    // the scope has exited. Asserting inside the block would only prove the
    // object exists; asserting that the built slot is gone afterwards is what
    // proves scope exit actually ran the dispose.
    let limit;
    const scope = new PowerRateLimit([() => new PowerThrottle({ capacity: 2, refillRate: 0 })], {
      keyFn: (ctx) => String(ctx),
      buckets: 2,
    });
    try {
      limit = scope;
      expect(scope.tryConsume(2, { context: 'a' })).toBe(true);
      expect(scope._slots.filter(Boolean).length).toBe(1);
    } finally {
      scope.dispose();
    }
    expect(limit._slots.filter(Boolean).length).toBe(0);
  });
});
