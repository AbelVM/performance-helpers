/**
 * `PowerRateLimit.release()` must refund the slot that was debited — RES-039.
 *
 * **The defect.** `release()` iterated `_liveLimiters()`, which under `keyFn` is
 * *every built slot*, while `reserve()`/`tryConsume` debit *one* slot via
 * `_slotFor(key)`. So a refund for one tenant's spend was applied to every other
 * tenant. Reproduced with real limiters at capacity 5: tenant A spends 4, tenant B
 * spends 1, and `release(4)` left **both at 5** — B fully refunded for a spend it
 * never made. `PowerThrottle.release` clamps at `capacity`, which bounds the damage
 * but points it the wrong way: a fully drained tenant is topped back *up to full* by
 * another tenant's refund, which is exactly the tenant a noisy neighbour starves.
 *
 * **The keys in the first test are chosen not to collide, and that is the whole
 * point of the fixture.** Two keys landing in the same bucket is *not* this bug — it
 * is the documented design of a bucketed keyed limiter, and a test that used a
 * colliding pair would pass with the defect still in place, because a shared slot
 * being refunded twice looks identical to a correct single-slot refund. The hash is
 * FNV-1a modulo `buckets`; `A` and `B` land in buckets 0 and 1 of 2, asserted below
 * so a future change to the hashing cannot quietly turn this into a colliding pair
 * and neuter the test.
 *
 * **Why the fix is a per-call `options.key` and not a slot field on the token.** The
 * token is public API and `toEqual({ n: 1 })` is pinned by a test in
 * `powerRateLimit.extra.test.js`; a previous attempt to add a field for testing
 * broke that and was reverted. `options.key` is the convention `tryConsume` and
 * `available()` already use, so it changes nothing a caller can already observe.
 */
import { describe, it, expect } from 'vitest';
import { PowerRateLimit, PowerThrottle } from '../src/index.js';

/**
 * One capacity-5 throttle per factory, no refill, so nothing drifts.
 *
 * One limiter per factory, **not** an array of them: the constructor stores
 * `factories.map((f) => f(index))`, so a factory returning an array puts an array
 * in the slot, and an array has no `tryConsume`. That fails quietly rather than
 * loudly — `available()` answers `0` for a leg it cannot price — so it is worth
 * stating here rather than letting the next person rediscover it.
 */
const slotFactory = () => new PowerThrottle({ capacity: 5, refillRate: 0 });

/**
 * The bucket a key lands in, replicating `_slotFor`'s FNV-1a.
 *
 * Duplicated rather than read from the instance so the *fixture* is self-checking:
 * if the hash ever changes, this fails loudly instead of the collision assertion
 * below quietly becoming true for the wrong reason.
 *
 * @param {string} key
 * @param {number} buckets
 * @returns {number}
 */
const bucketOf = (key, buckets) => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % buckets;
};

describe('PowerRateLimit.release refunds only the slot it was given', () => {
  it('does not credit a tenant that was never debited', () => {
    const BUCKETS = 2;
    // The fixture's own precondition, asserted rather than assumed.
    expect(bucketOf('A', BUCKETS)).not.toBe(bucketOf('B', BUCKETS));

    const r = new PowerRateLimit([slotFactory, slotFactory], {
      keyFn: (o) => o.key,
      buckets: BUCKETS,
    });

    r.tryConsume(4, { key: 'A' });
    r.tryConsume(1, { key: 'B' });
    expect(r.available({ key: 'A' })).toBe(1);
    expect(r.available({ key: 'B' })).toBe(4);

    r.release(4, { key: 'A' });

    // A is made whole…
    expect(r.available({ key: 'A' })).toBe(5);
    // …and B is untouched. This is the assertion the defect failed: it read 5.
    expect(r.available({ key: 'B' })).toBe(4);
  });

  it('leaves an unkeyed release on the same shared slot tryConsume debited', () => {
    // Omitting `key` is not "refund everything" — it routes to the shared slot,
    // which is the same slot `tryConsume` without a key debits. Symmetry is the
    // property; if the two disagreed, a caller who never passes keys would be
    // over-credited or under-credited depending on which side they were on.
    const r = new PowerRateLimit([slotFactory, slotFactory], { keyFn: (o) => o.key, buckets: 2 });

    expect(r.tryConsume(3)).toBe(true);
    const before = r.available();
    expect(before).toBe(2);

    r.release(3);
    expect(r.available()).toBe(5);
    // Still the shared slot afterwards, not a reset of everything.
    expect(r.available({ key: 'A' })).toBe(5);
  });

  it('an unkeyed composer is unaffected', () => {
    // Without `keyFn` there is one leg set, so "every slot" and "the slot" are the
    // same thing. Pinned because the fix changed which helper this method reaches
    // for, and a regression there would be invisible to the keyed tests.
    const r = new PowerRateLimit([new PowerThrottle({ capacity: 4, refillRate: 0 })], {
      atomic: false,
    });
    expect(r.tryConsume(3)).toBe(true);
    expect(r.available()).toBe(1);
    r.release(3);
    expect(r.available()).toBe(4);
  });

  it('release(0) is still a no-op and does not build a slot', () => {
    // The early return precedes the routing on purpose: a zero refund must not
    // construct a slot for an absent key, or `release(0)` on an unused pool would
    // allocate one.
    const r = new PowerRateLimit([slotFactory, slotFactory], { keyFn: (o) => o.key, buckets: 2 });
    r.release(0, { key: 'nobody' });
    expect(r.available({ key: 'A' })).toBe(5);
  });
});
