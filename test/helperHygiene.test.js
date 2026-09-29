import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerObserver } from '../src/helpers/powerObserver.js';
import { PowerCache } from '../src/helpers/powerCache.js';
import { PowerSubscriberSet } from '../src/helpers/powerSubscriberSet.js';

/**
 * Regression tests for the helper-hygiene pass: a `size` that no longer mutates,
 * a circuit that stops probing in lockstep, an observer that stops calling the
 * user's mapper twice per write, a comparison whose cycle guard cannot leak
 * across calls, and a disposal that actually releases its finalization registry.
 */

// TEST-008. The four waits below were `setTimeout(r, 25)` against a 5 ms TTL -
// a 5x margin bought with wall-clock time, on the theory that a wider sleep is
// safer. It is the opposite: the wait is a macrotask, so its duration depends on
// how busy the loop is, and a 25 ms sleep is a race with the scheduler that
// happens to pass on an idle machine. Fake timers make "past the TTL" a number
// instead of a hope.
//
// `PowerTTLMap` stores `expiresAt = nowMs() + ttl + 1` and expires on
// `nowMs() > expiresAt`, so a TTL of `t` is only past after **`t + 2`** ms -
// the same boundary `powerTTLMap.test.js` pins, and the reason an earlier
// conversion at `t + 1` produced a suite where nothing ever expired.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Advance the clock past a TTL of `ttl` ms.
 *
 * @param {number} ttl
 * @returns {Promise<void>}
 */
const pastTtl = (ttl) => vi.advanceTimersByTimeAsync(ttl + 2);

describe('PowerTTLMap size is a pure read (BUG-022)', () => {
  it('is O(1) and never sweeps: expired entries stay resident', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 5);
    m.set('b', 2, 5);
    await pastTtl(5);
    const sweep = vi.spyOn(m, '_sweepExpirations');
    // The whole point: reading a property is not an operation.
    for (let i = 0; i < 5; i++) void m.size;
    expect(sweep).not.toHaveBeenCalled();
    expect(m.size).toBe(2);
    sweep.mockRestore();
  });

  it('never fires onExpire from a size read, however many times', async () => {
    const onExpire = vi.fn();
    const m = new PowerTTLMap({ onExpire });
    m.set('a', 1, 5);
    await pastTtl(5);
    for (let i = 0; i < 10; i++) {
      expect(m.size).toBe(1);
      expect(m.expiredCount).toBe(1);
    }
    expect(onExpire).not.toHaveBeenCalled();
    m.purge();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(m.size).toBe(0);
  });

  it('expiredCount equals size minus the live count', async () => {
    const m = new PowerTTLMap();
    m.set('live', 1, 10_000);
    m.set('gone', 2, 5);
    await pastTtl(5);
    // Read the counters *before* iterating: `keys()` collects as it goes, so
    // touching it first would expire the entry this is measuring.
    const expired = m.expiredCount;
    const resident = m.size;
    const live = [...m.keys()].length;
    expect(expired).toBe(1);
    expect(expired).toBe(resident - live);
  });

  it('purge() reports exactly what it removed and is idempotent', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 5);
    m.set('b', 2, 5);
    m.set('c', 3, 10_000);
    await pastTtl(5);
    expect(m.purge()).toBe(2);
    expect(m.purge()).toBe(0);
    expect(m.size).toBe(1);
    expect(m.get('c')).toBe(3);
  });

  it('purge() on an empty or TTL-less map is a no-op', () => {
    const m = new PowerTTLMap();
    expect(m.purge()).toBe(0);
    expect(m.expiredCount).toBe(0);
    m.set('a', 1); // no TTL -> never expires
    expect(m.purge()).toBe(0);
    expect(m.size).toBe(1);
  });
});

