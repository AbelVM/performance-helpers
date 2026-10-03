/**
 * RES-035 — the two undo paths in `PowerRateLimit`, and what a leg must accept.
 *
 * The row this answers asked for the two token shapes to be *unified*. Both halves
 * of it turned out to be settled already, and in opposite ways:
 *
 * - **`reserve(n)` forwarding `options` is fixed.** `:424` reads
 *   `this.tryConsume(want, { ...options, atomic: true })`, with a comment saying the
 *   key is forwarded rather than re-derived so a reservation and a consumption
 *   cannot land on different budgets. The row's `at :246` predates that.
 * - **The token shapes are deliberately different**, and two tests in
 *   `powerRateLimit.extra.test.js` pin them: `expect(l1.release).toHaveBeenCalledWith(token)`
 *   for the public `release()` path, which hands a leg the *composer's* token, and
 *   `_undoCommit` hands the *leg's own* token on rollback. Collapsing them is not a
 *   fix; the composer's token is public API and callers compare it.
 *
 * So what was actually missing is the **requirement on a leg**, which nothing
 * stated: a limiter's `release` has to accept a `{ n }`-bearing object *or* a plain
 * count, because the two paths hand it different objects. `PowerThrottle.release`
 * already does. A third-party limiter that looks its token up in a `Map` it minted
 * it into cannot, and would miss.
 *
 * **These tests are written from the leg's point of view on purpose.** Asserting
 * `toHaveBeenCalledWith(token)` — what the existing tests do — pins the composer's
 * side and says nothing about whether a leg can cope. A leg here implements `release`
 * the strict way (identity-checked token, throws otherwise), which is the leg that
 * breaks, and the assertion is that it still gets credited on **both** paths.
 */
import { describe, it, expect } from 'vitest';
import { PowerRateLimit, PowerThrottle } from '../src/index.js';

/**
 * A limiter whose `release` only accepts the token it minted itself.
 *
 * The strictest reasonable reading of the undo contract, and the one a third-party
 * limiter with a `Map`-keyed token table would implement. It throws on anything
 * else, so if a path hands it a foreign object the credit is lost unless the
 * composer falls through to `rollback`/`addTokens`.
 *
 * @param {object} [opts]
 * @returns {object} The limiter, with its call log attached.
 */
function strictLeg({ available = null, consume = true, refuseReserve = false } = {}) {
  const minted = new Map();
  let next = 0;
  const leg = {
    minted,
    calls: [],
    /** Whether each `release` received a token this leg had minted, in order. */
    presented: [],
    tryConsume(n) {
      leg.calls.push(['tryConsume', n]);
      return true;
    },
    reserve(n) {
      leg.calls.push(['reserve', n]);
      if (refuseReserve) return null;
      const token = { n, id: next++ };
      minted.set(token.id, n);
      return token;
    },
    release(token) {
      leg.calls.push(['release', token]);
      // Recorded *at the moment of receipt*, because a leg that accepts a token
      // consumes it: asking afterwards whether the table still holds it is a
      // question whose answer is always no, and would pass or fail for reasons
      // that have nothing to do with which token was handed over.
      const recognised = typeof token === 'object' && token !== null && minted.has(token.id);
      leg.presented.push(recognised);
      if (!recognised) throw new TypeError('release: not a token this limiter minted');
      minted.delete(token.id);
      return undefined;
    },
    rollback(n) {
      leg.calls.push(['rollback', n]);
    },
    addTokens(n) {
      leg.calls.push(['addTokens', n]);
    },
  };
  // `available` is what keeps the composer on the fast pre-flight path, where legs
  // are committed with `tryConsume` and never mint a token at all. Omit it and the
  // composition takes the two-phase reserve/rollback path, which is the only place a
  // leg holds a token of its own - so the two fixtures differ in more than a flag.
  if (available !== null) leg.available = () => available;
  if (!consume) delete leg.tryConsume;
  return leg;
}

