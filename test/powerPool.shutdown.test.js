import { describe, it, expect } from 'vitest';
import { PowerPool, PowerPoolShutdownError } from '../src/helpers/powerPool.js';

describe('PowerPool.shutdown and reaper behavior', () => {
  it('shutdown clears the reaper interval', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    // ensure reaper was created
    expect(pool._reaperInterval).not.toBeNull();
    pool.shutdown();
    expect(pool._reaperInterval).toBeNull();
  });

  it('shutdown rejects pending awaitResponse Promises', async () => {
    class SilentUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {
          // intentionally do not respond
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(SilentUnderlying, { size: 1, idleTimeout: 1000 });
    const p = pool.postMessage({ foo: 'bar' }, undefined, { awaitResponse: true });
    // shutdown should reject the pending promise with a distinct error
    pool.shutdown();
    await expect(p).rejects.toBeInstanceOf(PowerPoolShutdownError);
  });
});
