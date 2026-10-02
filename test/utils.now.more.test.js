import { describe, it, expect, vi, afterEach } from 'vitest';

describe('nowMs extra branches', () => {
  afterEach(() => {
    // Restore environment
    vi.resetAllMocks();
    vi.resetModules();
  });

  it('prefers performance when close to Date.now()', async () => {
    vi.resetModules();
    // Make perf-based time close to Date.now()
    global.performance = { timeOrigin: 1_000_000, now: () => 10 };
    // `vi.spyOn` owns the restore, which is what `require-atomic-updates` is
    // asking for: reading `Date.now` into a local, yielding on `await import`,
    // then assigning it back is the shape the rule exists to catch. It also
    // cannot be skipped — the mock restores itself from a `finally`, where the
    // trailing `Date.now = origDateNow` this replaced sat *after* the assertion
    // and so leaked a stubbed `Date.now` into every later test whenever an
    // `expect` failed.
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000_010);
    try {
      const mod = await import('../src/utils/now.js');
      const v = mod.nowMs();
      expect(v).toBe(1_000_010);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('falls back to Date.now() when performance diverges', async () => {
    vi.resetModules();
    // Perf reports epoch far away from Date.now()
    global.performance = { timeOrigin: 0, now: () => 0 };
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    try {
      const mod = await import('../src/utils/now.js');
      const v = mod.nowMs();
      expect(v).toBe(2_000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('uses process.hrtime.bigint() when performance is absent', async () => {
    vi.resetModules();
    // Remove performance to force hrtime path
    const now = Date.now();
    // Stub process.hrtime.bigint to make hrVal align with Date.now()
    const hrBigint = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(BigInt(now * 1_000_000));

    delete global.performance;
    try {
      const mod = await import('../src/utils/now.js');
      const v = mod.nowMs();
      // hrtime-backed value should be close to Date.now() (module logic returns hrVal)
      expect(Math.abs(v - now)).toBeLessThan(10);
    } finally {
      hrBigint.mockRestore();
    }
  });
});
