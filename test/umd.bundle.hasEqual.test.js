import { describe, it, expect } from 'vitest';
import { createBundleContext, evalInBundle } from './helpers/umdBundle.js';

describe('UMD bundle deep-equality and logger edge branches', () => {
  it('PowerCache.hasEqual exercises many deep-equality branches', () => {
    const { ctx } = createBundleContext();

    // Run several hasEqual scenarios inside VM to exercise many branches
    const result = evalInBundle(
      ctx,
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const cache = new lib.PowerCache({ maxEntries: 20 })

      // TypedArray / ArrayBuffer
      const buf = new ArrayBuffer(8)
      const ua = new Uint8Array(buf)
      ua[0] = 1
      cache.set('ta', ua)
      const ok1 = cache.hasEqual('ta', new Uint8Array(buf))

      // Date
      const d = new Date(123456)
      cache.set('date', d)
      const ok2 = cache.hasEqual('date', new Date(123456))

      // RegExp
      const re = /abc/g
      cache.set('re', re)
      const ok3 = cache.hasEqual('re', /abc/g)

      // Map of nested objects
      const m = new Map(); m.set('x', { a: [1,2,3] })
      cache.set('map', m)
      const m2 = new Map(); m2.set('x', { a: [1,2,3] })
      const ok4 = cache.hasEqual('map', m2)

      // Set with object requiring O(n^2) fallback
      const s = new Set(); s.add({ k: 1 })
      cache.set('set', s)
      const s2 = new Set(); s2.add({ k: 1 })
      const ok5 = cache.hasEqual('set', s2)

      return { ok1, ok2, ok3, ok4, ok5 }
    })()`
    );

    expect(result.ok1).toBe(true);
    expect(result.ok2).toBe(true);
    expect(result.ok3).toBe(true);
    expect(result.ok4).toBe(true);
    expect(result.ok5).toBe(true);
  });

  it('PowerLogger handles missing console methods and lazy args safely', () => {
    // A deliberately incomplete sandbox: a console with most methods missing,
    // and no TextEncoder/TextDecoder. `createBundleContext` accepts overrides
    // so a bespoke environment is still expressed through the shared helper.
    const { ctx } = createBundleContext({
      sandbox: {
        console: { log: () => {}, warn: () => {} },
        TextEncoder: undefined,
        TextDecoder: undefined,
      },
    });

    const res = evalInBundle(
      ctx,
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const logger = new lib.PowerLogger(3)
      // these calls should not throw even if console.info/error are missing
      try { logger.info(() => 'a', () => { throw new Error('boom') }); } catch (e) { return false }
      try { logger.error('x', () => 'y'); } catch (e) { return false }
      return true
    })()`
    );

    expect(res).toBe(true);
  });
});
