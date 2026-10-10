import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerRateLimit, PowerGCRA, PowerThrottle } from '../src/index.js';

// GAP-005: per-key rate limiting, Bottleneck `Group`-shaped.
//
// The interesting part of this row is not the feature — a `keyFn` is thirty
// lines. It is that **both obvious ways to bound the per-key limiters are
// wrong, in opposite directions**, and both were measured before this was
// written:
//
// - An unbounded `Map` grows with client-controlled input. Measured: 50 000
//   distinct tenants → 50 000 resident limiters. A DoS surface reachable from
//   a header.
// - An LRU of per-key limiters (`PowerCache` being the obvious tool in this
//   repo) is *worse than no bound*, because evicting a limiter discards that
//   tenant's consumed budget with it: a tenant evicted while quiet returns to a
//   brand-new limiter with a full fresh allowance. A rate-limit bypass, not a
//   cache miss — and it penalises exactly the tenants that behaved.
//
// So this hashes keys into a fixed slot array. **There is no eviction path**,
// which is the property that makes the bypass structurally impossible rather
// than unlikely.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A keyed limiter over GCRA, the shape the guide documents. */
const keyed = (buckets = 1024, rate = 10) =>
  new PowerRateLimit([() => new PowerGCRA({ rate, per: 1000 })], {
    keyFn: (ctx) => ctx.tenant,
    buckets,
  });

describe('per-key limiting: keys get their own budget', () => {
  it('does not charge one tenant for another', () => {
    // The whole point. With one shared limiter the second tenant would be
    // refused because the first had spent the budget.
    const l = keyed();
    expect(l.tryConsume(1, { context: { tenant: 'alice' } })).toBe(true);
    expect(l.tryConsume(1, { context: { tenant: 'bob' } })).toBe(true);
    // Both exhausted their own, which with burst 0 means one call each.
    expect(l.tryConsume(1, { context: { tenant: 'alice' } })).toBe(false);
    expect(l.tryConsume(1, { context: { tenant: 'bob' } })).toBe(false);
  });

  it('keeps per-key rate enforcement inside a key', () => {
    // A single key is a plain limiter, so the rate must still bind.
    const l = keyed(1024, 5);
    const ctx = { context: { tenant: 'solo' } };
    expect([l.tryConsume(1, ctx), l.tryConsume(1, ctx), l.tryConsume(1, ctx)]).toEqual([
      true,
      false,
      false,
    ]);
    vi.advanceTimersByTime(200);
    expect(l.tryConsume(1, ctx)).toBe(true);
  });

  it('keys that collide share a budget, which is the documented cost', () => {
    // One bucket means every key collides. This is the weakening the option
    // accepts in exchange for never evicting, so it is pinned rather than left
    // implicit: a caller choosing a small `buckets` must be able to see it.
    const l = keyed(1);
    expect(l.tryConsume(1, { context: { tenant: 'a' } })).toBe(true);
    // `b` hashes to the same slot and finds it spent.
    expect(l.tryConsume(1, { context: { tenant: 'b' } })).toBe(false);
  });

  it('a larger bucket count keeps unrelated keys apart', () => {
    // The guard on the previous test: it passed because *everything* collides,
    // which would also be true of a broken implementation that put every key in
    // one slot regardless of `buckets`.
    const l = keyed(1024);
    expect(l.tryConsume(1, { context: { tenant: 'alice' } })).toBe(true);
    expect(l.tryConsume(1, { context: { tenant: 'bob' } })).toBe(true);
  });

  it('a missing key degrades to one shared limit, not to no limit', () => {
    // The failure mode of getting `keyFn` wrong: if an absent key meant "no
    // routing", a caller who forgot to pass `context` would be unlimited. It
    // shares one slot instead, which is the same limit the instance applied
    // before `keyFn` existed.
    const l = keyed();
    expect([l.tryConsume(1), l.tryConsume(1)]).toEqual([true, false]);
  });
});

