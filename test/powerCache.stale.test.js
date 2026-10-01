import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerCache } from '../src/index.js';

// GAP-002: stale-while-revalidate.
//
// The row asked for `allowStale` / `staleTtl` / `getOrFetch` on the grounds that
// "`PowerCache` has `getOrSetAsync` and **no notion of stale** — an expired entry
// is a miss". **That premise was wrong**, and finding out why is the useful part.
//
// A per-call `staleWhileRevalidate` flag already existed, with a
// `_refreshStaleEntry` helper behind it. The feature was not absent; it was
// **unbounded**. Measured before any code was written, with the flag on:
//
//   +500ms    served: old    refreshes: 0
//   +1 hour   served: old    refreshes: 1
//   +30 days  served: old    refreshes: 1
//   +5 years  served: old    refreshes: 1
//
// A value **five years** past `expiresAt` was still returned as "stale", with the
// refresh failing silently each time. That is not stale-while-revalidate, it is
// serve-forever-while-refreshing, and it is the one failure mode the feature must
// not have. `staleTtl` is what puts a bound on it.
//
// Two more corrections to the row's framing, both measured:
//   - The implied **stampede risk does not exist**. 20 concurrent
//     `getOrSetAsync` callers on one expired key run the factory **once**.
//   - `allowStale` and `staleTtl` were **silently ignored** options: accepted
//     without complaint and read back as `undefined`.

let clock;
const now = () => clock;

/** A cache whose clock this file controls. */
const cache = (options = {}) => new PowerCache({ maxEntries: 10, now, ...options });

