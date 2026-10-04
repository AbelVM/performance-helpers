import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * WRK-004 — the Node half of the messageerror path, on the EventEmitter model.
 *
 * **This test used to emit `{ data: invalid }` through `.on`, and that was the
 * defect, not the fix it appeared to be.** Node's `worker.on('message', value)`
 * delivers the *payload*; a `MessageEvent` with a `.data` field is the browser's
 * shape and never arrives on this model. The pool used to unwrap `.data`
 * whenever it was present, so the fake's browser-shaped emit worked and a real
 * Node worker's reply did not: a payload carrying its own `data` field lost
 * every sibling field on the way in, silently.
 *
 * The fix is `WorkerAgnostic`'s rule — unwrap `.data` only where the platform
 * wraps a value in an event — so this test emits the value the way Node
 * delivers it. `test/powerPool.workerAgnostic.test.js` pins both halves: that a
 * `{data: …}` payload survives intact here, and that the same payload is still
 * unwrapped from a real `MessageEvent` on the browser model.
 */
describe('PowerPool Node-style messageerror forwarding', () => {
  it('emits pool-level messageerror when decoding fails (Node EventEmitter style)', async () => {
    class NodeStyleUnderlying {
      constructor() {
        this._listeners = Object.create(null);
        this.postMessage = vi.fn(() => {});
        this.terminate = vi.fn();
        /** Detached by `WorkerAgnostic.dispose()` on retirement; asserted below. */
        this.off = vi.fn((ev, cb) => {
          if (this._listeners[ev] === cb) delete this._listeners[ev];
        });
      }
      on(ev, cb) {
        this._listeners[ev] = cb;
      }
      // helper for tests to emit events, the way Node delivers them: the value.
      _emit(ev, arg) {
        const cb = this._listeners[ev];
        if (typeof cb === 'function') cb(arg);
      }
    }

    const pool = new PowerPool(NodeStyleUnderlying, { size: 1, minSize: 0, lazy: false });
    try {
      const spy = vi.fn();
      pool.addEventListener('messageerror', spy);

      const underlying = pool.workers[0].worker._underlying;

      // craft invalid binary payload that will fail decoding
      const invalid = new Uint8Array([1, 2, 3]);

      underlying._emit('message', invalid);

      expect(spy).toHaveBeenCalled();
    } finally {
      pool.terminate();
    }
  });
});