describe('PowerCircuit open window grows and jitters (BUG-021)', () => {
  it('uses the base timeout for the first trip', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 40 });
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    // The first window is the base, jittered into [base/2, base].
    expect(cb._openWindowMs).toBeGreaterThanOrEqual(20);
    expect(cb._openWindowMs).toBeLessThanOrEqual(40);
    expect(cb._consecutiveOpens).toBe(1);
  });

  it('doubles on each consecutive trip and caps at maxTimeout', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 100, maxTimeout: 400 });
    // Drive the state machine directly so the test is not a timing race.
    for (let i = 0; i < 6; i++) {
      cb._failures = cb._threshold;
      await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow();
      cb._state = 'half-open';
      cb._trialInFlight = false;
    }
    expect(cb._consecutiveOpens).toBe(6);
    // Capped at maxTimeout, and always at least half of it.
    expect(cb._openWindowMs).toBeLessThanOrEqual(400);
    expect(cb._openWindowMs).toBeGreaterThanOrEqual(200);
  });

  it('never lets the window collapse below half the computed backoff', async () => {
    // The reason this is *not* AWS full jitter: a [0, delay] draw can re-open
    // the breaker almost immediately, which is the flapping no-op we are
    // avoiding. Pin the floor.
    const cb = new PowerCircuit({ threshold: 1, timeout: 1000, maxTimeout: 1000 });
    for (let i = 0; i < 200; i++) {
      expect(cb._drawOpenWindow()).toBeGreaterThanOrEqual(500);
      expect(cb._drawOpenWindow()).toBeLessThanOrEqual(1000);
    }
  });

  it('jitters, so two breakers guarding one dependency do not retry in lockstep', () => {
    const windows = new Set();
    for (let i = 0; i < 200; i++) {
      const cb = new PowerCircuit({ threshold: 1, timeout: 1000, maxTimeout: 1000 });
      windows.add(cb._drawOpenWindow());
    }
    // 200 draws must not collapse to a single value; that was the bug.
    expect(windows.size).toBeGreaterThan(50);
  });

  it('resets the backoff once the circuit proves the dependency is healthy', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 50 });
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow();
      cb._state = 'half-open';
      cb._trialInFlight = false;
    }
    expect(cb._consecutiveOpens).toBe(3);
    await cb.call(() => Promise.resolve('ok'));
    expect(cb.state).toBe('closed');
    expect(cb._consecutiveOpens).toBe(0);
    expect(cb._openWindowMs).toBe(cb._timeout);
  });

  it('reset() clears the backoff too', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 50 });
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(cb._consecutiveOpens).toBe(1);
    cb.reset();
    expect(cb._consecutiveOpens).toBe(0);
    expect(cb._openWindowMs).toBe(cb._timeout);
  });

  it('the state getter and call() agree on the drawn window', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 1000, maxTimeout: 1000 });
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow();
    // Pin the drawn window, then step the clock forward by hand. If `state`
    // still read `_timeout` while `call()` read the window, these would
    // disagree for any draw below the base.
    cb._openedAt -= cb._openWindowMs - 1;
    expect(cb.state).toBe('open');
    await expect(cb.call(() => Promise.resolve('ok'))).rejects.toThrow();
    cb._openedAt -= 2;
    expect(cb.state).toBe('half-open');
  });
});

