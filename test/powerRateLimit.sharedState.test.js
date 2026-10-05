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
