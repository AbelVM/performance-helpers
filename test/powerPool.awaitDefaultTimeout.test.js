import { it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

it('uses pool-level awaitResponse default timeout when per-call omitted', async () => {
  class SilentUnderlying {
    constructor() {
      this.onmessage = null;
      this.postMessage = () => {
        // never replies
      };
      this.terminate = () => {};
    }
  }

  const pool = new PowerPool(SilentUnderlying, {
    size: 1,
    taskQueue: false,
    awaitResponseTimeout: 20,
  });
  try {
    const p = pool.postMessage({ req: 'nope' }, undefined, { awaitResponse: true });
    await expect(p).rejects.toThrow(/postMessage response timeout/);
    // ensure pendingResponses cleaned up after timeout
    expect(pool._pendingResponses.size).toBe(0);
  } finally {
    pool.terminate();
  }
});

it('per-call timeout overrides pool default', async () => {
  class SilentUnderlying {
    constructor() {
      this.onmessage = null;
      this.postMessage = () => {
        // never replies
      };
      this.terminate = () => {};
    }
  }

  const pool = new PowerPool(SilentUnderlying, {
    size: 1,
    taskQueue: false,
    awaitResponseTimeout: 1000,
  });
  try {
    const p = pool.postMessage({ req: 'nope' }, undefined, { awaitResponse: true, timeout: 10 });
    await expect(p).rejects.toThrow(/postMessage response timeout/);
  } finally {
    pool.terminate();
  }
});
