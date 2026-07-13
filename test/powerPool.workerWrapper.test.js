import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * Regression tests for the `WorkerWrapper.postMessage` buffer-detach fix.
 *
 * `_encodeForTransfer` caches the encoded `Uint8Array` for identical plain
 * objects. Transferring that cached buffer would detach (neuter) it, so a
 * later identical message would encode into a zero-length (detached) buffer.
 * The fix slices the encoded bytes before transferring.
 */
describe('WorkerWrapper.postMessage buffer safety', () => {
  it('does not detach the cached encode buffer when transferring a plain object', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.calls = [];
        this.postMessage = (msg, transfer) => {
          this.calls.push({ msg, transfer });
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    const underlying = pool.workers[0].worker._underlying;
    const wrapper = pool.workers[0].worker;

    const message = { hello: 'world', n: 42 };
    // Post the same message three times; the encode cache returns the same
    // Uint8Array each time, so the transfer must never detach it.
    wrapper.postMessage(message);
    wrapper.postMessage(message);
    wrapper.postMessage(message);

    expect(underlying.calls.length).toBe(3);

    for (const call of underlying.calls) {
      // Each transferred buffer must be a live (non-detached) ArrayBuffer.
      expect(call.transfer).toBeDefined();
      expect(call.transfer[0].byteLength).toBeGreaterThan(0);
    }

    // The two transfers must be distinct buffers (we slice before transferring),
    // proving we never hand the cached buffer to the underlying worker.
    const [first, second] = underlying.calls;
    expect(second.transfer[0]).not.toBe(first.transfer[0]);
  });

  it('keeps the cached encode buffer reusable after a transfer', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.calls = [];
        this.postMessage = (msg, transfer) => {
          this.calls.push({ msg, transfer });
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    const underlying = pool.workers[0].worker._underlying;
    const wrapper = pool.workers[0].worker;

    const message = { repeated: true };
    wrapper.postMessage(message);
    // The cached buffer must still encode to a valid, transferable buffer.
    wrapper.postMessage(message);

    expect(underlying.calls[1].transfer[0].byteLength).toBeGreaterThan(0);
  });
});