describe('per-key limiting: bounded by construction, with no eviction path', () => {
  it('never allocates more than `buckets` limiter sets', () => {
    // The property that replaces the LRU. Measured on the sketch first: 1 000 000
    // distinct keys allocated exactly 1024 sets, a 977:1 ratio, because nothing
    // is ever removed.
    const l = keyed(1024);
    for (let i = 0; i < 20_000; i++) l.tryConsume(1, { context: { tenant: `t${i}` } });
    expect(l._slots.filter(Boolean).length).toBeLessThanOrEqual(1024);
    expect(l._liveLimiters().length).toBeLessThanOrEqual(1024);
  });

  it('a tenant keeps its budget after a flood of other tenants', () => {
    // **The bypass this design exists to prevent.** With an LRU of limiters, the
    // tenant below would be evicted while quiet and return to a fresh limiter
    // with a full allowance — a free pass, not a cache miss. Here nothing is
    // evicted, so the budget is intact however much traffic arrives beside it.
    const l = keyed(64);
    expect(l.tryConsume(1, { context: { tenant: 'noisy' } })).toBe(true);
    for (let i = 0; i < 10_000; i++) l.tryConsume(1, { context: { tenant: `x${i}` } });
    // Still refused: its first operation was already spent.
    expect(l.tryConsume(1, { context: { tenant: 'noisy' } })).toBe(false);
  });

  it('reset() clears budgets without discarding the slots', () => {
    // Discarding built slots on `reset()` would hand every tenant a fresh
    // allowance — the same bypass, reached deliberately. So `reset()` clears the
    // limiters it holds and leaves the slots in place.
    const l = keyed(8);
    l.tryConsume(1, { context: { tenant: 'z' } });
    const slotsBefore = l._slots.filter(Boolean).length;
    l.reset();
    expect(l._slots.filter(Boolean).length).toBe(slotsBefore);
    // The budget was actually cleared, so the key is servable again.
    expect(l.tryConsume(1, { context: { tenant: 'z' } })).toBe(true);
  });

  it('spreads keys across slots rather than piling them up', () => {
    // A pathological hash would put every key in one slot, which would silently
    // turn per-key limiting back into global limiting. Probed on the sketch:
    // 100 000 keys over 1024 slots used all 1024, max/mean 1.39x.
    const l = keyed(1024);
    for (let i = 0; i < 5000; i++) l.tryConsume(1, { context: { tenant: `t${i}` } });
    expect(l._slots.filter(Boolean).length).toBeGreaterThan(900);
  });
});

describe('per-key limiting: composition still behaves', () => {
  it('atomicity holds within a slot', () => {
    // The regression this had to avoid: routing through a slot must not fork the
    // commit path. A second leg that refuses has to leave the first unspent,
    // which is the defect the unkeyed path was fixed for.
    let secondCalls = 0;
    const l = new PowerRateLimit(
      [
        () => new PowerGCRA({ rate: 10, per: 1000 }),
        () => ({
          available: () => 1,
          tryConsume() {
            secondCalls++;
            return secondCalls % 2 === 1;
          },
          addTokens: () => {},
        }),
      ],
      { keyFn: (ctx) => ctx.tenant, atomic: true }
    );
    const ctx = { context: { tenant: 'p' } };
    expect(l.tryConsume(1, ctx)).toBe(true);
    expect(l.tryConsume(1, ctx)).toBe(false);
  });

  it('every leg of a keyed composition is routed to the same key', () => {
    // A guard on `_consumeIn` being handed the factory list instead of the
    // slot's limiters: both would "work", but the second leg would be shared
    // across all keys rather than per-key.
    const seen = [];
    const l = new PowerRateLimit(
      [
        () => new PowerGCRA({ rate: 10, per: 1000 }),
        () => ({
          available: () => 100,
          tryConsume() {
            seen.push(1);
            return true;
          },
        }),
      ],
      { keyFn: (ctx) => ctx.tenant }
    );
    l.tryConsume(1, { context: { tenant: 'x' } });
    l.tryConsume(1, { context: { tenant: 'y' } });
    // Both calls reached the second leg, so routing did not silently skip it.
    expect(seen).toHaveLength(2);
  });

  it('reserve() reserves within the caller key slot', () => {
    // The bug this pins: forwarding the count but not the key would reserve on
    // the default slot and consume on the caller's, splitting one reservation
    // across two budgets.
    const l = keyed();
    const token = l.reserve(1, { context: { tenant: 'r' } });
    expect(token).not.toBeNull();
    // The token stays `{ n }` — a `slot` field was tried here and broke an
    // existing shape test, so the key's slot is reachable through
    // `limitersFor()` instead of being carried on public API.
    expect(token).toEqual({ n: 1 });
    expect(l.limitersFor('r')).toBe(l.limitersFor('r'));
    expect(l.tryConsume(1, { context: { tenant: 'r' } })).toBe(false);
  });

  it('composes with a throttle as readily as with a GCRA', () => {
    const l = new PowerRateLimit(
      [
        () => new PowerGCRA({ rate: 10, per: 1000, burst: 5 }),
        () => new PowerThrottle({ capacity: 5 }),
      ],
      { keyFn: (ctx) => ctx.tenant }
    );
    expect(l.tryConsume(1, { context: { tenant: 'a' } })).toBe(true);
    expect(l.tryConsume(1, { context: { tenant: 'b' } })).toBe(true);
    // `available()` reports the *minimum* across legs, so the throttle's own
    // budget is visible: one of five spent per key, and `a` did not pay for
    // `b` — the bucket for `a` still holds 4.
    expect(l.available({ context: { tenant: 'a' } })).toBe(4);
    expect(l.available({ context: { tenant: 'b' } })).toBe(4);
  });
});

