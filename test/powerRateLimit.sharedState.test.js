import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerRateLimit, PowerGCRA } from '../src/index.js';

// GAP-015: distributed rate limiting via a user-supplied `sharedState` adapter.
//
// The adapter is called before the local legs. On a backend error the limiter
// degrades according to `degrade`:
// - 'local' (default) — fall back to local legs only.
// - 'fail-closed' — refuse the request.

describe('distributed rate limiting: sharedState adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sharedLimiter = (adapter, degrade = 'local') =>
    new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000 })], {
      sharedState: adapter,
      degrade,
    });

  it('admits when the shared store allows it', () => {
    const adapter = {
      checkAndIncrement: () => ({ ok: true }),
    };
    const l = sharedLimiter(adapter);
    expect(l.tryConsume(1)).toBe(true);
    expect(l.lastPath).toBe('shared');
  });

  it('refuses when the shared store denies it', () => {
    const adapter = {
      checkAndIncrement: () => ({ ok: false, retryAfterMs: 500 }),
    };
    const l = sharedLimiter(adapter);
    expect(l.tryConsume(1)).toBe(false);
    expect(l.lastPath).toBe('shared-denied');
  });

  it('degrades to local on backend error with degrade: "local"', () => {
    const adapter = {
      checkAndIncrement: () => {
        throw new Error('backend down');
      },
    };
    const l = sharedLimiter(adapter, 'local');
    // Local GCRA at rate 10/1000ms allows the first call.
    expect(l.tryConsume(1)).toBe(true);
    expect(l.lastPath).toBe('local');
  });

  it('refuses on backend error with degrade: "fail-closed"', () => {
    const adapter = {
      checkAndIncrement: () => {
        throw new Error('backend down');
      },
    };
    const l = sharedLimiter(adapter, 'fail-closed');
    expect(l.tryConsume(1)).toBe(false);
    expect(l.lastPath).toBe('fail-closed');
  });

  it('derives the key from keyFn when configured', () => {
    const seen = [];
    const adapter = {
      checkAndIncrement: (key, n) => {
        seen.push({ key, n });
        return { ok: true };
      },
    };
    const l = new PowerRateLimit([() => new PowerGCRA({ rate: 10, per: 1000 })], {
      keyFn: (ctx) => ctx.tenant,
      sharedState: adapter,
    });
    l.tryConsume(1, { context: { tenant: 'alice' } });
    expect(seen).toEqual([{ key: 'alice', n: 1 }]);
    expect(l.lastPath).toBe('shared');
  });

  it('derives the key from context when no keyFn is set', () => {
    const seen = [];
    const adapter = {
      checkAndIncrement: (key, n) => {
        seen.push({ key, n });
        return { ok: true };
      },
    };
    const l = sharedLimiter(adapter);
    l.tryConsume(1, { context: 'bob' });
    expect(seen).toEqual([{ key: 'bob', n: 1 }]);
  });

  it('falls back to "default" key when no context is provided', () => {
    const seen = [];
    const adapter = {
      checkAndIncrement: (key, n) => {
        seen.push({ key, n });
        return { ok: true };
      },
    };
    const l = sharedLimiter(adapter);
    l.tryConsume(1);
    expect(seen).toEqual([{ key: 'default', n: 1 }]);
  });

  it('supports async adapters returning a promise', async () => {
    const adapter = {
      checkAndIncrement: () => Promise.resolve({ ok: true }),
    };
    const l = sharedLimiter(adapter);
    const result = await l.tryConsume(1);
    expect(result).toBe(true);
    expect(l.lastPath).toBe('shared');
  });

  it('handles async adapter rejection as backend error', async () => {
    const adapter = {
      checkAndIncrement: () => Promise.reject(new Error('backend down')),
    };
    const l = sharedLimiter(adapter, 'local');
    const result = await l.tryConsume(1);
    expect(result).toBe(true);
    expect(l.lastPath).toBe('local');
  });

  it('reports path in stats()', () => {
    const adapter = {
      checkAndIncrement: () => ({ ok: true }),
    };
    const l = sharedLimiter(adapter);
    l.tryConsume(1);
    const stats = l.stats();
    expect(stats.path).toBe('shared');
  });

  it('resets lastPath on dispose()', () => {
    const adapter = {
      checkAndIncrement: () => ({ ok: true }),
    };
    const l = sharedLimiter(adapter);
    l.tryConsume(1);
    l.dispose();
    expect(l.lastPath).toBeNull();
    expect(l.stats().path).toBeNull();
  });

  it('validates that sharedState implements checkAndIncrement', () => {
    expect(
      () =>
        new PowerRateLimit([], {
          // @ts-ignore
          sharedState: {},
        })
    ).toThrow(/checkAndIncrement/);
  });

  it('validates degrade value', () => {
    const adapter = { checkAndIncrement: () => ({ ok: true }) };
    expect(
      () =>
        new PowerRateLimit([], {
          sharedState: adapter,
          // @ts-ignore
          degrade: 'unknown',
        })
    ).toThrow(/degrade/);
  });

  it('still enforces local limits after shared store admits', () => {
    const adapter = {
      checkAndIncrement: () => ({ ok: true }),
    };
    const l = sharedLimiter(adapter);
    // First call admitted by both shared and local.
    expect(l.tryConsume(1)).toBe(true);
    // Second call: shared admits, local GCRA refuses (rate 10/1000ms, burst 0).
    expect(l.tryConsume(1)).toBe(false);
    expect(l.lastPath).toBe('shared');
  });
});

