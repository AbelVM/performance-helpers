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
