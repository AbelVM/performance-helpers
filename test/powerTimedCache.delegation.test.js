import { describe, it, expect } from 'vitest';
import { PowerTimedCache, PowerCache } from '../src/index.js';

/**
 * CACHE-013: `PowerTimedCache` forwarded fifteen `PowerCache` methods and drew the
 * line at an arbitrary place — `peek`, `touch`, `resize`, `getOrSet`,
 * `getOrSetAsync`, `setMany`, `getMany` and `hasEqual` all existed on the inner cache
 * and not on the wrapper.
 *
 * ## Delegation, not reimplementation
 *
 * The row offered two answers, delegate or document the subset. Delegation won, and
 * the deciding test was not taste: **none of the eight needs TTL-specific logic**, so
 * a reimplementation would be eight chances to introduce a bug that a forward cannot
 * have. The sharpest case is `touch(key, ttl)`. A wrapper that forgot to pass the
 * per-call TTL through would not throw — it would silently extend every entry to the
 * constructor's TTL, expiring things at the wrong time. The tests below therefore
 * check **that the argument arrives**, not merely that the method exists.
 *
 * ## The second defect: `set()` returned the wrong object
 *
 * Found while reading the code the row pointed at. `PowerCache.set` returns `this` —
 * the inner `PowerCache` — and `PowerTimedCache.set` forwarded that unchanged while
 * its JSDoc promised `{false|PowerTimedCache}`. So `timed.set('a', 1).set('b', 2)`
 * type-checked as a `PowerTimedCache` chain and then **ran on the inner object**. Not
 * a crash: the inner cache is the same store, so the data lands. It is a published
 * type that lied about which class you were holding, which is the same failure
 * AGENTS.md records for the nine hand-copied `getStats()` return shapes.
 *
 * `setMany` would have inherited exactly the same lie — it returns `{this}` on the
 * inner cache — so it is corrected in the same pass rather than left to be discovered
 * by the next reader.
 */

/** A short TTL and a controllable clock are not available here, so use real expiry. */
const shortTtl = () => new PowerTimedCache(20);

