import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

/**
 * MEM-001 — `_inflightPromises` and `_inflightControllers` grew without any bound,
 * so a scan across distinct keys with a slow factory retained one promise and one
 * `AbortController` per key.
 *
 * **Measured before the fix**, using an injected clock so nothing races a real
 * timer: 20,000 stale keys served with `allowStale`, `staleTtl` and a factory
 * blocked on a gate gave
 *
 * ```
 * peak _inflightPromises     : 20000
 * peak _inflightControllers  : 20000
 * ```
 *
 * **and the shipped default is the unbounded case.** `maxEntries` defaults to
 * `Infinity`, so the cap derived from it would be unbounded too — which is why
 * the fallback for an infinite `maxEntries` is a fixed 1024 rather than
 * `maxEntries` itself.
 *
 * **A skip, not an eviction.** Reaching the cap drops a *background* refresh, and
 * the cost of that is zero: the caller has already been served the stale value,
 * and the next `getOrSet` will schedule a refresh if there is room by then.
 * Evicting the oldest instead would abort a fetch `getOrSetAsync` may have
 * handed out, trading a bounded queue for a caller-visible failure.
 */

/** A cache whose clock is driven by hand, so no assertion races a real timer. */
function makeCache(options = {}, { entries = 200, ttl = 1 } = {}) {
  const state = { now: 1000 };
  const cache = new PowerCache({
    staleTtl: 60_000,
    allowStale: true,
    now: () => state.now,
    ...options,
  });
  for (let i = 0; i < entries; i += 1) cache.set(`k${i}`, 'seed', { ttl });
  return { cache, state };
}

/**
 * Serve every key once with a factory that never resolves, so each stays in-flight.
 * @returns {number} the peak size of the in-flight maps
 */
async function scanWithBlockedFactory(cache, keys, factory) {
  let peak = 0;
  for (const key of keys) {
    cache.getOrSet(key, factory);
    // One macrotask turn, so the `.finally` bookkeeping would have run if it were
    // going to.
    await new Promise((resolve) => setImmediate(resolve));
    if (cache._inflightPromises.size > peak) peak = cache._inflightPromises.size;
  }
  return peak;
}

