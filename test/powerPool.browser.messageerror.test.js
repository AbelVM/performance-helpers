import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('PowerPool browser-style addEventListener messageerror forwarding', () => {
  it('emits messageerror when decoding fails via addEventListener path', async () => {
    class BrowserStyleUnderlying {
      constructor() {
        this._listeners = Object.create(null);
        this.postMessage = vi.fn((msg) => {});
        this.terminate = vi.fn();
      }
      addEventListener(ev, cb) {
        this._listeners[ev] = cb;
      }
      removeEventListener(ev, cb) {
        if (this._listeners[ev] === cb) delete this._listeners[ev];
      }
      // test helper to fire events
      _emit(ev, arg) {
        const cb = this._listeners[ev];
        if (typeof cb === 'function') cb(arg);
      }
    }

    const pool = new PowerPool(BrowserStyleUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const spy = vi.fn();
      pool.addEventListener('messageerror', spy);

      const underlying =
        pool.workers[0]._underlying ||
        (pool.workers[0].worker && pool.workers[0].worker._underlying);

      const invalid = new Uint8Array([9, 9, 9]);

      if (underlying && typeof underlying._emit === 'function') {
        underlying._emit('message', { data: invalid });
      }

      expect(spy).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });
});
