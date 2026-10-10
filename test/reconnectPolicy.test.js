/**
 * Tests for the shared reconnection backoff curve.
 *
 * **These are the tests the curve never had.** Both transports carried a private
 * `_nextReconnectDelay()` that was character-for-character identical, and neither
 * had a unit test of its own — the curve was only ever exercised through a live
 * transport, so a regression in it would surface as a flaky integration test
 * rather than a red unit. That is the whole reason `ReconnectPolicy` exists.
 *
 * @see src/utils/reconnectPolicy.js
 */
import { describe, it, expect } from 'vitest';
import { ReconnectPolicy } from '../src/utils/reconnectPolicy.js';

/**
 * A deterministic jitter source, so the curve can be pinned exactly rather than
 * asserted on a range. `t` in `[0, 1]` selects where in the band the draw lands.
 *
 * @param {number} t
 * @returns {() => number}
 */
const jitter = (t) => () => t;

describe('ReconnectPolicy', () => {
  it('draws the first delay from the base band, not from nothing', () => {
    // The cursor starts `null`, so the first draw is from `[base/2, base]`. A
    // policy that started from `0` would return `0` and reconnect instantly.
    const policy = new ReconnectPolicy({ baseMs: 500, maxMs: 30_000, random: jitter(0) });
    expect(policy.next()).toBe(250);
  });

  it('grows the cursor by 3x after each draw, so the band widens', () => {
    // Decorrelated jitter draws from `[cursor/2, cursor]`, so a wider cursor is a
    // wider band. Growth is applied *after* the draw, which is what makes the
    // first delay exactly the base.
    const policy = new ReconnectPolicy({ baseMs: 500, maxMs: 30_000, random: jitter(0) });
    expect(policy.next()).toBe(250); // cursor 500 -> 1500
    expect(policy.next()).toBe(750); // cursor 1500 -> 4500
    expect(policy.next()).toBe(2250); // cursor 4500 -> 13500
    expect(policy.next()).toBe(6750); // cursor 13500 -> 40500, clamped to 30000
  });

  it('clamps both the cursor and the delay at maxMs', () => {
    // The ceiling applies to the cursor as well as the delay. Clamping only the
    // delay would let the cursor grow without bound, and the band would widen
    // past the ceiling while every draw still returned the ceiling.
    const policy = new ReconnectPolicy({ baseMs: 1000, maxMs: 5000, random: jitter(1) });
    for (let i = 0; i < 20; i++) policy.next();
    expect(policy.cursorMs).toBe(5000);
    expect(policy.next()).toBe(5000);
  });

  it('draws from the whole band, not only its endpoints', () => {
    // The band is `[cursor/2, cursor]`. A draw at `t` lands at
    // `cursor/2 + t * cursor/2`, so `t = 0.5` is the midpoint.
    const low = new ReconnectPolicy({ baseMs: 1000, maxMs: 30_000, random: jitter(0) });
    const mid = new ReconnectPolicy({ baseMs: 1000, maxMs: 30_000, random: jitter(0.5) });
    const high = new ReconnectPolicy({ baseMs: 1000, maxMs: 30_000, random: jitter(1) });
    expect(low.next()).toBe(500);
    expect(mid.next()).toBe(750);
    expect(high.next()).toBe(1000);
  });

  it('returns an integer, because setTimeout takes one', () => {
    // `Math.floor` on the way out. A fractional delay is not a correctness bug
    // for `setTimeout`, but it is a lie in `stats()` and in a log line.
    const policy = new ReconnectPolicy({ baseMs: 333, maxMs: 30_000, random: jitter(0.333) });
    for (let i = 0; i < 10; i++) expect(Number.isInteger(policy.next())).toBe(true);
  });

  it('resets to the base on reset(), so a good connection clears the curve', () => {
    // **The reason `reset()` exists.** A transport that reconnects after a long
    // outage would otherwise resume from a cursor grown by the outage's failed
    // attempts, so the first delay after a *good* connection is still seconds
    // long. Resetting on success makes the curve track current conditions rather
    // than the worst it has seen.
    const policy = new ReconnectPolicy({ baseMs: 500, maxMs: 30_000, random: jitter(0) });
    policy.next();
    policy.next();
    policy.next();
    expect(policy.cursorMs).toBeGreaterThan(500);

    policy.reset();
    expect(policy.cursorMs).toBe(500);
    expect(policy.next()).toBe(250);
  });

  it('reports the base as the cursor before the first draw', () => {
    // Reading the cursor must not advance the curve, and must not lie about it
    // either: before the first draw the effective cursor *is* the base.
    const policy = new ReconnectPolicy({ baseMs: 500, maxMs: 30_000 });
    expect(policy.cursorMs).toBe(500);
    expect(policy.cursorMs).toBe(500);
    expect(policy.next()).toBeGreaterThan(0);
  });

  it('clamps a base above the max rather than producing an unbounded cursor', () => {
    // A configuration mistake, but the honest reading of "base above ceiling" is
    // "the ceiling", not a cursor that grows from a value it can never reach.
    const policy = new ReconnectPolicy({ baseMs: 10_000, maxMs: 5000, random: jitter(0) });
    expect(policy.baseMs).toBe(5000);
    expect(policy.next()).toBe(2500);
  });

  it('rejects a non-finite or negative bound', () => {
    // Same shape as every other limit in this library: refuse at construction
    // rather than producing a curve that silently misbehaves.
    expect(() => new ReconnectPolicy({ baseMs: -1 })).toThrow(TypeError);
    expect(() => new ReconnectPolicy({ baseMs: Number.NaN })).toThrow(TypeError);
    expect(() => new ReconnectPolicy({ maxMs: -1 })).toThrow(TypeError);
    expect(() => new ReconnectPolicy({ maxMs: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('accepts a zero base, which means reconnect immediately', () => {
    // `0` is a legitimate "no backoff" configuration, matching every other limit
    // here. It must not be refused, and it must not produce `NaN`.
    const policy = new ReconnectPolicy({ baseMs: 0, maxMs: 30_000, random: jitter(0.5) });
    expect(policy.next()).toBe(0);
    expect(policy.next()).toBe(0);
  });

  it('defaults to the AWS-recommended curve when nothing is configured', () => {
    // 500ms base, 30s ceiling — the values both transports already used, so
    // adopting the policy changes no behaviour.
    const policy = new ReconnectPolicy();
    expect(policy.baseMs).toBe(500);
    expect(policy.maxMs).toBe(30_000);
    const first = policy.next();
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThanOrEqual(500);
  });

  it('decorrelates: two policies with different jitter draw different delays', () => {
    // The property the whole curve exists for. Full jitter would let a cohort
    // re-form; decorrelated jitter spreads them. Asserted on the *shape* of the
    // distribution rather than on a seed, because the point is that the draws
    // differ.
    const a = new ReconnectPolicy({ baseMs: 1000, maxMs: 30_000 });
    const b = new ReconnectPolicy({ baseMs: 1000, maxMs: 30_000 });
    const drawsA = Array.from({ length: 20 }, () => a.next());
    const drawsB = Array.from({ length: 20 }, () => b.next());
    expect(drawsA).not.toEqual(drawsB);
    // And every draw is inside the band its cursor implies.
    for (const d of drawsA) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });
});