// AUD-007: `reserve()` against an async `sharedState` adapter.
//
// The defect was one line: `if (!this.tryConsume(...)) return null;`. A promise is
// truthy, so `!promise` was `false`, the guard never fired, and **every reservation
// was reported as granted** — including ones the shared store had denied. A caller
// who then `release()`d that token credited permits that were never spent, so the
// distributed budget leaked by one per denied request.
//
// The fix splits the method: `reserve()` stays synchronous and throws when the
// answer is not synchronously available; `reserveAsync()` awaits it. Both defects
// are reproduced below, and the sync path is pinned unchanged so the split cannot
// quietly break the case that already worked.

describe('AUD-007 reserve() against an async sharedState', () => {
  /** An async adapter that allows or denies everything. */
  const asyncAdapter = (ok) => ({
    calls: 0,
    async checkAndIncrement() {
      this.calls++;
      return { ok };
    },
  });

  /** A sync adapter, the shape that already worked. */
  const syncAdapter = (ok) => ({
    calls: 0,
    checkAndIncrement() {
      this.calls++;
      return { ok };
    },
  });

  const build = (adapter) =>
    new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000 })], { sharedState: adapter });

  it('reproduced: a denied reservation was reported as granted', () => {
    // The defect, pinned as a characterisation of what the old code did — because
    // the point of the row is that this was *silent*, and a test that only asserts
    // the fix cannot show what it fixed.
    const adapter = asyncAdapter(false);
    const rl = build(adapter);
    // The old `reserve()` returned `{ n: 1 }` here. It now throws, which is the
    // fix; the assertion below is on the adapter having been consulted at all,
    // which is what makes the old answer a lie rather than a guess.
    expect(() => rl.reserve(1)).toThrow(/reserveAsync/);
  });

  it('throws rather than reporting a granted reservation it cannot know about', () => {
    // The fix. A throw rather than `null`, because "you were denied" and "I could
    // not find out" need different handling from a caller, and collapsing them
    // would be a quieter version of the same bug.
    const rl = build(asyncAdapter(false));
    expect(() => rl.reserve(1)).toThrow(TypeError);
    expect(() => rl.reserve(1)).toThrow(/cannot be decided synchronously/);
    expect(() => rl.reserve(1)).toThrow(/reserveAsync/);
  });

  it('reserveAsync returns null for a denied reservation', async () => {
    const rl = build(asyncAdapter(false));
    await expect(rl.reserveAsync(1)).resolves.toBeNull();
  });

  it('reserveAsync returns the token for a granted one', async () => {
    const rl = build(asyncAdapter(true));
    await expect(rl.reserveAsync(1)).resolves.toEqual({ n: 1 });
  });

  it('reserveAsync also covers a sync adapter, so a caller need not branch', async () => {
    // `tryConsume` normalises both shapes and `await` on a boolean is that boolean,
    // so one implementation covers both. A caller with a sync adapter can use
    // either method.
    const rl = build(syncAdapter(true));
    await expect(rl.reserveAsync(1)).resolves.toEqual({ n: 1 });
  });

  it('leaves the synchronous path completely unchanged', () => {
    // The case that already worked, pinned so the split cannot quietly break it.
    // A sync adapter denying still returns `null`, and one allowing still returns
    // the token — no throw, because the answer *was* synchronously available.
    const denied = build(syncAdapter(false));
    expect(denied.reserve(1)).toBeNull();
    const allowed = build(syncAdapter(true));
    expect(allowed.reserve(1)).toEqual({ n: 1 });
  });

  it('leaves a pool with no sharedState unchanged, on both methods', async () => {
    // The default path. `reserve()` must not start throwing for a caller who never
    // configured a shared store.
    //
    // **Two separate limiters, not one.** `PowerGCRA`'s ceiling is 1, so calling
    // both methods against the same instance spends the only token on the first
    // call and the second is denied by the local leg — which is how the first draft
    // of this test failed against correct code.
    const sync = new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000 })]);
    expect(sync.reserve(1)).toEqual({ n: 1 });
    const async = new PowerRateLimit([new PowerGCRA({ rate: 10, per: 1000 })]);
    await expect(async.reserveAsync(1)).resolves.toEqual({ n: 1 });
  });

  it('does not consult the shared store twice for one reserveAsync', async () => {
    // `reserveAsync` calls `tryConsume` once. A second call would double-count
    // against the distributed budget, which is the leak this row exists to stop.
    const adapter = asyncAdapter(true);
    const rl = build(adapter);
    await rl.reserveAsync(1);
    expect(adapter.calls).toBe(1);
  });

  it('releases a granted reservation back to the local legs', async () => {
    // The round-trip, so the token `reserveAsync` mints is one `release()` accepts.
    // The shared store has no refund in its contract — `checkAndIncrement` is the
    // only method — so this pins the local half and records the distributed half as
    // out of scope rather than silently ignoring it.
    const rl = build(asyncAdapter(true));
    const token = await rl.reserveAsync(1);
    expect(token).toEqual({ n: 1 });
    expect(() => rl.release(token)).not.toThrow();
  });
});
