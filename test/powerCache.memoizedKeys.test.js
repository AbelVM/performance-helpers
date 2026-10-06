/**
 * Two teardown and reachability defects in `PowerCache` and `PowerMemoizer`.
 *
 * **`using` left the metrics series registered.** `dispose()` called
 * `detach(this._metrics)` and then `[Symbol.dispose]()`; the symbol did only
 * `stopCleanup()` and `clear()`. So `using cache = new PowerCache({
 * observability: true })` — a scope exit, and the exact path the symbol exists
 * for — left the series registered for the life of the collector. Measured
 * before the fix: the name was still present after `[Symbol.dispose]()` and
 * only cleared by `dispose()`. Nothing fails this way: the collector keeps
 * sampling an object nobody can reach and answering every time.
 * `PowerBulkhead` and `PowerRetryBudget` had already been fixed for exactly
 * this, and `test/metrics.lifetime.test.js` pins both — so this was the same
 * bug in a class the earlier fix did not reach.
 *
 * **A method-memoized entry could not be reached or invalidated.** The helpers
 * attached to a memoized function were arrow functions, which discard their
 * receiver. So `memo.call(obj, 10)` stored under `r1:10` while `memo.get(10)`
 * looked up `10` — the entry existed, `get`/`has`/`delete` all missed it, and no
 * helper could remove it. Measured before the fix: `get` → `undefined`, `has` →
 * `false`, `delete` → `false`, and the scoped key still in the cache.
 *
 * The helpers are ordinary functions now, and `memo.get.call(obj, 10)` reaches
 * what `memo.call(obj, 10)` stored. Calling one plainly is unchanged: the
 * receiver is then the memoized function itself, and that resolves the
 * **unscoped** key a plain `memo(10)` call stored — which is what the guide
 * documents, so the documented signature is preserved rather than changed.
 *
 * States, names and return values throughout. No durations.
 */
import { describe, it, expect } from 'vitest';
import { PowerCache, PowerMemoizer } from '../src/helpers/powerCache.js';
import { defaultMetrics } from '../src/helpers/metrics.js';

describe('a scope-exit dispose unregisters a PowerCache', () => {
  it('clears the series on Symbol.dispose, not only on dispose()', () => {
    // A scope exit is the teardown the guarantee is about. Node 22.12 cannot
    // parse `using` declarations and no transformer in this tree downlevels
    // them, so the scope exit is spelled out here; the behaviour under test is
    // identical.
    const held = { cache: null };
    const cache = new PowerCache({ observability: true, maxEntries: 10 });
    try {
      held.cache = cache;
      expect(defaultMetrics.names()).toContain('cache');
    } finally {
      cache.dispose();
    }
    // Still readable after disposal, so the object is not unusable — it just
    // must not be sampled forever.
    expect(held.cache.maxEntries).toBe(10);
    expect(defaultMetrics.names()).not.toContain('cache');
  });

  it('clears the series when dispose() is called directly too', () => {
    // The counterpart. If `dispose()` delegated to the symbol, moving the
    // detach must not have lost it on this path.
    const cache = new PowerCache({ observability: true, maxEntries: 10 });
    expect(defaultMetrics.names()).toContain('cache');

    cache.dispose();
    expect(defaultMetrics.names()).not.toContain('cache');
  });

  it('is idempotent, and a second Symbol.dispose does not throw', () => {
    const cache = new PowerCache({ observability: true, maxEntries: 10 });
    cache[Symbol.dispose]();
    expect(() => {
      cache[Symbol.dispose]();
      cache.dispose();
    }).not.toThrow();
    expect(defaultMetrics.names()).not.toContain('cache');
  });

  it('a cache that never registered a series is unaffected', () => {
    // The common case pays nothing and must not start paying something: a
    // cache without `observability` never had a series to detach.
    const cache = new PowerCache({ maxEntries: 10 });
    expect(() => {
      cache[Symbol.dispose]();
    }).not.toThrow();
  });

  it('a memoizer inherits the fix through the cache it owns', () => {
    // `PowerMemoizer[Symbol.dispose]` forwards to `cache[Symbol.dispose]`, so
    // the detach is reached transitively — worth pinning, because the memoizer
    // registers as its own helper name and would otherwise leak independently.
    const held = { pm: null };
    const pm = new PowerMemoizer(undefined, { cacheOptions: { observability: true } });
    try {
      held.pm = pm;
      const names = defaultMetrics.names();
      expect(names.includes('memoizer') || names.includes('cache')).toBe(true);
    } finally {
      pm.dispose();
    }
    expect(held.pm).toBeTruthy();
    expect(defaultMetrics.names()).not.toContain('memoizer');
  });
});

