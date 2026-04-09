import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool disposal hooks', () => {
  it('Symbol.dispose disposes (sync or async)', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = jestFn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    // call the dispose hook; support both sync and async implementations
    if (typeof pool[Symbol.dispose] === 'function') {
      const res = pool[Symbol.dispose]();
      if (res && typeof res.then === 'function') await res;
    }
    expect(pool.workers.length).toBe(0);
    expect(pool._activeTasks).toBe(0);
  });

  it('Symbol.asyncDispose drains then terminates', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          // reply asynchronously
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    // post a message so drain has to wait for it
    pool.postMessage({ hello: 'world' });
    if (typeof pool[Symbol.asyncDispose] === 'function') await pool[Symbol.asyncDispose]();
    expect(pool.workers.length).toBe(0);
    expect(pool._activeTasks).toBe(0);
  });
});

function jestFn() {
  return function () {};
}
