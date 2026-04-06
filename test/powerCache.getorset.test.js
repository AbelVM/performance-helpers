import { describe, it, expect, vi } from 'vitest';
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

  it('getOrSet staleWhileRevalidate returns stale value and refreshes in background', async () => {
    const c = new PowerCache({ defaultTTL: 1 });
    c.set('a', 1, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));

    let resolveRefresh;
    const refreshFactory = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const stale = c.getOrSet('a', refreshFactory, {
      staleWhileRevalidate: true,
      ttl: 10000,
    });

    expect(stale).toBe(1);
    expect(c._inflightPromises.has('a')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshFactory).toHaveBeenCalledTimes(1);

    resolveRefresh(2);
    await c._inflightPromises.get('a');

    expect(c.get('a')).toBe(2);
  });

  it('getOrSetAsync staleWhileRevalidate returns stale value and refreshes in background', async () => {
    const c = new PowerCache({ defaultTTL: 1 });
    c.set('x', 'old', { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));

    const asyncFactory = vi.fn(() => Promise.resolve('fresh'));
    const result = await c.getOrSetAsync('x', asyncFactory, {
      staleWhileRevalidate: true,
      ttl: 10000,
    });

    expect(result).toBe('old');
    expect(asyncFactory).toHaveBeenCalledTimes(1);
    await c._inflightPromises.get('x');
    expect(c.get('x')).toBe('fresh');
  });
});
