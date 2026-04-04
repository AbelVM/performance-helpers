import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache getOrSet APIs', () => {
  it('getOrSet stores and returns computed sync value', () => {
    const c = new PowerCache({ defaultTTL: 10000 });
    const res = c.getOrSet('a', () => {
      return 42;
    });
    expect(res).toBe(42);
    expect(c.get('a')).toBe(42);
    expect(c.size).toBeGreaterThanOrEqual(1);
    // subsequent calls should return cached value and not invoke factory
    const res2 = c.getOrSet('a', () => {
      throw new Error('should not call');
    });
    expect(res2).toBe(42);
    expect(c.hits).toBeGreaterThanOrEqual(1);
    expect(c.misses).toBeGreaterThanOrEqual(0);
  });

  it('getOrSetAsync deduplicates concurrent async factories', async () => {
    const c = new PowerCache({ defaultTTL: 10000 });
    const asyncFactory = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve('ok'), 20);
      });

    const p1 = c.getOrSetAsync('k', asyncFactory);
    const p2 = c.getOrSetAsync('k', asyncFactory);
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1).toBe('ok');
    expect(v2).toBe('ok');
    expect(c.get('k')).toBe('ok');
    expect(c.size).toBeGreaterThanOrEqual(1);
    expect(c._inflightPromises.has('k')).toBe(false);
    expect(c.hits + c.misses).toBeGreaterThanOrEqual(1);
    expect(c.misses).toBeGreaterThanOrEqual(1);
    expect(c._inflightPromises.size).toBe(0);
  });

  it('getOrSetAsync clears inflight on rejection and allows retry', async () => {
    const c = new PowerCache({ defaultTTL: 10000 });
    const badFactory = () => {
      return Promise.reject(new Error('boom'));
    };

    // concurrent callers should receive rejection
    const p1 = c.getOrSetAsync('x', badFactory).catch((e) => e);
    const p2 = c.getOrSetAsync('x', badFactory).catch((e) => e);
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBeInstanceOf(Error);
    expect(e2).toBeInstanceOf(Error);
    // ensure inflight cleared
    expect(c._inflightPromises.has('x')).toBe(false);

    // now succeed with a good factory
    const okFactory = () => Promise.resolve('now');
    const v = await c.getOrSetAsync('x', okFactory);
    expect(v).toBe('now');
    expect(c.get('x')).toBe('now');
  });
});
