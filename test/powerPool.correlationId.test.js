import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool correlationId generator', () => {
  it('generates string correlationIds and they are unique for multiple concurrent requests', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 2, idleTimeout: 1000 });
    try {
      const N = 16;
      const promises = [];
      for (let i = 0; i < N; i++) {
        promises.push(pool.postMessage({ i }, null, { awaitResponse: true }));
      }
      const results = await Promise.all(promises);
      const ids = results.map((r) => r.correlationId);
      expect(ids.length).toBe(N);
      for (const id of ids) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
      const unique = new Set(ids);
      expect(unique.size).toBe(N);
    } finally {
      pool.terminate();
    }
  });

  it('coerces numeric explicit correlationId to string', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const resp = await pool.postMessage({ foo: 'bar' }, null, {
        correlationId: 12345,
        awaitResponse: true,
      });
      expect(resp.correlationId).toBe('12345');
    } finally {
      pool.terminate();
    }
  });
});
