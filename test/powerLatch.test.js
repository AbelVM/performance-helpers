import { describe, it, expect } from 'vitest';
import { PowerLatch } from '../src/helpers/powerLatch.js';

describe('PowerLatch', () => {
  it('resolves wait when countDown called enough times', async () => {
    const latch = new PowerLatch(2);
    let done = false;
    const p = latch.wait().then(() => {
      done = true;
    });
    latch.countDown();
    expect(done).toBe(false);
    latch.countDown();
    await p;
    expect(done).toBe(true);
  });

  it('wait resolves immediately when count is zero', async () => {
    const latch = new PowerLatch(0);
    await expect(latch.wait()).resolves.toBeUndefined();
  });

  it('reset to zero resolves pending waiters', async () => {
    const latch = new PowerLatch(2);
    const p = latch.wait();
    latch.reset(0);
    await expect(p).resolves.toBeUndefined();
  });

  it('wait rejects on timeout', async () => {
    const latch = new PowerLatch(1);
    const p = latch.wait(10);
    // do not count down
    await expect(p).rejects.toHaveProperty('code', 'ETIMEOUT');
  });

  it('abort rejects pending waiters', async () => {
    const latch = new PowerLatch(1);
    const p = latch.wait();
    latch.abort(new Error('bye'));
    await expect(p).rejects.toThrow('bye');
  });

  it('static one factory works', async () => {
    const l = PowerLatch.one();
    expect(l.remaining).toBe(1);
    l.countDown();
    await expect(l.wait()).resolves.toBeUndefined();
  });

  it('decrementUnlessZero avoids negative', () => {
    const l = new PowerLatch(0);
    expect(l.decrementUnlessZero()).toBe(0);
    const l2 = new PowerLatch(2);
    expect(l2.decrementUnlessZero()).toBe(1);
  });
});
