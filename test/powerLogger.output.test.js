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
    expect(payload).toHaveProperty('format', 'json');
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

  it('swallows output transport errors', () => {
    const logger = new PowerLogger(3, {
      format: 'json',
      output() {
        throw new Error('transport failed');
      },
    });

    expect(() => logger.info('safe')).not.toThrow();
  });

  it('falls back to the original payload when formatter throws', () => {
    const out = vi.fn();
    const logger = new PowerLogger(3, {
      format: 'json',
      name: 'fallback',
      output: out,
      formatter() {
        throw new Error('formatter failed');
      },
    });

    logger.warn('hello');

    expect(out).toHaveBeenCalled();
    expect(out.mock.calls[0][0]).toMatchObject({
      level: 'warn',
      msg: 'hello',
      format: 'json',
      name: 'fallback',
    });
  });

  it('passes formatter strings directly to output transports', () => {
    const out = vi.fn();
    const logger = new PowerLogger(3, {
      format: 'json',
      output: out,
      formatter: (payload) => `${payload.level}:${payload.msg}`,
    });

    logger.info('transport-string');

    expect(out).toHaveBeenCalledWith('info:transport-string');
  });
});
