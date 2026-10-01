import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

// QUAL-011 (F9): `startCleanup` accepted `{intervalMs}` and dropped it.
describe('startCleanup accepts every argument shape a caller reaches for', () => {
  it('honours a number, `{interval}`, and `{intervalMs}` identically', () => {
    // `intervalMs` is the spelling roughly fifteen other options in this library
    // use, and it used to be accepted and silently ignored — the one argument
    // shape `startCleanup` dropped, in a method whose whole job is reading its
    // options. The cleanup then ran on the default interval the caller believed
    // they had overridden.
    for (const arg of [70, { interval: 70 }, { intervalMs: 70 }]) {
      const cache = new PowerCache();
      cache.startCleanup(arg);
      expect(cache._cleanupParams.interval, `for ${JSON.stringify(arg)}`).toBe(70);
      cache.stopCleanup();
    }
  });

  it('prefers an explicit `interval` when both spellings are given', () => {
    const cache = new PowerCache();
    cache.startCleanup({ interval: 70, intervalMs: 9999 });
    expect(cache._cleanupParams.interval).toBe(70);
    cache.stopCleanup();
  });
});
