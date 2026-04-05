import { describe, it, expect } from 'vitest';
import { PowerLatch } from '../src/helpers/powerLatch.js';

describe('PowerLatch branches extra', () => {
  it('decrementUnlessZero returns 0 when already zero', () => {
    const l = new PowerLatch(0);
    expect(l.decrementUnlessZero()).toBe(0);
  });

  it('countDown with zero returns without changing', () => {
    const l = new PowerLatch(2);
    expect(l.countDown(0)).toBe(2);
  });

  it('wait with timeout rejects with ETIMEOUT', async () => {
    const l = new PowerLatch(1);
    await expect(l.wait(5)).rejects.toHaveProperty('code', 'ETIMEOUT');
  });

  it('abort rejects waiters and calls onAbort', async () => {
    const onAbort = jestFn();
    const l = new PowerLatch(1, { onAbort });
    const p = l.wait();
    l.abort(new Error('fail'));
    await expect(p).rejects.toBeTruthy();
    expect(onAbort.called).toBe(true);
  });

  it('wait with signal rejects when signal aborted', async () => {
    const l = new PowerLatch(1);
    const ac = new AbortController();
    const p = l.wait({ signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toSatisfy((err) => {
      if (!err) return false;
      if (err && err.code === 'EABORT') return true;
      if (err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))) return true;
      return false;
    });
  });

  it('reset clears aborted state and resolves when count set to zero', async () => {
    const l = new PowerLatch(1);
    const p = l.wait();
    l.abort(new Error('x'));
    await expect(p).rejects.toBeTruthy();
    // reset to zero should resolve new waiters
    l.reset(0);
    await expect(l.wait()).resolves.toBeUndefined();
  });
});

// small helper to simulate jest-like spy without adding deps
function jestFn() {
  const fn = function (reason) {
    fn.called = true;
    fn.last = reason;
  };
  fn.called = false;
  fn.last = undefined;
  return fn;
}
