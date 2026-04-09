import { describe, it, expect, vi } from 'vitest';
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

  it('wait rejects immediately when provided signal is already aborted', async () => {
    const l = new PowerLatch(1);
    const ac = new AbortController();
    ac.abort(new Error('already aborted'));

    await expect(l.wait({ signal: ac.signal, timeout: 30 })).rejects.toSatisfy((err) => {
      if (!err) return false;
      if (err && (err.code === 'EABORT' || /abort/i.test(String(err.message)))) return true;
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

  it('wait rejects immediately after abort with default abort error and reset restores normal waiting', async () => {
    const l = new PowerLatch(2);
    l.abort();

    await expect(l.wait()).rejects.toMatchObject({ code: 'EABORT' });

    l.reset(1);
    const waiter = l.wait();
    l.countDown();
    await expect(waiter).resolves.toBeUndefined();
  });

  it('removes abort listeners when a waiter resolves normally', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener,
      removeEventListener,
    };

    const l = new PowerLatch(1);
    const waiter = l.wait({ signal, timeout: 50 });
    l.countDown();
    await waiter;

    expect(addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('swallows errors from onAbort callbacks', () => {
    const l = new PowerLatch(1, {
      onAbort() {
        throw new Error('abort hook failed');
      },
    });

    expect(() => l.abort(new Error('stop'))).not.toThrow();
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
