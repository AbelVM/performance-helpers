import { describe, it, expect } from 'vitest';
import { PowerDefer } from '../src/helpers/powerDefer.js';

describe('PowerDefer', () => {
  it('starts pending and does not expose mutable resolver internals', () => {
    const d = new PowerDefer();
    expect(d.settled).toBe(false);
    expect(d.status).toBe('pending');
    expect(d.fulfilled).toBe(false);
    expect(d.rejected).toBe(false);
    expect('_resolve' in d).toBe(false);
    expect('_reject' in d).toBe(false);
  });

  it('resolves the promise with value', async () => {
    const d = new PowerDefer();
    setTimeout(() => d.resolve(42), 10);
    await expect(d.promise).resolves.toBe(42);
    expect(d.settled).toBe(true);
    expect(d.status).toBe('fulfilled');
    expect(d.fulfilled).toBe(true);
    expect(d.rejected).toBe(false);
  });

  it('rejects the promise with error', async () => {
    const d = new PowerDefer();
    setTimeout(() => d.reject(new Error('fail')), 10);
    await expect(d.promise).rejects.toThrow('fail');
    expect(d.settled).toBe(true);
    expect(d.status).toBe('rejected');
    expect(d.fulfilled).toBe(false);
    expect(d.rejected).toBe(true);
  });

  it('resolve is idempotent after settled', async () => {
    const d = new PowerDefer();
    d.resolve('ok');
    await expect(d.promise).resolves.toBe('ok');
    // subsequent calls do not throw
    d.resolve('ignored');
    d.reject(new Error('ignored'));
    expect(d.status).toBe('fulfilled');
  });

  it('reject is idempotent after settled', async () => {
    const d = new PowerDefer();
    const err = new Error('boom');
    d.reject(err);
    await expect(d.promise).rejects.toThrow('boom');
    d.reject(new Error('ignored'));
    d.resolve('ignored');
    expect(d.settled).toBe(true);
    expect(d.status).toBe('rejected');
  });
});
