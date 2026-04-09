import { it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

it('getOrSetAsync rejects on default timeout and clears inflight map', async () => {
  const c = new PowerCache({ defaultAsyncTimeout: 20 });
  const hang = () => new Promise(() => {});

  const p = c.getOrSetAsync('t1', hang);
  await expect(p).rejects.toThrow(/getOrSetAsync timeout/);
  // ensure inflight bookkeeping cleared after timeout
  expect(c._inflightPromises.has('t1')).toBe(false);

  // subsequent successful factory should work after timeout
  const v = await c.getOrSetAsync('t1', () => Promise.resolve('ok'));
  expect(v).toBe('ok');
});

it('getOrSetAsync respects per-call timeout override', async () => {
  const c = new PowerCache({ defaultAsyncTimeout: 1000 });
  const hang = () => new Promise(() => {});

  const p = c.getOrSetAsync('t2', hang, { timeout: 10 });
  await expect(p).rejects.toThrow(/getOrSetAsync timeout/);
  expect(c._inflightPromises.has('t2')).toBe(false);
});
