import { describe, it, expect, vi } from 'vitest';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';

describe('PowerRateLimit extra branches', () => {
  it('constructor requires an array', () => {
    expect(() => new PowerRateLimit({})).toThrow(TypeError);
  });

  it('tryConsume with 0 returns true', () => {
    const r = new PowerRateLimit([]);
    expect(r.tryConsume(0)).toBe(true);
  });

  it('fast available() check returns false when any limiter reports insufficient', () => {
    const limiter = { available: () => 0, tryConsume: vi.fn(() => true) };
    const r = new PowerRateLimit([limiter]);
    expect(r.tryConsume(1)).toBe(false);
  });

  it('available() returns the minimum available across child limiters', () => {
    const a = { available: () => 5, tryConsume: vi.fn(() => true) };
    const b = { available: () => 2, tryConsume: vi.fn(() => true) };
    const r = new PowerRateLimit([a, b]);
    expect(r.available()).toBe(2);
  });

  it('available() returns Infinity when no limiters are configured', () => {
    const r = new PowerRateLimit([]);
    expect(r.available()).toBe(Infinity);
  });

  it('available() returns 0 when any child limiter lacks available()', () => {
    const a = { available: () => 5, tryConsume: vi.fn(() => true) };
    const b = { tryConsume: vi.fn(() => true) };
    const r = new PowerRateLimit([a, b]);
    expect(r.available()).toBe(0);
  });

  it('reserve and release work across atomic limiters', () => {
    const l1 = { reserve: vi.fn((n) => ({ n })), release: vi.fn() };
    const l2 = { tryConsume: vi.fn(() => true), rollback: vi.fn() };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    const token = r.reserve(1);
    expect(token).toEqual({ n: 1 });
    expect(l1.reserve).toHaveBeenCalledWith(1);
    r.release(token);
    expect(l1.release).toHaveBeenCalledWith(token);
    expect(l2.rollback).toHaveBeenCalledWith(1);
  });

  it('rollback aliases release', () => {
    const l1 = { reserve: vi.fn((n) => ({ n })), release: vi.fn() };
    const l2 = { tryConsume: vi.fn(() => true), rollback: vi.fn() };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    const token = r.reserve(1);
    expect(token).not.toBeNull();
    r.rollback(token);
    expect(l1.release).toHaveBeenCalledWith(token);
    expect(l2.rollback).toHaveBeenCalledWith(1);
  });

  it('reserve returns null when atomic reservation cannot be guaranteed', () => {
    const a = { reserve: vi.fn((n) => ({ n })), release: vi.fn() };
    const b = { tryConsume: vi.fn(() => false), rollback: vi.fn() };
    const r = new PowerRateLimit([a, b], { atomic: true });
    expect(r.reserve(1)).toBeNull();
    expect(a.release).toHaveBeenCalled();
  });

  it('reserve returns a zero token for non-positive requests and release ignores zero-ish input', () => {
    const l = { release: vi.fn(), rollback: vi.fn(), addTokens: vi.fn() };
    const r = new PowerRateLimit([l], { atomic: true });

    expect(r.reserve(0)).toEqual({ n: 0 });
    r.release(null);
    r.release({ n: 0 });
    r.release(0);

    expect(l.release).not.toHaveBeenCalled();
    expect(l.rollback).not.toHaveBeenCalled();
    expect(l.addTokens).not.toHaveBeenCalled();
  });

  it('release falls back to addTokens when release and rollback are unavailable or throw', () => {
    const limiter = {
      release: vi.fn(() => {
        throw new Error('release failed');
      }),
      rollback: vi.fn(() => {
        throw new Error('rollback failed');
      }),
      addTokens: vi.fn(),
    };
    const r = new PowerRateLimit([limiter]);

    r.release(2);

    expect(limiter.release).toHaveBeenCalled();
    expect(limiter.rollback).toHaveBeenCalledWith(2);
    expect(limiter.addTokens).toHaveBeenCalledWith(2);
  });

  it('reset swallows limiter reset errors and rollback remains a public alias', () => {
    const limiter = {
      reset: vi.fn(() => {
        throw new Error('reset failed');
      }),
      rollback: vi.fn(),
    };
    const r = new PowerRateLimit([limiter]);

    expect(() => r.reset()).not.toThrow();
    r.rollback({ n: 3 });

    expect(limiter.reset).toHaveBeenCalled();
    expect(limiter.rollback).toHaveBeenCalledWith(3);
  });

  it('atomic consume returns false when a limiter lacks undo capability', () => {
    const a = { available: () => 10, tryConsume: vi.fn(() => true) };
    // b lacks available and any undo primitives
    const b = { tryConsume: vi.fn(() => true) };
    const r = new PowerRateLimit([a, b], { atomic: true });
    expect(r.tryConsume(1)).toBe(false);
  });

  it('reserve + tryConsume commit succeeds and calls reserve', () => {
    const l1 = { reserve: vi.fn((n) => ({ t: true })), release: vi.fn() };
    // provide a noop rollback so pre-check allows atomic path
    const l2 = { tryConsume: vi.fn(() => true), rollback: vi.fn() };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    expect(r.tryConsume(1)).toBe(true);
    expect(l1.reserve).toHaveBeenCalled();
    expect(l2.tryConsume).toHaveBeenCalled();
  });

  it('undo is attempted when a later limiter fails', () => {
    const l1 = { reserve: vi.fn((n) => ({ t: true })), release: vi.fn() };
    const l2 = { tryConsume: vi.fn(() => false), rollback: vi.fn() };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    expect(r.tryConsume(1)).toBe(false);
    // release should have been called as part of rollback attempts
    expect(l1.release).toHaveBeenCalled();
  });
});