beforeEach(() => {
  clock = 1_000_000;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('stale-while-revalidate: the stale window is bounded', () => {
  it('refuses to serve a value that expired five years ago', () => {
    // The defect, as a regression test. Before `staleTtl`, this returned 'old'
    // at every one of these offsets.
    const c = cache({ allowStale: true, staleTtl: 5_000, defaultTTL: 1_000 });
    c.set('k', 'old', { ttl: 1_000 });

    let refreshes = 0;
    const factory = async () => {
      refreshes++;
      return 'fresh';
    };

    // 500ms past a 1s TTL: inside a 5s stale window, so the stale value stands.
    clock += 1_500;
    return c
      .getOrSetAsync('k', factory)
      .then((first) => {
        expect(first).toBe('old');
        // Let the background refresh land first. Without this the second call
        // *joins* the in-flight refresh rather than making a fresh decision -
        // which is the dedup working, and it would mask what this test is for.
        return c._inflightPromises.get('k');
      })
      .then(() => {
        // Now push far outside the window. Two years is enough; the original
        // measurement used five and the answer is the same at both.
        clock += 2 * 365 * 86_400_000;
        return c.getOrSetAsync('k', factory);
      })
      .then((later) => {
        expect(later).toBe('fresh');
        expect(refreshes).toBeGreaterThanOrEqual(2);
      });
  });

  it('staleTtl: 0 disables stale serving entirely', () => {
    // The pre-existing behaviour for a caller who never asked for stale: an
    // expired entry is a miss.
    const c = cache({ staleTtl: 0, defaultTTL: 1_000 });
    c.set('k', 'old', { ttl: 1_000 });
    clock += 1_500;
    return c
      .getOrSetAsync('k', async () => 'fresh', { staleWhileRevalidate: true })
      .then((v) => {
        expect(v).toBe('fresh');
      });
  });

  it('staleTtl: Infinity keeps the flag unbounded, deliberately', () => {
    const c = cache({ staleTtl: Infinity, defaultTTL: 1_000 });
    c.set('k', 'old', { ttl: 1_000 });
    clock += 400 * 86_400_000;
    return c
      .getOrSetAsync('k', async () => 'fresh', { staleWhileRevalidate: true })
      .then((v) => {
        expect(v).toBe('old');
      });
  });

  it('bounds the sync getOrSet path too, not only the async one', () => {
    // Two implementations, one predicate. A bound on only the async half would
    // leave the sync path as the five-year hole.
    const c = cache({ allowStale: true, staleTtl: 1_000, defaultTTL: 100 });
    c.set('k', 'old', { ttl: 100 });

    clock += 500; // 400ms past expiry, inside the window
    expect(c.getOrSet('k', () => 'fresh')).toBe('old');

    clock += 60_000; // long outside it
    expect(c.getOrSet('k', () => 'fresh')).toBe('fresh');
  });

  it('a per-call flag overrides the instance default in both directions', () => {
    const on = cache({ allowStale: true, staleTtl: 1_000_000, defaultTTL: 100 });
    on.set('a', 'old', { ttl: 100 });
    clock += 500;
    // Instance says stale; the call says no.
    return on
      .getOrSetAsync('a', async () => 'fresh', { staleWhileRevalidate: false })
      .then((v) => {
        expect(v).toBe('fresh');
        const off = cache({ staleTtl: 1_000, defaultTTL: 100 });
        off.set('b', 'old', { ttl: 100 });
        clock += 500;
        return off.getOrSetAsync('b', async () => 'fresh', { staleWhileRevalidate: true });
      })
      .then((v) => {
        expect(v).toBe('old');
      });
  });

  it('still refreshes in the background when it serves stale', () => {
    // Bounding the window must not have turned SWR into "serve stale, never
    // refresh" — the background half is the feature.
    const c = cache({ allowStale: true, staleTtl: 10_000, defaultTTL: 100 });
    c.set('k', 'old', { ttl: 100 });
    clock += 500;
    let refreshed = false;
    return c
      .getOrSetAsync('k', async () => {
        refreshed = true;
        return 'fresh';
      })
      .then((served) => {
        expect(served).toBe('old');
        return c._inflightPromises.get('k');
      })
      .then(() => {
        expect(refreshed).toBe(true);
        expect(c.get('k')).toBe('fresh');
      });
  });

  it('dedupes concurrent callers on one expired key', () => {
    // Not a new behaviour, and the row implied it was at risk. Pinned because a
    // future change to the stale path could break it silently, and it is the
    // property that makes SWR safe under load.
    const c = cache({ allowStale: true, staleTtl: 10_000, defaultTTL: 100 });
    c.set('k', 'old', { ttl: 100 });
    clock += 500;
    let runs = 0;
    const factory = async () => {
      runs++;
      return 'fresh';
    };
    return Promise.all(Array.from({ length: 20 }, () => c.getOrSetAsync('k', factory))).then(
      (results) => {
        expect(results).toHaveLength(20);
        expect(results.every((v) => v === 'old' || v === 'fresh')).toBe(true);
        expect(runs).toBe(1);
      }
    );
  });
});

describe('stale-while-revalidate: observable', () => {
  it('counts a stale serve separately from a fresh hit', () => {
    // Found by reading rather than by any failing test: a stale serve counted
    // only `hits`, so `stats()` could not tell "served fresh" from "served
    // old". For a feature whose entire purpose is silently returning expired
    // data that is the one number worth having — an upstream that starts
    // failing looks identical to a warm cache.
    const c = cache({ allowStale: true, staleTtl: 10_000, defaultTTL: 100 });
    c.set('k', 'v1', { ttl: 100 });
    clock += 500;

    return c
      .getOrSetAsync('k', async () => 'fresh')
      .then((stale) => {
        expect(stale).toBe('v1');
        expect(c.stats().staleServes).toBe(1);
        return c._inflightPromises.get('k');
      })
      .then(() => {
        // Snapshot rather than counting absolutely: the refresh stores a fresh
        // value, and reading it back is itself a hit, so hard-coded totals
        // encode incidental reads instead of the claim under test.
        const before = c.stats();
        clock += 500;
        return c.getOrSetAsync('k', async () => 'fresh2').then(() => ({ before }));
      })
      .then(({ before }) => {
        const after = c.stats();
        // The second serve is stale, and is counted as one more stale serve.
        expect(after.staleServes).toBe(before.staleServes + 1);
        // It is also a hit — from the caller's side it was served.
        expect(after.hits).toBe(before.hits + 1);
        // And it is not double-counted: the number of *real* hits is unchanged.
        expect(after.hits - after.staleServes).toBe(before.hits - before.staleServes);
        // Neither of them is a miss: a stale serve is not a failed lookup.
        expect(after.misses).toBe(before.misses);
      });
  });

  it('counts stale serves on the sync path too', () => {
    // The two read paths are separate implementations sharing one predicate, so
    // the counter has to be checked on both — a bound on only one of them was
    // the original defect.
    const c = cache({ allowStale: true, staleTtl: 10_000, defaultTTL: 100 });
    c.set('k', 'v1', { ttl: 100 });
    clock += 500;
    expect(c.getOrSet('k', () => 'fresh')).toBe('v1');
    expect(c.stats().staleServes).toBe(1);
    expect(c.stats().hits).toBe(1);
  });

  it('does not count a serve past the stale window', () => {
    // Past the window the entry is a miss and the factory runs; counting that as
    // a stale serve would make the number meaningless.
    const c = cache({ allowStale: true, staleTtl: 500, defaultTTL: 100 });
    c.set('k', 'v1', { ttl: 100 });
    clock += 5_000;
    return c
      .getOrSetAsync('k', async () => 'fresh')
      .then((v) => {
        expect(v).toBe('fresh');
        expect(c.stats().staleServes).toBe(0);
        expect(c.stats().misses).toBe(1);
      });
  });

  it('reports zero on a cache that never serves stale', () => {
    const c = cache({ defaultTTL: 100 });
    c.set('k', 'v');
    clock += 500;
    expect(c.get('k')).toBeUndefined();
    expect(c.stats().staleServes).toBe(0);
  });
});

describe('stale-while-revalidate: validation', () => {
  it('refuses allowStale without a staleTtl, and says why', () => {
    // The one combination refused, and the refusal is the point: the new
    // instance-level surface cannot be used to deploy unbounded stale by
    // omission. `staleTtl: Infinity` remains available for a caller who wants it
    // on purpose, which is the difference between a decision and an oversight.
    expect(() => cache({ allowStale: true })).toThrow(TypeError);
    expect(() => cache({ allowStale: true })).toThrow(/staleTtl/);
    expect(() => cache({ allowStale: true, staleTtl: Infinity })).not.toThrow();
    expect(() => cache({ allowStale: true, staleTtl: 5_000 })).not.toThrow();
  });

  it('rejects a staleTtl it cannot read', () => {
    // An unvalidated duration compares false against every entry, so it
    // silently disables stale serving — the opposite of what a typo asks for.
    for (const bad of ['soon', -1, Number.NaN, {}]) {
      expect(() => cache({ staleTtl: bad })).toThrow(TypeError);
    }
  });

  it('leaves a cache with no stale options byte-identical to before', () => {
    // The regression guard on the default path: expired entries are misses, and
    // the per-call flag keeps its original unbounded meaning so no existing
    // caller changes behaviour.
    const c = cache({ defaultTTL: 1_000 });
    expect(c.staleTtl).toBe(Infinity);

    // Two caches on purpose: `get()` *removes* an expired entry on the way past,
    // so calling it first would empty the very state the second half measures.
    const expired = cache({ defaultTTL: 1_000 });
    expired.set('k', 'v');
    clock += 1_500;
    expect(expired.get('k')).toBeUndefined();

    const kept = cache({ defaultTTL: 1_000 });
    kept.set('k', 'v');
    return kept
      .getOrSetAsync('k', async () => 'fresh', { staleWhileRevalidate: true })
      .then((v) => {
        // Unbounded, exactly as before this row: the flag keeps its meaning and
        // no existing caller changes behaviour.
        expect(v).toBe('v');
      });
  });
});

describe('getOrFetch', () => {
  it('uses the instance fetchMethod when no factory is given', () => {
    const c = cache({ fetchMethod: async () => 'fetched' });
    return c
      .getOrFetch('k')
      .then((first) => {
        expect(first).toBe('fetched');
        return c.getOrFetch('k');
      })
      .then((second) => {
        // Cached: the factory did not run twice.
        expect(second).toBe('fetched');
      });
  });

  it('a per-call factory overrides the instance default', () => {
    // A cache is often keyed by more than one kind of resource, so the
    // instance-wide default cannot be the only producer.
    const c = cache({ fetchMethod: async () => 'default' });
    return c
      .getOrFetch('k', async () => 'override')
      .then((v) => {
        expect(v).toBe('override');
      });
  });

  it('rejects rather than guessing when there is no factory at all', () => {
    return cache()
      .getOrFetch('k')
      .then(
        () => {
          throw new Error('should have rejected');
        },
        (err) => {
          expect(err).toBeInstanceOf(TypeError);
          expect(err.message).toMatch(/fetchMethod/);
        }
      );
  });

  it('rejects a fetchMethod that is not a function', () => {
    expect(() => cache({ fetchMethod: 'nope' })).toThrow(TypeError);
  });
});
