import { describe, it, expect } from 'vitest';
import { createBundleContext, evalInBundle } from './helpers/umdBundle.js';

describe('UMD bundle PowerCache timer branches', () => {
  it('startCleanup accepts numeric interval and options object', () => {
    const { ctx, lib } = createBundleContext();
    expect(typeof lib.PowerCache).toBe('function');

    const res = evalInBundle(
      ctx,
      `(function(){
      const cache = new lib.PowerCache({ maxEntries: 5, defaultTTL: 10 })
      // numeric interval
      cache.startCleanup(1)
      cache.stopCleanup()
      // options object
      cache.startCleanup({ interval: 1, maxCleanupPerTick: 2 })
      cache.stopCleanup()
      return true
    })()`
    );
    expect(res).toBe(true);
  });
});
