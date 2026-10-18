import { describe, it, expect } from 'vitest';
import { PowerDefer } from '../src/helpers/powerDefer.js';
describe('cancel', () => {
  it('rejects promise and sets cancelled', async () => {
    const d = new PowerDefer();
    d.cancel('boom');
    expect(d.cancelled).toBe(true);
    expect(d.settled).toBe(true);
    await expect(d.promise).rejects.toThrow('boom');
  });
  it('no-op if settled', async () => {
    const d = new PowerDefer();
    d.resolve(42);
    d.cancel();
    expect(d.cancelled).toBe(false);
    expect(d.fulfilled).toBe(true);
    await expect(d.promise).resolves.toBe(42);
  });
});
