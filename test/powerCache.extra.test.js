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

  // PERF-006. `interval` was checked with `Number.isFinite` alone, and the numeric
  // argument form was not checked at all, so `0` and a negative both reached
  // `setSafeTimeout` — where Node treats a negative as `0` — and the cleanup tick
  // rescheduled itself with no delay.
  //
  // Asserted by throwing, not by counting ticks. A tick count would be a duration
  // assertion, and this project's harness measures a 28.61% median min/max spread
  // on a typical machine; the boundary that matters here is `0`, which is exact.
  // The measured cost of the old behaviour — 93 ticks in 100 ms for `0`, 94 for
  // `-5`, 93 for `{ interval: 0 }`, against 0 for the derived default — is recorded
  // on the row and on `startCleanup` itself.
  it('refuses a zero or negative interval rather than spinning', () => {
    for (const arg of [0, -5, { interval: 0 }, { intervalMs: 0 }]) {
      const cache = new PowerCache();
      expect(() => cache.startCleanup(arg), `for ${JSON.stringify(arg)}`).toThrow(/interval/);
      cache.stopCleanup();
    }
  });

  it('still accepts 1 ms and the derived default', () => {
    // The floor is the boundary between "scheduled" and "as fast as the event loop
    // can turn", so 1 has to remain legal — and a caller who asks for nothing must
    // still get the TTL-derived default rather than the floor.
    const fastest = new PowerCache();
    fastest.startCleanup(1);
    expect(fastest._cleanupParams.interval).toBe(1);
    fastest.stopCleanup();

    const derived = new PowerCache();
    derived.startCleanup();
    expect(derived._cleanupParams.interval).toBeGreaterThan(1);
    derived.stopCleanup();
  });
});
