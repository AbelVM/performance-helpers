import { it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

it('handles rapid resize operations without losing tasks', async () => {
  class EchoUnderlying {
    constructor() {
      this.onmessage = null;
      this.postMessage = (msg) => {
        // echo immediately on next tick
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: { ok: true, req: msg } });
        }, 1);
      };
      this.terminate = () => {};
    }
  }

  const pool = new PowerPool(EchoUnderlying, {
    size: 2,
    minSize: 0,
    maxSize: 4,
    maxTasksPerWorker: 2,
    taskQueue: true,
    lazy: false,
    idleTimeout: 1000,
  });

  let processed = 0;
  pool.onmessage = () => processed++;

  try {
    // rapidly resize the pool many times
    for (let i = 0; i < 50; i++) {
      const newMax = Math.floor(Math.random() * 5); // 0..4
      pool.resize(newMax);
    }

    // ensure pool can accept work after resizing turbulence
    pool.resize(2);
    // There was a 20 ms "settle time for workers to be created" here, and it
    // was waiting for something that does not happen: `resize()` sets the
    // bounds, and workers are created on demand, so immediately after a resize
    // the pool has exactly as many as it had before. Converting the sleep to
    // `vi.waitFor` on the worker count made that visible immediately, which is
    // the whole argument for converting rather than deleting sleeps by hand.
    // The next assertion is the real condition, and it is waited on below.

    // dispatch some messages
    const total = 40;
    for (let i = 0; i < total; i++) pool.postMessage({ i });

    // Was a 1000 ms grace period. `processed` may include extra internal
    // control messages, hence `>=`; the wait is for it to arrive, not to pass.
    await vi.waitFor(() => {
      expect(processed).toBeGreaterThanOrEqual(total);
    });
  } finally {
    pool.terminate();
  }
});