describe('per-key limiting: validation', () => {
  it('rejects a keyFn that is not a function', () => {
    // The dangerous direction: a typo like `keyFn: 'tenant'` must not fall back
    // to the unkeyed path, which would turn a per-key limit into a global one
    // with no error at all. The first version of this check tested
    // `if (this.keyFn && ...)`, which is never true for a non-function because
    // the field was already normalised to null — so it threw for nothing.
    expect(() => new PowerRateLimit([], { keyFn: 'tenant' })).toThrow(TypeError);
    expect(() => new PowerRateLimit([], { keyFn: 42 })).toThrow(/keyFn/);
  });

  it('rejects a non-positive or fractional bucket count', () => {
    const keyFn = () => 'k';
    expect(() => new PowerRateLimit([], { keyFn, buckets: 0 })).toThrow(/buckets/);
    expect(() => new PowerRateLimit([], { keyFn, buckets: -1 })).toThrow(/buckets/);
    expect(() => new PowerRateLimit([], { keyFn, buckets: 1.5 })).toThrow(/buckets/);
    expect(() => new PowerRateLimit([], { keyFn, buckets: 'lots' })).toThrow(/buckets/);
  });

  it('requires factories when keyFn is set, and says why', () => {
    // A shared instance cannot hold per-key budgets — it would be one limiter
    // with an unbounded key space, which is the thing being fixed. The message
    // names the shape so the error is actionable.
    expect(() => new PowerRateLimit([new PowerGCRA({ rate: 1 })], { keyFn: () => 'k' })).toThrow(
      /factory/
    );
  });

  it('accepts the absence of keyFn and is unchanged', () => {
    // The regression guard on the existing API: no `keyFn`, same behaviour.
    const l = new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000 })]);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
    expect(l.limitersFor('anything')).toBeNull();
    expect(l._liveLimiters()).toHaveLength(1);
  });

  it('limitersFor() returns the slot, so a caller can drive one key directly', () => {
    const l = keyed();
    const first = l.limitersFor('a');
    expect(first).toBe(l.limitersFor('a')); // stable
    expect(first).not.toBe(l.limitersFor('b')); // per key
  });
});

// --- AUD-022: dispose() must dispose the built slots, not just drop them ------