describe('CACHE-013: the eight delegated methods reach the same store', () => {
  it('peek reads without promoting, and reports a miss as undefined', () => {
    const c = new PowerTimedCache(1000);
    c.set('a', 1);
    c.set('b', 2);
    // `b` is most-recently-used; `a` is next. Peeking `b` must not promote it, or the
    // recency order the following keys() walk reveals would change.
    expect(c.peek('b')).toBe(2);
    expect([...c.keys()]).toEqual(['b', 'a']);
    expect(c.peek('missing')).toBeUndefined();
    c.dispose();
  });

  it('peek does not count as a hit, which is the reason it exists', () => {
    // If `peek` were `get`, it would inflate `hitRate` — and a caller using it to
    // *avoid* the recency cost would silently be paying for a promotion anyway.
    const c = new PowerTimedCache(1000);
    c.set('a', 1);
    const before = c.stats().hits;
    c.peek('a');
    expect(c.stats().hits).toBe(before);
    c.dispose();
  });

  it('touch extends one entry without reading or rewriting its value', async () => {
    const c = shortTtl();
    c.set('a', 'original');
    // Half the TTL: still present after the original deadline would have passed.
    await new Promise((r) => setTimeout(r, 12));
    expect(c.touch('a', 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    // Past the *original* 20 ms TTL. Only the forwarded argument keeps it alive.
    expect(c.get('a')).toBe('original');
    c.dispose();
  });

  it('touch reports false for a missing or expired entry rather than creating one', () => {
    const c = shortTtl();
    expect(c.touch('never-set')).toBe(false);
    expect(c.size).toBe(0);
    c.dispose();
  });

  it('getOrSet computes once and serves the cached value afterwards', () => {
    const c = new PowerTimedCache(1000);
    let calls = 0;
    const factory = () => {
      calls += 1;
      return 'made';
    };
    expect(c.getOrSet('k', factory)).toBe('made');
    expect(c.getOrSet('k', factory)).toBe('made');
    expect(calls).toBe(1);
    c.dispose();
  });

  it('getOrSet accepts a plain value as well as a factory', () => {
    // The inner signature is `Function|*`, so `getOrSet('k', 42)` is legal. A wrapper
    // that assumed a function would throw on the most obvious call there is.
    const c = new PowerTimedCache(1000);
    expect(c.getOrSet('k', 42)).toBe(42);
    expect(c.get('k')).toBe(42);
    c.dispose();
  });

  it('getOrSetAsync resolves, and the single-flight behaviour is the inner one', async () => {
    const c = new PowerTimedCache(1000);
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return 'async-made';
    };
    const [a, b] = await Promise.all([
      c.getOrSetAsync('k', factory),
      c.getOrSetAsync('k', factory),
    ]);
    expect(a).toBe('async-made');
    expect(b).toBe('async-made');
    // Concurrent callers coalesce onto one factory call. This is the behaviour a
    // reimplementation would have had to reproduce; forwarding cannot lose it.
    expect(calls).toBe(1);
    c.dispose();
  });

  it('resize changes the live capacity', () => {
    const c = new PowerTimedCache(1000, { maxEntries: 10 });
    for (let i = 0; i < 10; i += 1) c.set(`k${i}`, i);
    expect(c.size).toBe(10);
    c.resize({ maxEntries: 2 });
    c.set('overflow', 1);
    expect(c.size).toBeLessThanOrEqual(2);
    c.dispose();
  });

  it('setMany inserts a batch and returns the wrapper for chaining', () => {
    const c = new PowerTimedCache(1000);
    const returned = c.setMany([
      ['a', 1],
      ['b', 2],
    ]);
    // The inner `setMany` returns the inner `PowerCache`. Asserted on identity, not
    // on `toBeInstanceOf`, because the wrapper is not a subclass and that would pass
    // for the wrong reason.
    expect(returned).toBe(c);
    expect(returned).not.toBe(c.cache);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
    c.dispose();
  });

  it('getMany omits misses rather than returning undefined for them', () => {
    const c = new PowerTimedCache(1000);
    c.setMany([
      ['a', 1],
      ['b', 2],
    ]);
    const out = c.getMany(['b', 'missing', 'a']);
    expect(out).toBeInstanceOf(Map);
    // **Two entries for three keys.** The inner loop at `powerCache.js:1947` does
    // `if (!node) continue`, so a miss is dropped rather than mapped to `undefined`.
    // My first draft asserted one entry per requested key and the run said otherwise
    // — which is the whole reason to read the loop instead of assuming a `Map` of
    // lookups. The resolved keys keep input order.
    expect([...out.keys()]).toEqual(['b', 'a']);
    expect(out.size).toBe(2);
    expect(out.get('a')).toBe(1);
    expect(out.has('missing')).toBe(false);
    c.dispose();
  });

  it('getMany forwards ignoreExpiry, so an expired entry can still be read', async () => {
    // Added because a mutant that hard-codes `ignoreExpiry: false` **survived**: every
    // other case read a live key, so dropping the argument changed nothing. A
    // forwarding bug in an option that only matters on the expired path is invisible
    // until someone relies on it — the same class of defect the `touch` TTL case
    // exists for, one method over.
    //
    // **The order of these assertions is the whole test.** Two earlier drafts put
    // `get(a)` first, "to show it is expired" — and a plain `get` on an expired entry
    // *removes* it (`_fetchValidNode` calls `_removeExpiredNode`), so the control
    // destroyed its own subject and the forwarding assertion could never pass. The
    // long `interval` added to compensate was also wrong: no sweep had run, and the
    // removal was mine. Reading the node with `ignoreExpiry` **first** is what proves
    // it is present-but-expired, which is the only state the flag distinguishes.
    const c = new PowerTimedCache(20, { interval: 100_000 });
    c.set('a', 'live');
    await new Promise((r) => setTimeout(r, 30)); // past the 20 ms TTL

    // Present but expired — the state `ignoreExpiry` exists to describe.
    expect(c.getMany(['a'], { ignoreExpiry: true }).get('a')).toBe('live');
    expect(c.has('a', { ignoreExpiry: true })).toBe(true);

    // And without the flag the same entry is a miss, which is what makes the two
    // assertions above meaningful rather than tautological.
    expect(c.getMany(['a']).has('a')).toBe(false);

    // A plain read collects it, which is why it has to come last.
    expect(c.get('a')).toBeUndefined();
    expect(c.getMany(['a'], { ignoreExpiry: true }).has('a')).toBe(false);
    c.dispose();
  });

  it('resize forwards maxWeight, so a weighted cache can be shrunk at runtime', async () => {
    // Also a survivor: `resize({ maxEntries })` alone passed every test, because no
    // test resized a *weighted* cache. The inner `resize` honours whichever bound it
    // is given, so dropping one is invisible until the other is also set.
    const c = new PowerTimedCache(1000, {
      cacheOptions: { maxWeight: 100, weightFn: (v) => String(v).length, policy: 'LRU' },
    });
    c.set('a', 'x'.repeat(60));
    c.set('b', 'y'.repeat(30));
    expect(c.size).toBe(2);
    c.resize({ maxWeight: 50 });
    // The 60-byte entry alone exceeds the new bound; the 30-byte one fits.
    expect(c.size).toBeLessThanOrEqual(1);
    expect(c.get('b')).toBe('y'.repeat(30));
    expect(c.get('a')).toBeUndefined();
    c.dispose();
  });

  it('hasEqual compares deeply, and leaves recency alone', () => {
    // **Deep, not reference-equal.** My first draft asserted prototype-strict
    // equality and failed: `hasEqual` falls through to a `deepEqual` walk once the
    // reference and primitive fast paths miss, so a stored `{deep: 1}` does match an
    // incoming `{deep: 1}`.
    const c = new PowerTimedCache(1000);
    c.set('a', { deep: 1 });
    c.set('b', 2);
    expect(c.hasEqual('a', { deep: 1 })).toBe(true);
    expect(c.hasEqual('a', { deep: 2 })).toBe(false);
    // The quirk that *is* worth pinning is the recency one, because it is what a
    // caller relies on to use this as a cheap membership test: no promotion.
    expect([...c.keys()]).toEqual(['b', 'a']);
    c.hasEqual('a', { deep: 1 });
    expect([...c.keys()]).toEqual(['b', 'a']);
    c.dispose();
  });

  it('every delegated method exists on the inner cache too, so nothing is a reimplementation', () => {
    // The structural assertion, and the reason the whole change is eight forwards:
    // each name on the wrapper must be the same name on `PowerCache`. If one ever
    // stops matching, the delegation has become a fork.
    const delegated = [
      'peek',
      'touch',
      'resize',
      'getOrSet',
      'getOrSetAsync',
      'setMany',
      'getMany',
      'hasEqual',
    ];
    for (const name of delegated) {
      expect(typeof new PowerTimedCache(1000)[name], `wrapper ${name}`).toBe('function');
      expect(typeof PowerCache.prototype[name], `inner ${name}`).toBe('function');
    }
  });
});

describe('CACHE-013: set() and setMany() return the wrapper, not the inner cache', () => {
  it('set returns the PowerTimedCache so a chain stays on the wrapper', () => {
    const c = new PowerTimedCache(1000);
    const returned = c.set('a', 1);
    // The defect: this used to be `c.cache`, while the JSDoc said `PowerTimedCache`.
    expect(returned).toBe(c);
    expect(returned).not.toBe(c.cache);
    // And the chain a caller would actually write now runs on the wrapper.
    expect(returned.set('b', 2)).toBe(c);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
    c.dispose();
  });

  it('set still returns false on the oversize refusal, not the wrapper', () => {
    // The other half. `PowerCache.set` refuses an oversized entry by returning
    // `false`, and a truthiness rewrite would turn that refusal into a chainable
    // success — the worst possible outcome, since the caller would go on to use a
    // cache that never stored the value.
    //
    // This needed CACHE-013's *option* fix to be writable at all: the refusal at
    // `powerCache.js:1543` gates on `this.rejectOversized && isFinite(this.maxWeight)`,
    // and neither option was in the wrapper's allowlist, so a weighted TTL cache was
    // inexpressible and my first draft configured `maxWeight` on a wrapper that
    // silently dropped it — `set` returned the wrapper and the test failed for a
    // reason that had nothing to do with the return value.
    const c = new PowerTimedCache(1000, {
      cacheOptions: { maxWeight: 10, rejectOversized: true },
    });
    expect(c.set('fits', 'small', { weight: 1 })).toBe(c);
    expect(c.set('too-big', 'x'.repeat(100), { weight: 100 })).toBe(false);
    expect(c.get('too-big')).toBeUndefined();
    c.dispose();
  });

  it('the published return type and the runtime value agree', () => {
    // The reason this was worth fixing: the JSDoc said `{false|PowerTimedCache}` and
    // the value was a `PowerCache`. Asserted behaviourally, since that is what a
    // consumer depends on.
    const c = new PowerTimedCache(1000);
    const returned = c.set('k', 'v');

    returned.hitRate; // a PowerTimedCache member; would be `undefined` on a bare object
    expect(returned.hitRate).toBeTypeOf('number');
    expect(returned.size).toBe(1);
    c.dispose();
  });
});

describe('CACHE-013: the option surface, which was the larger half of the defect', () => {
  /**
   * Eight missing *methods* turned out to be the smaller half. The wrapper's
   * `cacheOptions` allowlist was `['ttl', 'weight', 'cacheOptions']` — which is
   * `PowerMemoizer`'s list minus `keyResolver`, so it looks like a copy from the wrong
   * class rather than a decision. It left **21 of `PowerCache`'s 23 options
   * unreachable**, and two of those made the delegated methods inert:
   *
   * - `maxWeight` / `rejectOversized` — a *weighted* TTL cache was inexpressible.
   * - `staleTtl` — `_staleServable` reads only `staleTtl`, which defaults to 0, and
   *   `now <= expiresAt + 0` is false for every expired entry. So the
   *   `staleWhileRevalidate` option that `getOrSet` and `getOrSetAsync` accept was
   *   **silently a no-op**: a caller passing it got ordinary expiry and no error.
   *   That is the failure mode this row is about, one level down.
   */
  it('accepts a weighted configuration, which it previously rejected outright', () => {
    const c = new PowerTimedCache(1000, {
      cacheOptions: { maxWeight: 10, rejectOversized: true, weightFn: (v) => String(v).length },
    });
    c.set('a', 'abc');
    expect(c.get('a')).toBe('abc');
    // And the weight function is the caller's, reached through the wrapper.
    c.set('b', 'x'.repeat(50));
    expect(c.get('b')).toBeUndefined();
    c.dispose();
  });

  it('makes staleWhileRevalidate functional rather than silently inert', async () => {
    // The end-to-end consequence, and the reason this was not cosmetic. Without
    // `staleTtl` the per-call flag does nothing at all — which is why the first draft
    // of the delegation work shipped an option that could not function.
    const c = new PowerTimedCache(20, {
      cacheOptions: { allowStale: true, staleTtl: 500 },
    });
    let calls = 0;
    const factory = () => {
      calls += 1;
      return `made-${calls}`;
    };
    expect(c.getOrSet('k', factory)).toBe('made-1');
    await new Promise((r) => setTimeout(r, 40)); // past the 20 ms TTL, inside staleTtl
    // Expired, but servable: the stale value comes back immediately and the refresh
    // happens behind it. A wrapper that dropped `staleTtl` would return `made-2`.
    const stale = c.getOrSet('k', factory, { staleWhileRevalidate: true });
    expect(stale).toBe('made-1');
    await new Promise((r) => setTimeout(r, 10));
    expect(c.get('k')).toBe('made-2');
    c.dispose();
  });

  it('rejects defaultTTL, the one option the constructor owns', () => {
    // Allowed-and-ignored is the pattern this review treats as a defect, so it is
    // refused outright instead. `cfg.defaultTTL = +ttl` is assigned *after* the copy,
    // so the constructor's TTL wins regardless; accepting the option would only ever
    // mislead. Nothing could pass it before this change — it was not on the old
    // allowlist either — so this is not a break.
    expect(() => new PowerTimedCache(1000, { cacheOptions: { defaultTTL: 5 } })).toThrow(
      /defaultTTL/
    );
  });

  it('rejects an unknown option, so widening the list did not make it permissive', () => {
    // Widening an allowlist is exactly where a typo becomes silently accepted.
    expect(() => new PowerTimedCache(1000, { cacheOptions: { nonsenseOption: 1 } })).toThrow(
      /nonsenseOption/
    );
  });

  it('reaches exactly the options the inner cache enforces, and no others', () => {
    // **Derived from the inner cache's own error message**, which prints the enforced
    // set. My first three attempts at this assertion hand-listed the options, and
    // every one was wrong: once with four names the cache does not accept, once
    // missing `seed`, and once matching a *different* `assertKnownOptions` call I had
    // mistaken for this constructor's. Four copies of one 22-item list in a single
    // change is how they all came to disagree.
    //
    // So the oracle is the contract itself. If `PowerCache` gains or drops an option,
    // this test moves with it; if the wrapper drifts from it, this fails.
    let enforced;
    try {
      new PowerCache({ definitelyNotAnOption: 1 });
    } catch (err) {
      const m = err.message.match(/Accepted options: (.+)\.$/);
      expect(m, `could not read the enforced option list from: ${err.message}`).toBeTruthy();
      enforced = m[1].split(', ');
    }
    expect(enforced.length, 'the inner list was not read at all').toBeGreaterThan(10);

    const unreachable = [];
    for (const option of enforced) {
      // `defaultTTL` is the one the constructor owns, and is refused on purpose.
      if (option === 'defaultTTL') continue;
      try {
        new PowerTimedCache(1000, { cacheOptions: { [option]: undefined } }).dispose();
      } catch (err) {
        unreachable.push(`${option}: ${err.message.slice(0, 60)}`);
      }
    }
    expect(unreachable, 'these are accepted by PowerCache but not by the wrapper').toEqual([]);
  });
});
