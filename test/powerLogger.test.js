import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as PowerLoggerModule from '../src/helpers/powerLogger.js';

const getCtor = (mod) => {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  if (mod && typeof mod.PowerLogger === 'function') return mod.PowerLogger;
  throw new Error('PowerLogger constructor not found');
};

describe('PowerLogger', () => {
  let logger;
  beforeEach(() => {
    const Ctor = getCtor(PowerLoggerModule);
    logger = new Ctor(0);
  });
  afterEach(() => {
    // nothing for now
  });

  it('sets and gets debug level', () => {
    logger.setDebugLevel(2);
    expect(logger.getDebugLevel()).toBe(2);
    expect(logger.isDebugLevel(1)).toBe(true);
    expect(logger.isDebugLevel(3)).toBe(false);
  });

  it('logs only when level permits', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.setDebugLevel(1);
    logger.error('e');
    logger.warn('w');
    expect(spyError).toHaveBeenCalled();
    expect(spyWarn).not.toHaveBeenCalled();

    logger.setDebugLevel(3);
    logger.info('i');
    logger.log('l');
    expect(spyInfo).toHaveBeenCalled();
    expect(spyLog).toHaveBeenCalled();

    spyError.mockRestore();
    spyWarn.mockRestore();
    spyInfo.mockRestore();
    spyLog.mockRestore();
  });

  it('increments counters when debug enabled', () => {
    logger.setDebugLevel(3);
    logger.incrementCounter('x');
    expect(logger.getDebugCounters()).toEqual({ x: 1 });
    logger.resetDebugCounters();
    expect(logger.getDebugCounters()).toEqual({});
  });
});
