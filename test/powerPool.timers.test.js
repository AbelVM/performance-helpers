import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

// Minimal fake worker that supports addEventListener/postMessage/terminate
class FakeWorker {
  constructor() {
    this._handlers = {};
  }
  addEventListener(name, cb) {
    this._handlers[name] = cb;
  }
  removeEventListener(name) {
    delete this._handlers[name];
  }
  postMessage(msg, transfer) {
    // echo back a simple response asynchronously
    setTimeout(() => {
      const h = this._handlers['message'];
      if (h) h({ data: msg });
    }, 0);
  }
  terminate() {}
}

describe('PowerPool timers and id stability', () => {
  it('clears reaper and autoscale intervals on stopThePress(recreate=false)', () => {
    const p = new PowerPool(FakeWorker, {
      lazy: false,
      minSize: 1,
      size: 1,
      autoScale: { intervalMs: 100, targetMs: 10 },
    });
    // initially intervals exist (reaper always, autoscale created)
    expect(p._reaperInterval).toBeTruthy();
    expect(p._autoScaleInterval).toBeTruthy();

    // stop and request no recreation -> intervals should be cleared
    p.stopThePress({ msg: 'x' }, undefined, { recreateWorkers: false });
    expect(p._reaperInterval).toBeNull();
    expect(p._autoScaleInterval).toBeNull();
  });

  it('generates monotonic worker ids across remove/add cycles', () => {
    const p = new PowerPool(FakeWorker, { lazy: false, minSize: 1, size: 1 });
    const beforeIds = p.workers.map((w) => w.id);
    // add and remove
    const added = p.addWorker();
    const addedId = added.id;
    p.removeWorker();
    const newWorker = p.addWorker();
    // new id should not equal the previous added id (monotonic allocator)
    expect(newWorker.id).not.toBe(addedId);
    // ensure internal _nextWorkerId progressed beyond last seen id
    expect(p._nextWorkerId).toBeGreaterThanOrEqual(newWorker.id + 1);
  });
});
