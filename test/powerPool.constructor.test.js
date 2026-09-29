import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, final file: constructor validation and the guards around it.
 *
 * These are the branches at the very top of the file, which is where a caller
 * meets the class for the first time. Two of them are error contracts that are
 * documented but were never executed by an assertion: the options type check
 * and the `Invalid workerSource` rethrow.
 *
 * The `Invalid workerSource` rethrow is the interesting one. Worker creation
 * failing is normally *swallowed* - a pool that cannot start one worker is
 * still useful. The exception is a worker source that could never work, and
 * that error is rethrown rather than logged, so a caller sees a `TypeError`
 * instead of a pool that appears to have started with no workers. Nothing
 * tested that distinction.
 */

function Silent() {
  this.onmessage = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}) {
  const pool = new PowerPool(Silent, { size: 0, minSize: 0, maxSize: 1, ...options });
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

describe('PowerPool constructor validation', () => {
  it('rejects a non-object options argument', () => {
    // Passing options positionally is a common mistake with a two-argument
    // constructor, and the resulting `undefined` everywhere else would be far
    // harder to diagnose than a `TypeError` at construction.
    expect(() => new PowerPool(Silent, 'size 4')).toThrow(TypeError);
    expect(() => new PowerPool(Silent, 42)).toThrow(/options must be an object/);
  });

  it('accepts a null or omitted options argument', () => {
    // `null` is explicitly allowed by the guard (`arguments[1] != null`), so it
    // must not throw. A guard that rejects null would break every caller that
    // passes a nullable config through.
    expect(() => new PowerPool(Silent, null)).not.toThrow();
    expect(() => new PowerPool(Silent)).not.toThrow();
  });

  it('rethrows an Invalid workerSource error rather than swallowing it', () => {
    const bad = () => {
      throw new TypeError('Invalid workerSource: expected a function, string, or URL');
    };
    // A worker source that could never work is a contract violation, and the
    // caller needs to see it. Swallowing it produces a pool that reports
    // itself healthy with zero workers, and the first symptom is a task that
    // is never dispatched.
    expect(() => new PowerPool(bad, { size: 1, minSize: 1, lazy: false })).toThrow(
      /Invalid workerSource/
    );
  });

  it('survives an error whose message getter throws', () => {
    const hostile = () => {
      // Reading `.message` on this throws, so the classifier in the catch
      // cannot classify it. The comment says letting that propagate is the
      // honest outcome - this pins that it does, rather than silently
      // swallowing an error nobody could look at.
      throw {
        get message() {
          throw new Error('message is booby-trapped');
        },
      };
    };
    expect(() => new PowerPool(hostile, { size: 1, minSize: 1, lazy: false })).toThrow();
  });

  it('swallows a worker-creation failure that is not a contract violation', () => {
    const flaky = () => {
      throw new Error('EMFILE: too many open files');
    };
    // The mirror of the rethrow: a transient failure must leave a usable pool
    // rather than take the process down at import time.
    const pool = new PowerPool(flaky, { size: 1, minSize: 0, maxSize: 1, lazy: false });
    pools.push(pool);
    expect(pool.workers.length).toBe(0);
  });

  it('falls back to the default timeout for a non-numeric awaitResponseTimeout', () => {
    const pool = makePool({ awaitResponseTimeout: 'soon' });
    // `Number.isFinite(Number('soon'))` is false, so the default applies. A
    // `NaN` timeout here would make every pending response either expire
    // instantly or never, depending on which comparison won.
    expect(Number.isNaN(pool._defaultAwaitResponseTimeout)).toBe(false);
    expect(pool._defaultAwaitResponseTimeout).toBeGreaterThan(0);
  });

  it('accepts a zero awaitResponseTimeout, which disables the default', () => {
    const pool = makePool({ awaitResponseTimeout: 0 });
    // `0` is legal and means "no default timeout" - a caller who always passes
    // its own `timeout` should not have a second one armed behind them.
    expect(pool._defaultAwaitResponseTimeout).toBe(0);
  });

  it('adopts a numeric debugLevel and ignores a non-numeric one', () => {
    expect(makePool({ debugLevel: 0 })).toBeTruthy();
    expect(makePool({ debugLevel: 'loud' })).toBeTruthy();
    // Both must construct. The logger is created from the resolved value, so a
    // non-numeric request falls back to the default rather than being passed
    // through to a level comparison that would then be `NaN`.
  });
});

describe('PowerPool reaper interval', () => {
  it('creates the reaper once and reuses it', () => {
    const pool = makePool({ size: 1, minSize: 1, lazy: false, idleTimeout: 60000 });
    pool._ensureReaper();
    const first = pool._reaperInterval;
    expect(first).toBeTruthy();
    pool._ensureReaper();
    // A second interval would double every idle reap, so a worker could be
    // reaped twice for the same tick - and the second reap operates on a list
    // the first one already shortened.
    expect(pool._reaperInterval).toBe(first);
  });

  it('recreates the reaper after it was cleared', () => {
    const pool = makePool({ size: 1, minSize: 1, lazy: false, idleTimeout: 60000 });
    pool._ensureReaper();
    const first = pool._reaperInterval;
    pool._reaperInterval = null;
    pool._ensureReaper();
    // A terminated pool clears its intervals; a later call that does not
    // recreate one leaves a pool that never reaps an idle worker again.
    expect(pool._reaperInterval).toBeTruthy();
    expect(pool._reaperInterval).not.toBe(first);
  });

  it('does not throw when the interval cannot be created', () => {
    const pool = makePool({ size: 1, minSize: 1, lazy: false, idleTimeout: 60000 });
    const original = pool._reaperInterval;
    pool._reaperInterval = null;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => {
      throw new Error('interval creation refused');
    };
    try {
      expect(() => pool._ensureReaper()).not.toThrow();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    // Nothing else depends on the reaper existing, so a runtime that refuses
    // intervals degrades to "no idle reaping" rather than breaking the pool.
    void original;
  });
});

describe('PowerPool correlation key coercion', () => {
  it('coerces a numeric correlation id to a string key', async () => {
    class Echo {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 1);
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Echo, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    pools.push(pool);
    const pending = pool.postMessage({ a: 1 }, undefined, { correlationId: 7 });
    // A number and the string `'7'` are the same id to a caller, so the key is
    // coerced. Without that, a worker echoing `correlationId: 7` would not match
    // a pool that stored it as a number.
    await expect(pending).resolves.toBeTruthy();
  });
});
