import { describe, it, expect, vi } from 'vitest';
import PowerRateLimit from '../src/helpers/powerRateLimit.js';

describe('PowerRateLimit functions and undo paths', () => {
  it('returns false when available() throws', () => {
    const bad = { available: () => { throw new Error('boom'); }, tryConsume: () => true };
    const r = new PowerRateLimit([bad]);
    expect(r.tryConsume(1)).toBe(false);
  });

  it('throws TypeError when limiter missing tryConsume in fast-path', () => {
    const lim = { available: () => 10 };
    const r = new PowerRateLimit([lim]);
    expect(() => r.tryConsume(1)).toThrow(TypeError);
  });

  it('rollback calls release when a reserve later throws', () => {
    const l1 = { reserve: (n) => ({ tok: true }), release: vi.fn() };
    const l2 = { reserve: () => { throw new Error('reserve fail'); }, release: vi.fn() };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    expect(r.tryConsume(1)).toBe(false);
    expect(l1.release).toHaveBeenCalled();
  });

  it('undo uses rollback/addTokens/reset fallback when necessary', () => {
    const l1 = { available: () => 10, tryConsume: () => true, reset: vi.fn() };
    const l2 = { tryConsume: () => false, rollback: vi.fn() };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    expect(r.tryConsume(1)).toBe(false);
    expect(l1.reset).toHaveBeenCalled();
  });

  it('undo swallows errors from release/rollback', () => {
    const l1 = { reserve: () => ({ tok: true }), release: () => { throw new Error('boom release'); } };
    const l2 = { tryConsume: () => { throw new Error('boom try'); }, rollback: () => { throw new Error('boom rollback'); } };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    // should return false and not throw despite undo errors
    expect(r.tryConsume(1)).toBe(false);
  });

  it('direct _undoCommit release/rollback/addTokens/reset paths are exercised', async () => {
    const r = new PowerRateLimit([]);

    const rel = { release: vi.fn() };
    await r._undoCommit({ l: rel, method: 'reserve', token: 't' }, 1);
    expect(rel.release).toHaveBeenCalledWith('t');

    const rb = { rollback: vi.fn() };
    await r._undoCommit({ l: rb, method: 'tryConsume' }, 2);
    expect(rb.rollback).toHaveBeenCalledWith(2);

    const at = { addTokens: vi.fn() };
    await r._undoCommit({ l: at, method: 'tryConsume' }, 3);
    expect(at.addTokens).toHaveBeenCalledWith(3);

    const rs = { reset: vi.fn() };
    await r._undoCommit({ l: rs, method: 'tryConsume' }, 4);
    expect(rs.reset).toHaveBeenCalled();
  });

  it('throws TypeError and rolls back when atomic fallback limiter missing tryConsume or reserve', () => {
    // first limiter reserves successfully
    const l1 = { reserve: (n) => ({ t: true }), release: vi.fn() };
    // second limiter lacks reserve and tryConsume but has addTokens (pre-check passes)
    const l2 = { addTokens: (n) => {}, /* no tryConsume or reserve */ };
    const r = new PowerRateLimit([l1, l2], { atomic: true });
    expect(() => r.tryConsume(1)).toThrow(TypeError);
    // ensure rollback attempted for l1
    expect(l1.release).toHaveBeenCalled();
  });

  it('calls limiter.reset via _undoCommit and reset()', async () => {
    const l = { reset: vi.fn() };
    const r = new PowerRateLimit([l]);
    // call public reset()
    r.reset();
    expect(l.reset).toHaveBeenCalled();

    // call private undo path that falls back to reset
    l.reset.mockClear();
    await r._undoCommit({ l, method: 'tryConsume' }, 1);
    expect(l.reset).toHaveBeenCalled();
  });
});
