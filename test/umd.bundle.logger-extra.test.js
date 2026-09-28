import { describe, it, expect } from 'vitest';
import { createBundleContext, evalInBundle } from './helpers/umdBundle.js';

describe('UMD bundle logger extra branches', () => {
  it('invokes counter APIs and handles odd inputs', () => {
    const { ctx } = createBundleContext();

    const ok = evalInBundle(
      ctx,
      `(function(){
      const logger = new lib.PowerLogger(2)
      logger.incrementCounter('k')
      const before = logger.getDebugCounters()
      logger.resetDebugCounters()
      const after = logger.getDebugCounters()
      // weird setDebugLevel input
      logger.setDebugLevel({ toString: () => { throw new Error('boom') } })
      return before && typeof after === 'object'
    })()`
    );

    expect(ok).toBe(true);
  });
});
