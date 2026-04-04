import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool postMessage Promise API', () => {
  it('resolves a Promise when awaitResponse is requested (auto correlationId)', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          // echo back the message after a tick
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const p = pool.postMessage({ cmd: 'ping' }, null, { awaitResponse: true });
      expect(p).toHaveProperty('then'); // a Promise-like
      const resp = await p;
      expect(resp).toBeDefined();
      expect(resp.cmd).toBe('ping');
      expect(resp.correlationId).toBeDefined();
    } finally {
      pool.terminate();
    }
  });

  it('resolves a Promise when an explicit correlationId is provided', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          // echo back the message after a tick
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const id = 'my-cid-42';
      const p = pool.postMessage({ req: 1 }, null, { correlationId: id, awaitResponse: true });
      const resp = await p;
      expect(resp.req).toBe(1);
      expect(resp.correlationId).toBe(id);
    } finally {
      pool.terminate();
    }
  });

  it('rejects the Promise if underlying postMessage throws', async () => {
    class ThrowingUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn(() => {
          throw new Error('boom');
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(ThrowingUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      let threw = false;
      try {
        await pool.postMessage({ x: 1 }, null, { awaitResponse: true });
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(Error);
      }
      expect(threw).toBe(true);
    } finally {
      pool.terminate();
    }
  });
});
