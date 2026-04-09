import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool queue high-watermark', () => {
  it('emits pool:queue:high only when crossing threshold', async () => {
    class SlowUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 60);
        };
        this.terminate = () => {};
      }
      addEventListener(type, cb) {
        if (type === 'message') this.onmessage = cb;
      }
      removeEventListener() {}
    }

    const pool = new PowerPool(SlowUnderlying, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      taskQueue: true,
      queueHighThreshold: 0,
      lazy: false,
      idleTimeout: 1000,
    });

    try {
      let count = 0;
      pool._bus.on('pool:queue:high', () => {
        count++;
      });

      // first pair: second post should enqueue and cross threshold
      expect(pool.postMessage({ n: 1 })).toBe(true);
      expect(pool.postMessage({ n: 2 })).toBe(true);
      expect(count).toBe(1);

      // wait for both to be processed and queue to drain
      await new Promise((res) => setTimeout(res, 220));

      // second pair: crossing should be emitted again (flag reset after drain)
      expect(pool.postMessage({ n: 3 })).toBe(true);
      expect(pool.postMessage({ n: 4 })).toBe(true);
      expect(count).toBe(2);
    } finally {
      pool.terminate();
    }
  });
});
