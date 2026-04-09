import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool Node-style messageerror forwarding', () => {
  it('emits pool-level messageerror when decoding fails (Node EventEmitter style)', async () => {
    class NodeStyleUnderlying {
      constructor() {
        this._listeners = Object.create(null);
        this.postMessage = vi.fn(() => {});
        this.terminate = vi.fn();
      }
      on(ev, cb) {
        this._listeners[ev] = cb;
      }
      // helper for tests to emit events
      _emit(ev, arg) {
        const cb = this._listeners[ev];
        if (typeof cb === 'function') cb(arg);
      }
    }

    const pool = new PowerPool(NodeStyleUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const spy = vi.fn();
      pool.addEventListener('messageerror', spy);

      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);

      // craft invalid binary payload that will fail decoding
      const invalid = new Uint8Array([1, 2, 3]);

      // emit using Node-style helper
      if (underlying && typeof underlying._emit === 'function') {
        underlying._emit('message', { data: invalid });
      } else if (underlying && typeof underlying.onmessage === 'function') {
        underlying.onmessage({ data: invalid });
      }

      expect(spy).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });
});
