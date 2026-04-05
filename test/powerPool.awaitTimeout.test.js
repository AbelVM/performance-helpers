import { it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

it('rejects awaitResponse promises when timeout elapses', async () => {
  class SilentUnderlying {
    constructor() {
      this.onmessage = null;
      this.postMessage = () => {
        // never replies
      };
      this.terminate = () => {};
    }
  }

  const pool = new PowerPool(SilentUnderlying, { size: 1, taskQueue: false });
  try {
    const p = pool.postMessage({ req: 'nope' }, undefined, { awaitResponse: true, timeout: 30 });
    await expect(p).rejects.toThrow(/postMessage response timeout/);
  } finally {
    pool.terminate();
  }
});
