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
    const origDateNow = Date.now;
    Date.now = () => 1_000_010;

    const mod = await import('../src/utils/now.js');
    const v = mod.nowMs();
    expect(v).toBe(1_000_010);

    Date.now = origDateNow;
  });

  it('falls back to Date.now() when performance diverges', async () => {
    vi.resetModules();
    // Perf reports epoch far away from Date.now()
    global.performance = { timeOrigin: 0, now: () => 0 };
    const origDateNow = Date.now;
    Date.now = () => 2_000;

    const mod = await import('../src/utils/now.js');
    const v = mod.nowMs();
    expect(v).toBe(2_000);

    Date.now = origDateNow;
  });

  it('uses process.hrtime.bigint() when performance is absent', async () => {
    vi.resetModules();
    // Remove performance to force hrtime path
    // Stub process.hrtime.bigint to make hrVal align with Date.now()
    const origHr = process.hrtime && process.hrtime.bigint;
    const now = Date.now();
    process.hrtime = process.hrtime || (() => {});
    process.hrtime = Object.assign(process.hrtime, {});
    process.hrtime.bigint = () => BigInt(now * 1_000_000);

    delete global.performance;

    const mod = await import('../src/utils/now.js');
    const v = mod.nowMs();
    // hrtime-backed value should be close to Date.now() (module logic returns hrVal)
    expect(Math.abs(v - now)).toBeLessThan(10);

    if (origHr) process.hrtime.bigint = origHr;
  });
});
