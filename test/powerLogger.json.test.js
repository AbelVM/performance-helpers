import { describe, it, expect, vi } from 'vitest';
import { PowerLogger } from '../src/helpers/powerLogger.js';

describe('PowerLogger JSON output mode', () => {
  it('emits JSON on error/warn/info/log when format=json', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const logger = new PowerLogger(3, { format: 'json' });
      logger.error('err-msg');
      logger.warn({ a: 1 });
      logger.info(() => 'info-msg');
      logger.log('one', 'two');

      expect(errSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();

      const parsed = JSON.parse(errSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('error');
      expect(parsed.msg).toBe('err-msg');
      expect(typeof parsed.ts).toBe('number');

      const parsedWarn = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(parsedWarn.level).toBe('warn');
      expect(parsedWarn.msg).toEqual({ a: 1 });

      const parsedInfo = JSON.parse(infoSpy.mock.calls[0][0]);
      expect(parsedInfo.level).toBe('info');
      expect(parsedInfo.msg).toBe('info-msg');

      const parsedLog = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsedLog.level).toBe('log');
      expect(Array.isArray(parsedLog.msg)).toBe(true);
      expect(parsedLog.msg).toEqual(['one', 'two']);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
