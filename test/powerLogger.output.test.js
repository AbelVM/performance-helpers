import { describe, it, expect, vi } from 'vitest';
import { PowerLogger } from '../src/helpers/powerLogger.js';

describe('PowerLogger output transport', () => {
  it('calls provided output(payload) instead of console', () => {
    const out = vi.fn();
    const logger = new PowerLogger(3, { format: 'json', name: 't1', output: out });
    logger.info('hello', { a: 1 });
    expect(out).toHaveBeenCalled();
    const payload = out.mock.calls[0][0];
    expect(payload).toHaveProperty('level', 'info');
    expect(payload).toHaveProperty('msg');
    expect(payload).toHaveProperty('ts');
    expect(payload).toHaveProperty('name', 't1');
  });

  it('formatter can modify payload passed to output', () => {
    const out = vi.fn();
    const logger = new PowerLogger(3, {
      format: 'json',
      name: 't2',
      output: out,
      formatter: (p) => ({ lvl: p.level, m: p.msg, t: p.ts, nm: p.name }),
    });

    logger.error('oops');
    expect(out).toHaveBeenCalled();
    const payload = out.mock.calls[0][0];
    expect(payload).toHaveProperty('lvl', 'error');
    expect(payload).toHaveProperty('m');
    expect(payload).toHaveProperty('t');
    expect(payload).toHaveProperty('nm', 't2');
  });
});
