import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PowerRateLimit } from '../src/index.js';
import { PowerThrottle } from '../src/index.js';

/**
 * RES-030: "make `atomic: true` reachable, or delete the two-phase path and the
 * guarantee" — the premise was **half wrong**, and the wrong half was the
 * consequential one. Both claims were measured before acting on either.
 *
 * **"The two-phase path is dead code for this library's own limiters" — TRUE.**
 * `allHaveAvailable` is only `false` when a leg lacks `available()`, and
 * `PowerThrottle`, `PowerGCRA` and `PowerSlidingWindow` all have it.
 *
 * **"`atomic: true` silently means non-atomic" — FALSE.** Measured with two
 * `PowerThrottle` legs and leg 2 drained: `tryConsume(1)` returned `false` and
 * **leg 1 still had all 5 tokens.** Nothing was consumed. The reason is visible
 * in the source and is not the rollback path: the `available()` pre-flight and
 * the commit loop are **one synchronous block with no `await` between them**, so
 * on a single-threaded event loop nothing can interleave between "check every leg"
 * and "consume every leg". The pre-flight *is* the atomicity mechanism for any
 * limiter that has `available()`.
 *
 * So the proposed fix — route `atomic: true` to the two-phase path — would add a
 * reserve/rollback round trip to every call, to lose a guarantee that is already
 * held. That is why this file exists rather than a change to the branch.
 *
 * **And the two-phase path is not dead code in general.** A `p-limit`-shaped
 * limiter (`tryConsume` + `reserve`/`release`, no `available()`) reaches it and
 * it works: consuming 2 from `[PowerThrottle, custom]` left the custom balance at
 * 8 and the throttle at 3, and when leg 2's `reserve` failed the throttle was
 * rolled back to exactly 5. Deleting it would remove real functionality for
 * third-party limiters.
 *
 * **What is actually left is one unpinned invariant**, and it is the thing this
 * row was reaching for: the whole guarantee rests on there being no `await`
 * between the pre-flight and the commit. Add one and `atomic: true` silently
 * stops being atomic for every limiter this library ships — a change no
 * behavioural test would catch, because the interleaving it permits cannot be
 * simulated without breaking the very property being asserted. So the invariant
 * is pinned at the source level, and that test is mutation-checked below.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../src/helpers/powerRateLimit.js', import.meta.url)),
  'utf8'
);

describe('RES-030: what `atomic: true` actually guarantees', () => {
  it('is all-or-nothing for shipped limiters, without the rollback path', () => {
    // The measurement that falsified the row. Two `PowerThrottle` legs, leg 2
    // drained, so the pre-flight must refuse — and the question is whether leg 1
    // has already been charged when it does.
    const leg1 = new PowerThrottle({ capacity: 5 });
    const leg2 = new PowerThrottle({ capacity: 5 });
    for (let i = 0; i < 5; i += 1) leg2.tryConsume(1);

    const composed = new PowerRateLimit([leg1, leg2], { atomic: true });
    const consumed = composed.tryConsume(1);

    expect(consumed, 'leg 2 has nothing left, so the call is refused').toBe(false);
    expect(
      leg1.available(),
      'leg 1 must not be charged when a later leg refuses — that is what atomic means'
    ).toBe(5);
  });

  it('is all-or-nothing with three legs, the middle one drained', () => {
    // Three legs, because a two-leg composition cannot distinguish "refused at the
    // pre-flight" from "charged leg 1 then refused at leg 2" — both leave the
    // first leg charged only in the second case, and only with a middle drain
    // does the *first* leg's state prove which happened.
    const leg1 = new PowerThrottle({ capacity: 5 });
    const leg2 = new PowerThrottle({ capacity: 5 });
    const leg3 = new PowerThrottle({ capacity: 5 });
    for (let i = 0; i < 5; i += 1) leg2.tryConsume(1);

    const composed = new PowerRateLimit([leg1, leg2, leg3], { atomic: true });

    expect(composed.tryConsume(1)).toBe(false);
    expect(leg1.available(), 'first leg untouched').toBe(5);
    expect(leg3.available(), 'last leg untouched').toBe(5);
  });

  it('consumes every leg when all of them can', () => {
    // The control for the two above: a refusal must be a property of the drain,
    // not of `atomic: true` refusing to work at all.
    const leg1 = new PowerThrottle({ capacity: 5 });
    const leg2 = new PowerThrottle({ capacity: 5 });

    const composed = new PowerRateLimit([leg1, leg2], { atomic: true });

    expect(composed.tryConsume(2)).toBe(true);
    expect(leg1.available()).toBe(3);
    expect(leg2.available()).toBe(3);
  });

  it('reaches the two-phase path for a limiter that has reserve but no available', () => {
    // The other half of the row, and the reason the path is not deleted. A
    // `p-limit`-shaped limiter has `reserve`/`release` and no `available()`, so
    // the pre-flight cannot vouch for it and the rollback path is the only
    // option. If this stops reaching the path, `atomic: true` has quietly become
    // unavailable for third-party limiters.
    let balance = 10;
    const custom = {
      tryConsume: (n) => {
        if (balance < n) return false;
        balance -= n;
        return true;
      },
      reserve: (n) => {
        if (balance < n) return null;
        balance -= n;
        return { n };
      },
      release: (token) => {
        balance += token.n;
      },
    };
    const throttle = new PowerThrottle({ capacity: 5 });

    const composed = new PowerRateLimit([throttle, custom], { atomic: true });

    expect(composed.tryConsume(2), 'the reserve path commits').toBe(true);
    expect(balance, 'the custom limiter was charged').toBe(8);
    expect(throttle.available(), 'and so was the shipped one').toBe(3);
  });

  it('rolls back the shipped leg when a later reserve fails', () => {
    // The rollback itself, which is the only thing the two-phase path adds over
    // the pre-flight. The custom limiter is drained so its `reserve` returns
    // `null`, and the throttle must come back to exactly where it started.
    let balance = 1;
    const custom = {
      tryConsume: (n) => {
        if (balance < n) return false;
        balance -= n;
        return true;
      },
      reserve: (n) => {
        if (balance < n) return null;
        balance -= n;
        return { n };
      },
      release: (token) => {
        balance += token.n;
      },
    };
    const throttle = new PowerThrottle({ capacity: 5 });

    const composed = new PowerRateLimit([throttle, custom], { atomic: true });

    expect(composed.tryConsume(2), 'the call is refused').toBe(false);
    expect(throttle.available(), 'the first leg was reserved then rolled back').toBe(5);
    expect(balance, 'the failing leg keeps its own tokens').toBe(1);
  });

  it('refuses rather than proceeding when no rollback is possible', () => {
    // A limiter with neither `available()` nor any undo primitive cannot be
    // composed atomically, and the documented answer is `false` rather than a
    // best-effort commit. Pinning it because the alternative — charging leg 1 and
    // hoping — is the failure this option exists to prevent.
    let balance = 10;
    const hopeless = {
      tryConsume: (n) => {
        if (balance < n) return false;
        balance -= n;
        return true;
      },
    };
    const throttle = new PowerThrottle({ capacity: 5 });

    const composed = new PowerRateLimit([throttle, hopeless], { atomic: true });

    expect(composed.tryConsume(2), 'no safe rollback, so refuse').toBe(false);
    expect(throttle.available(), 'and charge nothing').toBe(5);
    expect(balance, 'including the un-undoable leg').toBe(10);
  });

  it('has no await between the available() pre-flight and the commit loop', () => {
    // **The load-bearing invariant, and the one nothing else pins.**
    //
    // Atomicity for every limiter this library ships rests on the pre-flight and
    // the commit being a single synchronous block: on a single-threaded event
    // loop, nothing can interleave between "every leg can afford it" and "every
    // leg has taken it". Insert one `await` and `atomic: true` becomes
    // best-effort for all three shipped limiters.
    //
    // This reads the source, which is normally the wrong thing to do. It is right
    // here because the interleaving the invariant forbids **cannot be simulated
    // without breaking the invariant** — a test that interleaved would be testing
    // the absence of the property it needs in order to run. The behavioural tests
    // above pin the guarantee; this pins the mechanism, and it is mutation-checked
    // by inserting an `await` at exactly the point it watches.
    const start = SOURCE.indexOf('let allHaveAvailable');
    const branch = SOURCE.indexOf('if (!atomic || allHaveAvailable)');
    expect(start, 'the pre-flight is where this test looks').toBeGreaterThan(-1);
    expect(branch, 'the commit branch is where this test looks').toBeGreaterThan(-1);

    const preFlight = SOURCE.slice(start, branch);
    const commit = SOURCE.slice(branch, SOURCE.indexOf('// Atomic required', branch));

    expect(preFlight, 'the pre-flight itself must not await').not.toMatch(/\bawait\b/);
    expect(commit, 'the commit loop must not await').not.toMatch(/\bawait\b/);
  });
});