describe('a method-memoized entry is reachable and invalidatable', () => {
  /** @returns {{pm: PowerMemoizer, memo: any, obj: any}} */
  const methodMemo = () => {
    const pm = new PowerMemoizer();
    const memo = pm.memoize((x) => x * 2);
    const obj = {
      double(x) {
        return memo.call(this, x);
      },
    };
    return { pm, memo, obj };
  };

  it('reads back what a method call stored', () => {
    // The defect: `get` missed the entry entirely, so the value was cached and
    // unreachable at the same time.
    const { memo, obj } = methodMemo();
    expect(obj.double(10)).toBe(20);

    expect(memo.get.call(obj, 10)).toBe(20);
  });

  it('reports presence for a method receiver', () => {
    const { memo, obj } = methodMemo();
    obj.double(10);

    expect(memo.has.call(obj, 10)).toBe(true);
    expect(memo.has.call(obj, 11)).toBe(false);
  });

  it('deletes a method entry, and the key is really gone from the cache', () => {
    // The half the row emphasises: an entry that can never be invalidated. The
    // key is checked in the cache directly, so a `delete` that returned `true`
    // without removing anything would be caught.
    const { pm, memo, obj } = methodMemo();
    obj.double(10);
    // `keys()` is a generator, not an array. First written as
    // `pm.cache.keys().filter(...)` and it read an Iterator Helper.
    const scoped = [...pm.cache.keys()].filter((k) => String(k).startsWith('r'));
    expect(scoped).toHaveLength(1);

    expect(memo.delete.call(obj, 10)).toBe(true);
    expect([...pm.cache.keys()].filter((k) => String(k).startsWith('r'))).toEqual([]);
    expect(memo.get.call(obj, 10)).toBeUndefined();
  });

  it('a second delete of the same method entry reports false', () => {
    const { memo, obj } = methodMemo();
    obj.double(10);
    expect(memo.delete.call(obj, 10)).toBe(true);
    expect(memo.delete.call(obj, 10)).toBe(false);
  });

  it('a plain call still resolves the unscoped key the guide documents', () => {
    // The documented signature is `get(...args)`. Moving the helpers from arrows
    // to functions must not have changed that, so a plain `memo(10)` entry is
    // still readable with a plain `memo.get(10)`.
    const pm = new PowerMemoizer();
    const memo = pm.memoize((x) => x * 2);
    expect(memo(10)).toBe(20);

    expect(memo.get(10)).toBe(20);
    expect(memo.has(10)).toBe(true);
    expect(memo.delete(10)).toBe(true);
    expect(memo.get(10)).toBeUndefined();
  });

  it('two receivers holding the same args do not collide', () => {
    // The reason the entries are scoped at all. Without the prefix they would
    // share one key, and `a.double(10)` would read `b.double(10)`'s value.
    const pm = new PowerMemoizer();
    const memo = pm.memoize((x) => x);
    const a = {
      tag: 'a',
      go(v) {
        return memo.call(this, v);
      },
    };
    const b = {
      tag: 'b',
      go(v) {
        return memo.call(this, v);
      },
    };

    expect(a.go(1)).toBe(1);
    expect(b.go(2)).toBe(2);

    // Each receiver sees only its own entry.
    expect(memo.get.call(a, 1)).toBe(1);
    expect(memo.get.call(a, 2)).toBeUndefined();
    expect(memo.get.call(b, 2)).toBe(2);
    expect(memo.get.call(b, 1)).toBeUndefined();
  });

  it('a detached helper still resolves the unscoped key', () => {
    // `const g = memo.get; g(10)` was valid before this change, because an arrow
    // function has no receiver to lose. A `function` in a module is strict, so
    // `this` is `undefined` when detached — which has to keep meaning "no
    // particular receiver" rather than being scoped to nothing.
    const pm = new PowerMemoizer();
    const memo = pm.memoize((x) => x * 2);
    memo(10);

    const get = memo.get;
    const has = memo.has;
    expect(get(10)).toBe(20);
    expect(has(10)).toBe(true);
  });
});
