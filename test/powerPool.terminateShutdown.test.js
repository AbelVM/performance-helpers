import { describe, it, expect } from 'vitest';
import { PowerPool, PowerPoolShutdownError } from '../src/helpers/powerPool.js';

describe('PowerPool.terminate delegates to shutdown', () => {
  it('terminate rejects pending Promises and clears the reaper', async () => {
    class SilentUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(SilentUnderlying, { size: 1, idleTimeout: 1000 });
    const p = pool.postMessage({ abc: 123 }, undefined, { awaitResponse: true });
    // call terminate (which delegates to shutdown)
    pool.terminate();
    await expect(p).rejects.toBeInstanceOf(PowerPoolShutdownError);
    expect(pool._reaperInterval).toBeNull();
    expect(pool.workers.length).toBe(0);
  });
});
