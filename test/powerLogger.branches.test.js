import { describe, it, expect, vi } from 'vitest';
import * as PowerLoggerModule from '../src/helpers/powerLogger.js';

const getCtor = (mod) => {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  if (mod && typeof mod.PowerLogger === 'function') return mod.PowerLogger;
  throw new Error('PowerLogger constructor not found');
};

describe('PowerLogger branch coverage', () => {
  it('does not expose legacy global helpers', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(0);
    expect(typeof logger.hasLegacyDebug).toBe('undefined');
    expect(typeof logger.syncLegacyCounter).toBe('undefined');
  });

  it('debug helpers accept function args (lazy evaluation)', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(0);
    const side = { called: false };
    const fn = () => {
      side.called = true;
      return 'ok';
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.setDebugLevel(1);
    logger.error(fn);
    expect(side.called).toBe(true);
    spy.mockRestore();
  });

  it('setDebugLevel handles thrown-toString gracefully', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(0);
    // craft an object that throws when coerced
    const bad = {
      toString() {
        throw new Error('bad');
      },
    };
    logger.setDebugLevel(bad);
    expect(logger.getDebugLevel()).toBe(0);
  });

  it('debug methods swallow exceptions thrown by lazy args and handle missing console methods', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(3);

    // lazy arg that throws should be swallowed
    const badFn = () => {
      throw new Error('boom');
    };
    // spy console methods so we don't clutter output
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => logger.error(badFn)).not.toThrow();
    expect(() => logger.warn(badFn)).not.toThrow();
    expect(() => logger.info(badFn)).not.toThrow();
    expect(() => logger.log(badFn)).not.toThrow();

    spyErr.mockRestore();
    spyWarn.mockRestore();
    spyInfo.mockRestore();
    spyLog.mockRestore();

    // simulate missing console method (warn) - should simply return
    const origWarn = console.warn;
    try {
      // @ts-ignore
      console.warn = undefined;
      expect(() => logger.warn('x')).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
  });

  it('setDebugLevel coerces boxed primitives and incrementCounter ignores empty names when disabled', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(0);

    logger.setDebugLevel(new String('3'));
    expect(logger.getDebugLevel()).toBe(3);

    logger.setDebugLevel(new Boolean(false));
    expect(logger.getDebugLevel()).toBe(0);

    logger.incrementCounter('ignored');
    logger.setDebugLevel(3);
    logger.incrementCounter('');
    logger.incrementCounter(null);
    expect(logger.getDebugCounters()).toEqual({});
  });

  it('falls back when JSON and string coercion both fail', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(3, { format: 'json' });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('cannot serialize');
    });
    const toString = vi.spyOn(Object.prototype, 'toString').mockImplementation(() => {
      throw new Error('cannot stringify');
    });

    let thrown;
    let calls;
    try {
      logger.info('message');
      calls = spy.mock.calls.slice();
    } catch (error) {
      thrown = error;
    } finally {
      calls ??= spy.mock.calls.slice();
      stringify.mockRestore();
      toString.mockRestore();
      spy.mockRestore();
    }

    expect(thrown).toBeUndefined();
    expect(calls).toContainEqual(['[Unserializable]']);
  });

  it('swallows console failures after attempting the plain-argument fallback', () => {
    const Ctor = getCtor(PowerLoggerModule);
    const logger = new Ctor(3, { format: 'json' });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('console unavailable');
    });

    expect(() => logger.info('message')).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