describe('PowerObserver maps once per write (BUG-026)', () => {
  it('runs the user mapper once per write, not twice', () => {
    const map = vi.fn((v) => ({ v }));
    const obs = new PowerObserver(0, { map, async: false });
    for (let i = 1; i <= 5; i++) obs.value = i;
    // The old code ran `map` on both sides of every set: 5 writes = 10 calls.
    // Steady state is 1 per write; the first write necessarily maps the initial
    // value as well, because nothing was cached yet. So 5 writes = 6 calls,
    // and every write after the first costs exactly one.
    expect(map).toHaveBeenCalledTimes(6);
    map.mockClear();
    for (let i = 6; i <= 15; i++) obs.value = i;
    expect(map).toHaveBeenCalledTimes(10); // 1 per write, no priming call
  });

  it('still reports the correct previous value to subscribers', () => {
    const seen = [];
    const obs = new PowerObserver(0, { map: (v) => ({ v }), async: false });
    obs.subscribe((next, prev) => seen.push([next.v, prev.v]));
    obs.value = 1;
    obs.value = 2;
    obs.value = 3;
    expect(seen).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  it('the first set after construction maps the initial value exactly once', () => {
    const map = vi.fn((v) => ({ v }));
    const obs = new PowerObserver(7, { map, async: false });
    // The constructor must not call the mapper: that is a side effect at
    // construction time nobody asked for.
    expect(map).not.toHaveBeenCalled();
    const seen = [];
    obs.subscribe((next, prev) => seen.push([next.v, prev.v]));
    obs.value = 8;
    expect(map).toHaveBeenCalledTimes(2); // map(7) for prev, map(8) for next
    expect(seen).toEqual([[8, 7]]);
    obs.value = 9;
    expect(map).toHaveBeenCalledTimes(3); // only map(9); map(8) was cached
    expect(seen[1]).toEqual([9, 8]);
  });

  it('invalidates the cached mapped value when the mapper is replaced', () => {
    const seen = [];
    const obs = new PowerObserver(0, { map: (v) => ({ doubled: v * 2 }), async: false });
    obs.subscribe((next, prev) => seen.push([next, prev]));
    obs.value = 1; // cache: {doubled: 2}
    obs.map((v) => ({ tripled: v * 3 }));
    obs.value = 2;
    // `prev` must come from the *new* mapper. A stale cache would report
    // {doubled: 2} here, which no mapper ever produced.
    expect(seen[1]).toEqual([{ tripled: 6 }, { tripled: 3 }]);
  });

  it('caches across a distinct-suppressed write', () => {
    const map = vi.fn((v) => v % 2);
    const obs = new PowerObserver(0, { map, distinct: true, async: false });
    let notifications = 0;
    obs.subscribe(() => notifications++);
    map.mockClear();
    obs.value = 2; // maps to 0, same as previous -> suppressed
    expect(notifications).toBe(0);
    // The cache must have advanced to the *new* value even though nothing was
    // delivered, or the next distinct write would report a stale `prev`.
    obs.value = 4; // maps to 0 again -> still suppressed, and no extra map call
    expect(notifications).toBe(0);
    expect(map).toHaveBeenCalledTimes(3); // 2 for the first set, 1 for the second
  });
});

describe('hasEqual cannot be fooled by a stale seen pair (BUG-023)', () => {
  it('reports a miss for a mutated value that used to match', () => {
    const cache = new PowerCache();
    const stored = { a: [1, 2, 3] };
    cache.set('k', stored);
    const probe = { a: [1, 2, 3] };
    expect(cache.hasEqual('k', probe)).toBe(true);
    // Mutate both sides so they diverge, and compare again.
    probe.a[2] = 999;
    expect(cache.hasEqual('k', probe)).toBe(false);
  });

  it('does not honour a caller-supplied `seen`', () => {
    const cache = new PowerCache();
    const stored = { a: [1, 2, 3] };
    cache.set('k', stored);
    const seen = new WeakMap();
    const probe = { a: [1, 2, 3] };
    // The removed option is still accepted by the options bag, so a surviving
    // call site cannot crash — it just no longer changes the answer.
    expect(cache.hasEqual('k', probe, { seen })).toBe(true);
    probe.a[2] = 999;
    expect(cache.hasEqual('k', probe, { seen })).toBe(false);
  });

  it('no longer exposes hasEqualWithSeen', () => {
    const cache = new PowerCache();
    cache.set('k', { a: 1 });
    expect(cache.hasEqualWithSeen).toBeUndefined();
  });

  it('still detects real cycles without caller help', () => {
    const cache = new PowerCache();
    const a = { name: 'a' };
    a.self = a;
    const b = { name: 'a' };
    b.self = b;
    cache.set('k', a);
    expect(cache.hasEqual('k', b)).toBe(true);
  });
});

describe('PowerSubscriberSet disposal releases the registry (BUG-025)', () => {
  it('drops the FinalizationRegistry on dispose', () => {
    if (typeof FinalizationRegistry === 'undefined') return;
    const set = new PowerSubscriberSet({ weak: true });
    expect(set._finalization).not.toBeNull();
    set.add(() => {});
    set.dispose();
    // The set was disposed precisely so it could be collected; a live registry
    // holding WeakRefs to its own listeners keeps it reachable.
    expect(set._finalization).toBeNull();
    expect(set.size).toBe(0);
  });

  it('clear() also drops it, since dispose() delegates to clear()', () => {
    if (typeof FinalizationRegistry === 'undefined') return;
    const set = new PowerSubscriberSet({ weak: true });
    set.clear();
    expect(set._finalization).toBeNull();
  });

  it('keeps working after clear(), rebuilding a fresh registry', () => {
    if (typeof FinalizationRegistry === 'undefined') return;
    const set = new PowerSubscriberSet({ weak: true });
    set.add(() => {});
    set.clear();
    const fn = () => {};
    set.add(fn);
    // Not silently downgraded to GC-agnostic behaviour.
    expect(set._finalization).not.toBeNull();
    expect([...set.values()]).toEqual([fn]);
  });

  it('a non-weak set has no registry to release', () => {
    const set = new PowerSubscriberSet();
    set.add(() => {});
    set.dispose();
    expect(set._finalization).toBeNull();
    expect(set.size).toBe(0);
  });
});
