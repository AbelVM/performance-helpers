import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerCache } from '../src/index.js';

// GAP-003: signal an in-flight `getOrSetAsync` factory when its key is evicted,
// deleted, or the caller's timeout elapses.
//
// Both premises measured before any code changed:
//
//   - `AbortController` / `AbortSignal` occurrences in `powerCache.js`: **zero**.
//     No cancellation path existed, so an evicted key's factory ran to completion
//     and then wrote its result back into a cache that no longer wanted it.
//   - F-09 reproduced: with `defaultAsyncTimeout: 50` and a 300 ms factory the
//     slot was released at the timeout while the factory kept running.
//
// **What F-09 is and is not.** A duplicate factory costs compute; a permanent
// slot is a memory leak *and* a permanently broken key, so the slot is still
// released at the timeout. What changed is that the factory is now *signalled* at
// that moment, so a factory that can cooperate stops and the next caller's
// duplicate is then free. An uncooperative factory still duplicates — that
// residual is asserted below rather than hidden, because it is the honest
// boundary of this fix.

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const cache = (options = {}) => new PowerCache({ maxEntries: 10, defaultTTL: 60_000, ...options });

/** A factory that records the signal it was handed and never settles on its own. */
function pendingFactory() {
  const record = { signal: null, started: 0, aborted: false, resolve: null };
  const factory = (signal) => {
    record.signal = signal;
    record.started++;
    if (signal) {
      signal.addEventListener('abort', () => {
        record.aborted = true;
      });
    }
    return new Promise((resolve) => {
      record.resolve = resolve;
    });
  };
  return { factory, record };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the factory is handed an AbortSignal', () => {
  it('passes a signal as the first argument', async () => {
    // The shape `fetch` and `lru-cache` both use, so a factory written for
    // either works here unchanged.
    const c = cache();
    const { factory, record } = pendingFactory();
    void c.getOrSetAsync('k', factory);
    await flush();
    expect(record.signal).toBeInstanceOf(AbortSignal);
    expect(record.signal.aborted).toBe(false);
  });

  it('aborts on delete()', async () => {
    const c = cache();
    const { factory, record } = pendingFactory();
    void c.getOrSetAsync('k', factory);
    await flush();
    c.delete('k');
    expect(record.signal.aborted).toBe(true);
  });

  it('aborts on eviction', async () => {
    const c = cache({ maxEntries: 1 });
    const { factory, record } = pendingFactory();
    void c.getOrSetAsync('a', factory);
    await flush();
    c.set('a', 'placeholder');
    c.set('b', 'other');
    expect(record.signal.aborted).toBe(true);
  });

  it('aborts on clear(), including a key with no resident node', async () => {
    // The node sweep cannot do this: a key mid-fetch is not resident, and
    // `clear()` does not go through `delete()`. Wired without the loop, the
    // sweep aborted nothing at all — which is what the test caught.
    const c = cache();
    const { factory, record } = pendingFactory();
    void c.getOrSetAsync('k', factory);
    await flush();
    c.clear();
    expect(record.signal.aborted).toBe(true);
  });

  it('aborts at the caller timeout, and releases the slot there too', async () => {
    // The ordering matters and was wrong first time: the controller was deleted
    // before `_abortInflight` looked it up, so the timeout signalled nothing.
    const c = cache({ defaultAsyncTimeout: 40 });
    const { factory, record } = pendingFactory();
    void c.getOrSetAsync('k', factory).catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(60);
    expect(record.signal.aborted).toBe(true);
    expect(c._inflightPromises.has('k')).toBe(false);
    // And the controller map is released with it, or it grows per fetch.
    expect(c._inflightControllers.has('k')).toBe(false);
  });

  it('the stale-refresh path is signalled too', async () => {
    // `_refreshStaleEntry` is a second invocation site recording into the same
    // map, and it is the one that runs unattended — the case most likely to be
    // forgotten. A signal wired into only `getOrSetAsync` would leave it
    // unprotected.
    let clock = 1_000_000;
    const c = cache({ allowStale: true, staleTtl: 10_000, now: () => clock });
    c.set('k', 'old', { ttl: 100 });
    clock += 500;
    const { factory, record } = pendingFactory();
    void c.getOrSetAsync('k', factory);
    await flush();
    expect(record.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('aborting is a request, not a kill', () => {
  it('a factory that ignores the signal still resolves and still stores', async () => {
    // The backward-compatibility half, and a deliberate choice. A factory
    // written before this feature takes no argument, so refusing to store its
    // value would lose work a caller wanted. The signal is there for a factory
    // that *can* cooperate.
    const c = cache();
    let resolve;
    const store = c.getOrSetAsync(
      'k',
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    await flush();
    c.delete('k');
    resolve('computed');
    await expect(store).resolves.toBe('computed');
    // It re-inserted. That is the documented cost of an uncooperative factory,
    // and it is the reason the signal exists at all.
    expect(c.get('k')).toBe('computed');
  });

  it('a cooperative factory stops instead of running to completion', async () => {
    // The payoff: the work nobody wants is not done.
    const c = cache();
    let finished = false;
    const store = c
      .getOrSetAsync(
        'k',
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              finished = true;
              resolve('gave-up');
            });
          })
      )
      .catch(() => {});
    await flush();
    c.delete('k');
    await flush();
    expect(finished).toBe(true);
    await store;
  });
});

describe('F-09: the slot is released at the timeout, and the factory is signalled', () => {
  it('a never-settling factory does not hold its slot forever', async () => {
    // The failure that stopped the first attempt. Holding the slot until the
    // factory settles closes the duplicate and leaks: this key could never
    // fetch again, and every entry accumulated one Map row per hanging factory.
    // A duplicate costs compute; a permanent slot is a leak and a broken key.
    const c = cache({ defaultAsyncTimeout: 20 });
    void c.getOrSetAsync('hang', () => new Promise(() => {})).catch(() => {});
    await vi.advanceTimersByTimeAsync(40);
    expect(c._inflightPromises.has('hang')).toBe(false);
    expect(c._inflightControllers.has('hang')).toBe(false);
  });

  it('a caller arriving before the timeout joins and gets the value', async () => {
    // The dedupe guarantee. It is scoped to the window in which the slot is
    // held, because the slot is released at the timeout - that release is what
    // stops a never-settling factory from leaking, and the signal is what stops
    // the work. My first version of this test joined *after* the timeout and
    // expected the value, which is the behaviour the fix deliberately gave up.
    const c = cache({ defaultAsyncTimeout: 200 });
    let started = 0;
    let resolve;
    const factory = () => {
      started++;
      return new Promise((r) => {
        resolve = r;
      });
    };

    const first = c.getOrSetAsync('k', factory);
    await flush();
    const second = c.getOrSetAsync('k', factory);
    await flush();
    expect(started).toBe(1); // one factory for two callers

    resolve('the-real-value');
    await expect(first).resolves.toBe('the-real-value');
    await expect(second).resolves.toBe('the-real-value');
  });

  it('an uncooperative factory still duplicates, and that is the honest residual', async () => {
    // Asserted rather than hidden. The duplicate is the cost that F-09 named,
    // and the fix reduces it to *cooperative factories only*. If a future change
    // closes it for the uncooperative case this test will say so, and if the
    // behaviour changes silently this test will notice.
    const c = cache({ defaultAsyncTimeout: 40 });
    let started = 0;
    let resolve;
    const factory = () => {
      started++;
      return new Promise((r) => {
        resolve = r;
      });
    };
    void c.getOrSetAsync('k', factory).catch(() => {});
    await vi.advanceTimersByTimeAsync(60);
    expect(started).toBe(1);
    void c.getOrSetAsync('k', factory).catch(() => {});
    await flush();
    expect(started).toBe(2); // <- the residual, made visible
    resolve('done');
  });

  it('still stores the late value after the caller gave up', async () => {
    // Preserved: the cache write hangs off the factory promise, not the timeout
    // race, so a successful-but-slow fetch is not thrown away.
    const c = cache({ defaultAsyncTimeout: 40 });
    let resolve;
    void c
      .getOrSetAsync(
        'k',
        () =>
          new Promise((r) => {
            resolve = r;
          })
      )
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(60);
    resolve('late');
    await vi.advanceTimersByTimeAsync(10);
    expect(c.get('k')).toBe('late');
  });

  it('does not leak an unhandled rejection when the factory fails', async () => {
    const c = cache();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(
        c.getOrSetAsync('k', async () => {
          throw new Error('factory failed');
        })
      ).rejects.toThrow('factory failed');
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('the parallel controller map', () => {
  it('does not change what _inflightPromises holds', async () => {
    // The design note in the source explains why this is a second Map rather
    // than a `{promise, controller}` record: 13 assertions across 4 files read
    // this map and expect a bare promise. Pinned so a future tidy-up does not
    // re-introduce the migration.
    const c = cache();
    let resolve;
    void c.getOrSetAsync(
      'k',
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    await flush();
    const entry = c._inflightPromises.get('k');
    expect(typeof entry.then).toBe('function');
    expect(c._inflightControllers.get('k')).toBeInstanceOf(AbortController);
    resolve(1);
  });
});
