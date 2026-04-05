import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool auto-transfer behavior', () => {
  it('postMessage without transfer encodes object and passes ArrayBuffer in transfer list', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn((msg) => {
          // echo back after a tick to simulate worker reply
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 0);
        });
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const sent = { hello: 'x'.repeat(2000) };
      const p = new Promise((resolve) => {
        pool.onmessage = (e) => resolve(e.data);
      });

      const ok = pool.postMessage(sent);
      expect(ok).toBe(true);

      // wait for reply
      const decoded = await p;
      expect(decoded).toEqual(sent);

      const underlying = pool.workers[0].worker._underlying || pool.workers[0]._underlying;
      expect(underlying).toBeTruthy();
      const call = underlying.postMessage.mock.calls[0];
      expect(call).toBeTruthy();
      const [argMsg, argTransfer] = call;
      // message should be a Uint8Array and transfer should include its buffer
      expect(argMsg).toBeInstanceOf(Uint8Array);
      expect(Array.isArray(argTransfer)).toBe(true);
      expect(argTransfer.length).toBeGreaterThanOrEqual(1);
      expect(argTransfer[0]).toBe(argMsg.buffer);
    } finally {
      pool.terminate();
    }
  });

  it('broadcast without transfer encodes per-worker and provides transferable buffers', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = vi.fn();
        this.terminate = vi.fn();
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 3, idleTimeout: 1000 });
    try {
      pool.broadcast({ ping: 'pong'.repeat(500) });
      for (const w of pool.workers) {
        const underlying = w.worker._underlying || w._underlying;
        expect(underlying).toBeTruthy();
        const call = underlying.postMessage.mock.calls[0];
        expect(call).toBeTruthy();
        const [argMsg, argTransfer] = call;
        expect(argMsg).toBeInstanceOf(Uint8Array);
        expect(Array.isArray(argTransfer)).toBe(true);
        expect(argTransfer[0]).toBe(argMsg.buffer);
      }
    } finally {
      pool.terminate();
    }
  });
});
