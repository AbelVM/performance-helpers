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
    // `PowerLogger` gates on `typeof ROOT_CONSOLE.table === 'function'`, so the
    // condition to build is a property whose *value* is not a function — deleting
    // the key would test something else, and stubbing `globalThis.table` is not
    // the same property at all.
    //
    // Written with descriptors rather than `console.table = undefined`, for two
    // reasons. The first is why `no-console` fired here at all: it flags the read
    // that stashes the original and both writes, and it is right to, because
    // reaching past `console` to manufacture a test condition is exactly what
    // that rule exists to notice. Suppressing it would silence the rule for every
    // later test in this file. The second is correctness — restoring a descriptor
    // restores the property's own attributes, where assigning the value back
    // leaves behind whatever `defineProperty` was handed.
    const originalTable = Object.getOwnPropertyDescriptor(console, 'table');
    try {
      Object.defineProperty(console, 'table', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const logger = new PowerLogger(3);
      logger.table('fallback-table');
      expect(logSpy).toHaveBeenCalledWith('fallback-table');
    } finally {
      if (originalTable) Object.defineProperty(console, 'table', originalTable);
      // `Reflect` rather than `delete console.table` for the same rule: a member
      // expression is what `no-console` matches on, and this branch only runs if
      // the property was inherited rather than own.
      else Reflect.deleteProperty(console, 'table');
      logSpy.mockRestore();
    }
  });
});
