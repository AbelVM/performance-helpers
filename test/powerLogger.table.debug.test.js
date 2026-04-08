import { describe, it, expect, vi } from 'vitest';
import { PowerLogger } from '../src/helpers/powerLogger.js';

describe('PowerLogger table and debug methods', () => {
  it('calls console.debug when debug() invoked and level>=3', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const logger = new PowerLogger(3);
      logger.debug('x', 1);
      expect(debugSpy).toHaveBeenCalled();
      const callArgs = debugSpy.mock.calls[0];
      expect(callArgs[0]).toBe('x');
      expect(callArgs[1]).toBe(1);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('emits JSON for debug() when format=json', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const logger = new PowerLogger(3, { format: 'json' });
      logger.debug({ a: 1 });
      expect(debugSpy).toHaveBeenCalled();
      const parsed = JSON.parse(debugSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('debug');
      expect(parsed.msg).toEqual({ a: 1 });
      expect(typeof parsed.ts).toBe('number');
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('uses console.table when available for table()', () => {
    const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
    try {
      const logger = new PowerLogger(3);
      const data = [{ a: 1 }, { a: 2 }];
      logger.table(data);
      expect(tableSpy).toHaveBeenCalled();
      expect(tableSpy.mock.calls[0][0]).toBe(data);
    } finally {
      tableSpy.mockRestore();
    }
  });

  it('emits JSON for table() when format=json', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = new PowerLogger(3, { format: 'json' });
      const data = [{ a: 1 }, { a: 2 }];
      logger.table(data);
      expect(logSpy).toHaveBeenCalled();
      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('table');
      expect(Array.isArray(parsed.msg)).toBe(true);
      expect(parsed.msg[0]).toEqual(data);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('falls back to console.log when console.table is unavailable', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalTable = console.table;
    try {
      // @ts-ignore
      console.table = undefined;
      const logger = new PowerLogger(3);
      logger.table('fallback-table');
      expect(logSpy).toHaveBeenCalledWith('fallback-table');
    } finally {
      console.table = originalTable;
      logSpy.mockRestore();
    }
  });
});
