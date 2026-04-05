import { it, expect } from 'vitest';
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
    // small settle time for workers to be created
    await new Promise((r) => setTimeout(r, 20));

    // dispatch some messages
    const total = 40;
    for (let i = 0; i < total; i++) pool.postMessage({ i });

    // allow some time for processing
    await new Promise((r) => setTimeout(r, 1000));
    // allow for possible extra internal/control messages; ensure at least
    // the expected number of task responses were processed.
    expect(processed).toBeGreaterThanOrEqual(total);
  } finally {
    pool.terminate();
  }
});
