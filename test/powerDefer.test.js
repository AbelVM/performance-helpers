import { describe, it, expect } from 'vitest';
import { PowerDefer } from '../src/helpers/powerDefer.js';

describe('PowerDefer', () => {
  it('resolves the promise with value', async () => {
    const d = new PowerDefer();
    setTimeout(() => d.resolve(42), 10);
    await expect(d.promise).resolves.toBe(42);
    expect(d.settled).toBe(true);
  });

  it('rejects the promise with error', async () => {
    const d = new PowerDefer();
    setTimeout(() => d.reject(new Error('fail')), 10);
    await expect(d.promise).rejects.toThrow('fail');
    expect(d.settled).toBe(true);
  });

  it('resolve is idempotent after settled', async () => {
    const d = new PowerDefer();
    d.resolve('ok');
    await expect(d.promise).resolves.toBe('ok');
    // subsequent calls do not throw
    d.resolve('ignored');
    d.reject(new Error('ignored'));
  });
});