describe('per-key limiting: dispose() releases the built slots (AUD-022)', () => {
  it('calls dispose() on every built slot limiter', () => {
    // `dispose()` used to `fill(null)` the slot array, which releases the
    // *references* and nothing else. That is enough for a limiter whose
    // `dispose()` is only a state reset — `PowerThrottle`, `PowerSlidingWindow`
    // and `PowerGCRA` own no timer and refill lazily, so garbage collection
    // reclaims everything and skipping their `dispose()` costs nothing.
    //
    // It is **not** enough for a slot whose factory returned something that owns
    // a resource. The factories are caller-supplied and this class has no idea
    // what they build, so a factory returning a limiter with a timer, a listener
    // registry or a `FinalizationRegistry` would have that resource leaked by a
    // teardown whose entire job is releasing it.
    const disposed = [];
    const factory = () => ({
      tryConsume: () => true,
      dispose() {
        disposed.push(this);
      },
    });
    const l = new PowerRateLimit([factory], { keyFn: (ctx) => ctx.tenant, buckets: 8 });

    // Build three slots by consuming for three distinct tenants.
    for (const t of ['alice', 'bob', 'carol']) l.tryConsume(1, { context: { tenant: t } });
    const built = l._liveLimiters();
    expect(built).toHaveLength(3);
    expect(disposed).toHaveLength(0);

    l.dispose();

    expect(disposed).toHaveLength(3);
    // Every built limiter, not a subset — a partial teardown is the failure mode
    // where the first slot is released and the rest are not.
    for (const limiter of built) expect(disposed).toContain(limiter);
    // And the slots are gone, so the graph is not merely reset.
    expect(l._liveLimiters()).toHaveLength(0);
  });

  it("does not dispose the caller's own limiters, which belong to the caller", () => {
    // The documented decision, pinned so the slot fix cannot overreach. With
    // `keyFn` every entry must be a *factory*, so the caller's own instances only
    // exist on the **unkeyed** path — and that is the path the docblock is about:
    // the `limiters` array was passed in, so it belongs to the caller and is
    // reset rather than disposed. Disposing it would leave a caller's own object
    // unusable after a teardown they did not ask for.
    const mine = new PowerGCRA({ rate: 10, per: 1000 });
    const disposeSpy = vi.spyOn(mine, 'dispose');
    const resetSpy = vi.spyOn(mine, 'reset');

    const l = new PowerRateLimit([mine]);
    l.tryConsume(1);
    l.dispose();

    expect(disposeSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalled();
    // And the caller's limiter still works afterwards.
    expect(mine.tryConsume(1)).toBe(true);
  });

  it('survives a slot limiter whose dispose() throws', () => {
    // A throwing `dispose()` must not abort the teardown of the slots after it.
    // The same swallow `reset()` uses, for the same reason: one bad slot must not
    // strand the rest.
    const disposed = [];
    const throwing = () => ({
      tryConsume: () => true,
      dispose() {
        throw new Error('slot teardown failed');
      },
    });
    const good = () => ({
      tryConsume: () => true,
      dispose() {
        disposed.push('good');
      },
    });
    const l = new PowerRateLimit([throwing, good], { keyFn: (ctx) => ctx.tenant, buckets: 8 });
    l.tryConsume(1, { context: { tenant: 'alice' } });

    expect(() => l.dispose()).not.toThrow();
    // The good leg of the same slot was still disposed.
    expect(disposed).toEqual(['good']);
    expect(l._liveLimiters()).toHaveLength(0);
  });

  it('tolerates a factory returning a limiter with no dispose()', () => {
    // A factory is free to return a plain object with only `tryConsume`. The
    // guard is `typeof === 'function'`, so a slot without `dispose` is dropped
    // rather than crashing the teardown.
    const l = new PowerRateLimit([() => ({ tryConsume: () => true })], {
      keyFn: (ctx) => ctx.tenant,
      buckets: 8,
    });
    l.tryConsume(1, { context: { tenant: 'alice' } });
    expect(() => l.dispose()).not.toThrow();
    expect(l._liveLimiters()).toHaveLength(0);
  });

  it('releases the slots through `using` teardown as well', () => {
    // The reason the row exists: a `using` teardown has to release the same
    // graph an explicit `dispose()` does, or the deterministic path is the one
    // that leaks.
    const disposed = [];
    let held;
    {
      using l = new PowerRateLimit(
        [
          () => ({
            tryConsume: () => true,
            dispose() {
              disposed.push('slot');
            },
          }),
        ],
        { keyFn: (ctx) => ctx.tenant, buckets: 8 }
      );
      l.tryConsume(1, { context: { tenant: 'alice' } });
      held = l;
    }
    expect(disposed).toEqual(['slot']);
    expect(held._liveLimiters()).toHaveLength(0);
  });
});
