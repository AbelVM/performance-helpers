import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool correlation id', () => {
  it('appends a monotonic counter to generated correlation ids', () => {
    class MockUnderlying {
      constructor() {
        this.postMessage = () => {};
        this.terminate = () => {};
      }
      addEventListener() {}
      removeEventListener() {}
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, minSize: 1, lazy: false });
    try {
      const id1 = pool._generateCorrelationId();
      const id2 = pool._generateCorrelationId();
      const s1 = String(id1).split('-').pop();
      const s2 = String(id2).split('-').pop();
      expect(Number(s2)).toBe(Number(s1) + 1);
    } finally {
      pool.terminate();
    }
  });
});
