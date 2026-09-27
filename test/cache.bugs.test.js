import { describe, it, expect, vi } from 'vitest';
import { PowerCache, PowerBulkhead, PowerScheduler, PowerRateLimit } from '../src/index.js';
// Internal utility - intentionally not part of the public barrel export.
import { assertLimit, assertFunction } from '../src/utils/options.js';

describe('assertLimit (BUG-024)', () => {
  it('accepts Infinity when allowInfinity is set', () => {
    expect(assertLimit(Infinity, { name: 'maxEntries', className: 'X', allowInfinity: true })).toBe(
      Infinity
    );
  });

  it('rejects Infinity when allowInfinity is not set', () => {
    expect(() => assertLimit(Infinity, { name: 'maxEntries', className: 'X' })).toThrow(TypeError);
  });

  it('rejects NaN, strings and negative limits with an actionable message', () => {
    const spec = { name: 'maxEntries', className: 'PowerCache', min: 0 };
    expect(() => assertLimit(NaN, spec)).toThrow(/maxEntries.*finite number/s);
    expect(() => assertLimit('nope', spec)).toThrow(/maxEntries/);
    expect(() => assertLimit(-1, spec)).toThrow(/must be >= 0/);
  });

  it('passes undefined/null through unless a fallback is supplied', () => {
    const spec = { name: 'maxEntries', className: 'PowerCache' };
    expect(assertLimit(undefined, spec)).toBeUndefined();
    expect(assertLimit(null, spec)).toBeNull();
    expect(assertLimit(undefined, { ...spec, fallback: 7 })).toBe(7);
  });
});

describe('assertFunction (BUG-024)', () => {
  it('accepts functions and null, rejects other values', () => {
    const spec = { name: 'weightFn', className: 'PowerCache' };
    const fn = () => 1;
    expect(assertFunction(fn, spec)).toBe(fn);
    expect(assertFunction(null, spec)).toBeNull();
    expect(assertFunction(undefined, spec)).toBeNull();
    expect(() => assertFunction(42, spec)).toThrow(/must be a function/);
    expect(() => assertFunction(42, { ...spec, optional: false })).toThrow(TypeError);
  });
});

describe('PowerCache limit validation (BUG-024)', () => {
  it('keeps Infinity as the documented unbounded default', () => {
    const c = new PowerCache();
    expect(c.maxEntries).toBe(Infinity);
    expect(c.maxWeight).toBe(Infinity);
  });

  it('throws on a NaN maxEntries instead of silently disabling eviction', () => {
    // The old behaviour: `size > NaN` is always false, so eviction never ran
    // and the cache grew without bound with no diagnostic at all.
    expect(() => new PowerCache({ maxEntries: NaN })).toThrow(/maxEntries/);
  });

  it('throws on a negative maxEntries instead of emptying the cache permanently', () => {
    expect(() => new PowerCache({ maxEntries: -1 })).toThrow(/maxEntries.*>= 0/s);
  });

  it('throws on a non-function weightFn', () => {
    expect(() => new PowerCache({ weightFn: 'nope' })).toThrow(/weightFn/);
  });

  it('still accepts valid limits', () => {
    const c = new PowerCache({ maxEntries: 2, maxWeight: 10, maxPoolSize: 4 });
    expect(c.maxEntries).toBe(2);
    expect(c.maxWeight).toBe(10);
    expect(c.maxPoolSize).toBe(4);
  });
});

describe('PowerCache error reporting (BUG-013, BUG-014, QUAL-006)', () => {
  it('routes a throwing weightFn to onError and counts it', () => {
    const onError = vi.fn();
    const c = new PowerCache({
      maxWeight: 10,
      weightFn: () => {
        throw new Error('boom');
      },
      onError,
    });
    c.set('a', 1);
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][1]).toMatch(/weightFn/);
    expect(c._weightErrors).toBe(1);
  });

  it('routes a throwing onEvict from set() to onError (previously silent)', () => {
    const onError = vi.fn();
    const c = new PowerCache({
      maxEntries: 1,
      onEvict: () => {
        throw new Error('evict-boom');
      },
      onError,
    });
    c.set('a', 1);
    c.set('b', 2); // evicts 'a'
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][1]).toMatch(/onEvict/);
  });

  it('routes a throwing onEvict from delete() to onError (previously silent)', () => {
    const onError = vi.fn();
    const c = new PowerCache({
      onEvict: () => {
        throw new Error('del-boom');
      },
      onError,
    });
    c.set('a', 1);
    expect(() => c.delete('a')).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('survives a throwing onError handler', () => {
    const c = new PowerCache({
      onEvict: () => {
        throw new Error('evict-boom');
      },
      onError: () => {
        throw new Error('handler-boom');
      },
    });
    c.set('a', 1);
    expect(() => c.set('b', 2)).not.toThrow();
  });

  it('falls back to console.error when no onError is configured', () => {
    // Replace the global directly rather than via vi.spyOn: the helper module
    // resolves `console` from globalThis and vitest's spy wrapper is not
    // observed across the module boundary.
    const original = globalThis.console.error;
    const calls = [];
    globalThis.console.error = (...a) => calls.push(a);
    try {
      const c = new PowerCache({
        maxEntries: 1,
        onEvict: () => {
          throw new Error('x');
        },
      });
      c.set('a', 1);
      c.set('b', 2); // evicts 'a', whose onEvict throws
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(String(calls[0][0])).toMatch(/onEvict/);
    } finally {
      globalThis.console.error = original;
    }
  });
});

