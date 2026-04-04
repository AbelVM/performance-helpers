import { describe, it, expect, vi } from 'vitest';
import { PowerLogger } from '../src/helpers/powerLogger.js';

describe('PowerLogger formatter and name option', () => {
  it('includes name in JSON payload when provided', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = new PowerLogger(3, { format: 'json', name: 'my-logger' });
      logger.log('hello');
      expect(logSpy).toHaveBeenCalled();
      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('log');
      expect(parsed.name).toBe('my-logger');
      expect(parsed.msg).toBe('hello');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('calls formatter when provided and uses its return value as payload', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const formatter = (payload) => ({
        l: payload.level,
        n: payload.name || null,
        m: payload.msg,
      });
      const logger = new PowerLogger(3, { format: 'json', name: 'x', formatter });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        logger.info('y');
        expect(infoSpy).toHaveBeenCalled();
        const parsed = JSON.parse(infoSpy.mock.calls[0][0]);
        expect(parsed.l).toBe('info');
        expect(parsed.n).toBe('x');
        expect(parsed.m).toBe('y');
      } finally {
        infoSpy.mockRestore();
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it('allows formatter to return a string directly', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const formatter = (payload) => `${payload.level}:${payload.msg}`;
      const logger = new PowerLogger(3, { format: 'json', name: 'x', formatter });
      logger.log('z');
      expect(logSpy).toHaveBeenCalled();
      const emitted = logSpy.mock.calls[0][0];
      expect(emitted).toBe('log:z');
    } finally {
      logSpy.mockRestore();
    }
  });
});