/** Every `[method, arg]` pair a leg was called with, filtered to one method. */
const callsTo = (leg, method) => leg.calls.filter(([m]) => m === method).map(([, arg]) => arg);

describe('PowerRateLimit undo paths: what a leg is actually handed', () => {
  it('a strict leg is credited on the public release() path', () => {
    // The composer's own token goes to the leg, the leg rejects it, and the
    // fallback has to reach the count. Before the fallback this was a silently lost
    // credit — `release()` swallowed the throw and moved on to the next leg.
    const leg = strictLeg({ available: 10 });
    const r = new PowerRateLimit([leg], { atomic: true });

    const token = r.reserve(1);
    expect(token).toEqual({ n: 1 });
    r.release(token);

    // The foreign token *was* offered — that is the documented behaviour and two
    // tests elsewhere pin it — so what matters is that the credit still lands.
    expect(callsTo(leg, 'release')).toHaveLength(1);
    // Unrecognised, as documented: this path passes the *composer's* token, which
    // no leg minted. The credit still lands via the count fallback.
    expect(leg.presented).toEqual([false]);
    expect(callsTo(leg, 'rollback').concat(callsTo(leg, 'addTokens'))).toContain(1);
  });

  it('a leg that reads only .n is credited, and does not need the fallback', () => {
    // The shape `PowerThrottle` implements, and the reason the two paths have been
    // able to disagree unnoticed: this leg cannot tell the composer's token from its
    // own.
    const leg = strictLeg({ available: 10 });
    leg.release = (tokenOrN) => {
      leg.calls.push(['release', tokenOrN]);
      const n =
        typeof tokenOrN === 'object' && tokenOrN !== null ? Number(tokenOrN.n) || 0 : +tokenOrN;
      if (n === 0) throw new TypeError('release: nothing to credit');
    };
    const r = new PowerRateLimit([leg], { atomic: true });
    r.release(r.reserve(1));

    expect(callsTo(leg, 'release')).toHaveLength(1);
    // No fallback was needed, which is the whole point of accepting both shapes.
    expect(callsTo(leg, 'rollback')).toEqual([]);
    expect(callsTo(leg, 'addTokens')).toEqual([]);
  });

  it('the rollback path hands the leg the token the leg itself minted', () => {
    // `_undoCommit` is given the leg's own token, because the leg is the only thing
    // that could have minted it. This is the other half of the disagreement, and it
    // is the reason a leg must accept "either shape": the public path cannot offer
    // this and the internal path cannot offer the composer's.
    const first = strictLeg(); // no `available()`, so the two-phase path runs
    const second = strictLeg({ refuseReserve: true }); // the later leg fails

    const r = new PowerRateLimit([first, second], { atomic: true });
    expect(r.tryConsume(1)).toBe(false);

    expect(callsTo(first, 'release')).toHaveLength(1);
    // **The point of the test, stated as a single boolean:** the rollback path
    // handed this leg a token it recognises as its own. `true` here and `false` on
    // the public path below is the whole disagreement, measured from the leg.
    expect(first.presented).toEqual([true]);
    // And no fallback was needed, which is what recognising it buys.
    expect(callsTo(first, 'rollback')).toEqual([]);
  });

  it('PowerThrottle composes and releases without either path noticing', () => {
    // The regression guard for the real helper rather than a fake: if either undo
    // path were changed to hand `PowerThrottle` something it cannot read, its token
    // count would not come back and this would fail.
    const throttle = new PowerThrottle({ capacity: 2, refillRate: 0 });
    const r = new PowerRateLimit([throttle], { atomic: true });

    expect(r.tryConsume(2)).toBe(true);
    expect(r.available()).toBe(0);
    r.release(2);
    // Capacity 2, two consumed, two returned - the tokens come all the way back,
    // which is the property that would break first if either path handed the
    // throttle something it could not read.
    expect(r.available()).toBe(2);
  });
});