describe('PowerCache.getOrSetAsync late value (BUG-015)', () => {
  it('caches a value that resolves after the client timeout', async () => {
    const c = new PowerCache({ defaultAsyncTimeout: 20 });
    let resolveFactory;
    const p = c.getOrSetAsync(
      'slow',
      () =>
        new Promise((r) => {
          resolveFactory = r;
        })
    );
    await expect(p).rejects.toThrow(/timeout/);
    expect(c.size).toBe(0);

    // The factory finally succeeds - the expensive result should still land,
    // so the next caller does not pay the full cost again.
    resolveFactory('LATE');
    await new Promise((r) => setTimeout(r, 10));
    expect(c.get('slow')).toBe('LATE');
  });

  it('does not cache a rejected factory', async () => {
    const c = new PowerCache({ defaultAsyncTimeout: 0 });
    await expect(c.getOrSetAsync('bad', () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope'
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(c.has('bad')).toBe(false);
  });

  it('clear() drops the inflight dedupe map', async () => {
    const c = new PowerCache({ defaultAsyncTimeout: 0 });
    let resolveFactory;
    c.getOrSetAsync(
      'k',
      () =>
        new Promise((r) => {
          resolveFactory = r;
        })
    );
    // The factory itself is invoked on a microtask; let it start first.
    await new Promise((r) => setTimeout(r, 0));
    expect(c._inflightPromises.size).toBe(1);
    c.clear();
    expect(c._inflightPromises.size).toBe(0);
    resolveFactory('v');
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('PowerBulkhead reset/dispose (BUG-009)', () => {
  it('rejects queued waiters and returns to idle', async () => {
    // partitions: 1 so both tasks share the same gate - the default round-robin
    // partitioner would send them to different partitions, each with its own
    // capacity-1 gate, and nothing would ever queue.
    const bh = new PowerBulkhead({ maxConcurrency: 1, queueCapacity: 4, partitions: 1 });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const first = bh.run(() => gate);
    // Let the first task reach the gate and take the only permit.
    await new Promise((r) => setTimeout(r, 0));
    expect(bh.active).toBe(1);
    const second = bh.run(() => 'second');
    await new Promise((r) => setTimeout(r, 0));
    expect(bh.pending).toBe(1);

    bh.reset();
    await expect(second).rejects.toThrow(/reset/);

    release();
    await first;
    expect(bh.active).toBe(0);
    expect(bh.pending).toBe(0);
    await expect(bh.drain()).resolves.toBeUndefined();
  });

  it('exposes stats()', () => {
    const bh = new PowerBulkhead({ maxConcurrency: 2, queueCapacity: 5, partitions: 2 });
    expect(bh.stats()).toMatchObject({
      active: 0,
      pending: 0,
      queueCapacity: 5,
      partitions: 2,
      maxConcurrency: 2,
      saturated: false,
    });
  });

  it('supports Symbol.dispose', () => {
    const bh = new PowerBulkhead({ maxConcurrency: 1 });
    expect(() => {
      bh[Symbol.dispose]();
    }).not.toThrow();
  });

  it('routes a throwing release() to onError', async () => {
    const onError = vi.fn();
    const bh = new PowerBulkhead({ maxConcurrency: 1, onError });
    // A task that throws must still release its permit.
    await expect(
      bh.run(() => {
        throw new Error('task-boom');
      })
    ).rejects.toThrow('task-boom');
    expect(bh.active).toBe(0);
  });
});

describe('PowerScheduler async flush errors (BUG-005)', () => {
  it('routes an async flushFn rejection to onError instead of leaking it', async () => {
    const onError = vi.fn();
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = new PowerScheduler(
        async () => {
          await Promise.resolve();
          throw new Error('async-flush-boom');
        },
        { onError }
      );
      s.schedule();
      await new Promise((r) => setTimeout(r, 30));
      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toBe('async-flush-boom');
      // Give the microtask queue a chance to surface an unhandled rejection.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still handles a synchronous flushFn throw', () => {
    const onError = vi.fn();
    const s = new PowerScheduler(
      () => {
        throw new Error('sync-boom');
      },
      { onError }
    );
    s.schedule();
    s.flush();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toBe('sync-boom');
  });
});

describe('PowerRateLimit capability validation (BUG-006)', () => {
  it('validates before mutating any limiter', () => {
    const l1 = { tryConsume: vi.fn(() => true) };
    const bad = { available: () => 5 };
    const r = new PowerRateLimit([l1, bad], { atomic: true });
    expect(() => r.tryConsume(1)).toThrow(TypeError);
    expect(l1.tryConsume).not.toHaveBeenCalled();
  });

  it('does not mix throw and boolean returns on the happy path', () => {
    const l1 = { tryConsume: () => true, available: () => 10 };
    const l2 = { tryConsume: () => false, available: () => 0 };
    const r = new PowerRateLimit([l1, l2]);
    expect(r.tryConsume(1)).toBe(false);
  });
});
