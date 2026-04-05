import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

// Minimal worker factory used for tests
function StubWorker() {
  this.onmessage = null;
  this.onerror = null;
}
StubWorker.prototype.postMessage = function () {
  // no-op
};
StubWorker.prototype.addEventListener = function (type, cb) {
  if (type === 'message') this.onmessage = cb;
  if (type === 'error') this.onerror = cb;
};
StubWorker.prototype.removeEventListener = function (type, cb) {
  if (type === 'message' && this.onmessage === cb) this.onmessage = null;
  if (type === 'error' && this.onerror === cb) this.onerror = null;
};
StubWorker.prototype.terminate = function () {};

describe('PowerPool extra branches', () => {
  it('onidle setter swallows thrown handlers and logs error', () => {
    const pool = new PowerPool(StubWorker, { minSize: 1, lazy: false });
    // spy on logger
    pool._logger.error = vi.fn();
    pool.queue.clear();
    pool._activeTasks = 0;
    // setting a throwing onidle should not throw
    pool.onidle = () => {
      throw new Error('boom idle');
    };
    expect(pool._logger.error).toHaveBeenCalled();
    pool.terminate && pool.terminate();
  });

  it('removeEventListener returns early when cb is invalid', () => {
    const pool = new PowerPool(StubWorker, { minSize: 1, lazy: false });
    expect(() => pool.removeEventListener('message', null)).not.toThrow();
    pool.terminate && pool.terminate();
  });
});