describe('MEM-001: background refreshes are capped', () => {
  it('bounds the in-flight maps when maxEntries is infinite', async () => {
    // **The default configuration, and the one that was unbounded.** With
    // `maxEntries: Infinity` there is no cache size to derive a cap from, so the
    // fallback is a fixed 1024 — a scan of any length is bounded by it.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { cache, state } = makeCache({}, { entries: 20_000 });
    state.now += 50;

    const peak = await scanWithBlockedFactory(
      cache,
      Array.from({ length: 20_000 }, (_, i) => `k${i}`),
      async () => {
        await gate;
        return 'fresh';
      }
    );

    expect(peak, 'a scan of 20000 keys cannot retain 20000 refreshes').toBe(1024);
    expect(cache._inflightPromises.size).toBeLessThanOrEqual(1024);
    expect(
      cache._inflightControllers.size,
      'and the AbortControllers with them'
    ).toBeLessThanOrEqual(1024);
    release();
  });

  it('honours an explicit cap', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { cache, state } = makeCache({ maxInflightRefreshes: 5 }, { entries: 500 });
    state.now += 50;

    const peak = await scanWithBlockedFactory(
      cache,
      Array.from({ length: 500 }, (_, i) => `k${i}`),
      async () => {
        await gate;
        return 'fresh';
      }
    );

    expect(peak).toBe(5);
    expect(cache._inflightPromises.size).toBe(5);
    release();
  });

  it('still serves the stale value to every caller when a refresh is skipped', async () => {
    // **The property that makes skipping the right answer.** The refresh is
    // background; the caller has already been served. If this failed, the cap
    // would be trading a correctness bug for an availability one.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { cache, state } = makeCache({ maxInflightRefreshes: 2 }, { entries: 50 });
    state.now += 50;

    const served = [];
    for (const key of Array.from({ length: 50 }, (_, i) => `k${i}`)) {
      served.push(
        cache.getOrSet(key, async () => {
          await gate;
          return 'fresh';
        })
      );
    }
    release();

    expect(served).toHaveLength(50);
    expect(
      served.every((v) => v === 'seed'),
      'every caller got the stale value, including the ones whose refresh was skipped'
    ).toBe(true);
  });

  it('counts the skips, on stats() as well as the field', async () => {
    // **A count only on a private field is half-counted.** Before the fix nothing
    // was observable at all, so a cache that had stopped refreshing looked
    // healthy on every counter it exported.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { cache, state } = makeCache({ maxInflightRefreshes: 3 }, { entries: 40 });
    state.now += 50;

    await scanWithBlockedFactory(
      cache,
      Array.from({ length: 40 }, (_, i) => `k${i}`),
      async () => {
        await gate;
        return 'fresh';
      }
    );

    expect(cache.getStats().refreshesSkipped, '37 of 40 had no room').toBe(37);
    release();
  });

  it('reports zero skips when nothing was refused', async () => {
    const { cache, state } = makeCache({ maxInflightRefreshes: 100 }, { entries: 10 });
    state.now += 50;

    await scanWithBlockedFactory(
      cache,
      Array.from({ length: 10 }, (_, i) => `k${i}`),
      async () => 'fresh'
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(cache.getStats().refreshesSkipped, 'no cap was reached').toBe(0);
  });

  it('refreshes normally when there is room, so the cap is not "stop refreshing"', async () => {
    // The other direction. A fix that treated the cap as "disable background
    // refresh" would pass every test above and quietly stop the feature.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { cache, state } = makeCache({ maxInflightRefreshes: 4 }, { entries: 4 });
    state.now += 50;
    const keys = Array.from({ length: 4 }, (_, i) => `k${i}`);

    await scanWithBlockedFactory(cache, keys, async () => {
      await gate;
      return 'fresh';
    });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(cache.get('k0'), 'the refreshed value landed').toBe('fresh');
    expect(cache.getStats().refreshesSkipped).toBe(0);
  });

  it('treats 0 as "never refresh in the background", a legitimate configuration', async () => {
    const { cache, state } = makeCache({ maxInflightRefreshes: 0 }, { entries: 10 });
    state.now += 50;
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);

    await scanWithBlockedFactory(cache, keys, async () => 'fresh');

    expect(cache._inflightPromises.size, 'no background refresh at all').toBe(0);
    expect(cache.getStats().refreshesSkipped, 'and every one was counted').toBe(10);
    // **Through `getOrSet`, not `get()`.** An earlier draft asserted `get('k0')`
    // returned the stale value and got `undefined` — correctly, because only
    // `getOrSet`/`getOrSetAsync` serve stale and schedule a refresh. `get()` is
    // the strict path, which is a distinction this file keeps re-learning.
    expect(
      cache.getOrSet('k0', async () => 'fresh'),
      'while the stale value is still served'
    ).toBe('seed');
  });

  it('rejects a nonsense cap rather than coercing it', async () => {
    // A cap that silently became `NaN` would compare false against every size and
    // disable the limit entirely — the unbounded case, reached through a typo.
    for (const bad of [-1, 1.5, NaN, 'lots']) {
      expect(
        () => new PowerCache({ maxInflightRefreshes: bad }),
        `${String(bad)} must be rejected`
      ).toThrow(/maxInflightRefreshes/);
    }
  });

  it('rejects a mistyped cap, because PowerCache validates its options', () => {
    // **This assertion was inverted, and that is the point.** It previously read
    // "ignores a mistyped cap, because PowerCache does not validate its options",
    // written as a deliberate pin of that limitation so a future validation pass
    // would fail visibly rather than silently change behaviour. It did exactly
    // that, and this is that failure.
    //
    // What it cost while it was true: a caller writing `maxInflightRefresh: 10`
    // got a cache reporting the default 1024, with no signal. The same shape
    // applies to the options that matter more — `maxEntriess: 5` left
    // `maxEntries` at `Infinity`, so **a one-character typo turned a 5-entry cache
    // into an unbounded one** and the caller believed they were protected.
    for (const bad of ['maxInflightRefresh', 'maxEntriess', 'staleTtll']) {
      expect(() => new PowerCache({ [bad]: 10 }), `${bad} must be rejected, not ignored`).toThrow(
        new RegExp(bad)
      );
    }

    // And the real options still work, which is the other half: a validation pass
    // that rejected a valid spelling would be worse than none.
    const ok = new PowerCache({ maxInflightRefreshes: 7, maxEntries: 11, staleTtl: 99 });
    expect(ok.maxInflightRefreshes).toBe(7);
    expect(ok.maxEntries).toBe(11);
  });

  it('defaults from a finite maxEntries rather than from Infinity', async () => {
    const finite = makeCache({ maxEntries: 64 });
    expect(finite.cache.maxInflightRefreshes, 'one in-flight refresh per cacheable key').toBe(64);

    const infinite = makeCache({ maxEntries: Infinity });
    expect(
      infinite.cache.maxInflightRefreshes,
      'a fixed fallback, since Infinity derives nothing'
    ).toBe(1024);
  });
});
