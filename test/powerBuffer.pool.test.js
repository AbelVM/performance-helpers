import { describe, it, expect } from 'vitest';
import { PowerBufferPool } from '../src/helpers/powerBuffer.js';

describe('PowerBufferPool', () => {
  it('acquires a buffer of at least the requested size', () => {
    const pool = new PowerBufferPool();
    const b = pool.acquire(100);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(b.byteLength).toBeGreaterThanOrEqual(100);
    pool.dispose();
  });

  it('reuses a released buffer of a matching bucket', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 4 });
    const a = pool.acquire(100);
    const id = a;
    pool.release(a);
    const b = pool.acquire(100);
    expect(b).toBe(id);
    pool.dispose();
  });

  it('zeroes a reused buffer', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 4 });
    const a = pool.acquire(100);
    a[0] = 42;
    pool.release(a);
    const b = pool.acquire(100);
    expect(b[0]).toBe(0);
    pool.dispose();
  });

  it('drops buffers whose size is not a bucket', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 4 });
    const a = new Uint8Array(128);
    expect(pool.release(a)).toBe(false);
    expect(pool.pooled).toBe(0);
    pool.dispose();
  });

  it('respects maxPerBucket', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 1 });
    const a = pool.acquire(100);
    const c = pool.acquire(100);
    pool.release(a);
    pool.release(c);
    expect(pool.pooled).toBe(1);
    pool.dispose();
  });

  it('respects maxTotal', () => {
    const pool = new PowerBufferPool({ buckets: [256, 512], maxPerBucket: 10, maxTotal: 1 });
    const a = pool.acquire(100);
    const c = pool.acquire(300);
    pool.release(a);
    pool.release(c);
    expect(pool.pooled).toBe(1);
    pool.dispose();
  });

  it('allocates fresh for oversized requests', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 4 });
    const b = pool.acquire(1000);
    expect(b.byteLength).toBe(1000);
    expect(pool.release(b)).toBe(false);
    pool.dispose();
  });

  it('handles size 0', () => {
    const pool = new PowerBufferPool();
    const b = pool.acquire(0);
    expect(b).toBeInstanceOf(Uint8Array);
    pool.dispose();
  });

  it('throws on disposed acquire', () => {
    const pool = new PowerBufferPool();
    pool.dispose();
    expect(() => pool.acquire(10)).toThrow();
  });

  it('release returns false when disposed', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 4 });
    const a = pool.acquire(100);
    pool.dispose();
    expect(pool.release(a)).toBe(false);
  });

  it('stats() reports reuse rate', () => {
    const pool = new PowerBufferPool({ buckets: [256], maxPerBucket: 4 });
    const a = pool.acquire(100);
    pool.release(a);
    pool.acquire(100);
    const s = pool.stats();
    expect(s.acquires).toBe(2);
    expect(s.reuses).toBe(1);
    expect(s.reuseRate).toBe(0.5);
    pool.dispose();
  });

  it('works with explicit dispose', () => {
    const pool = new PowerBufferPool();
    try {
      const b = pool.acquire(10);
      expect(b).toBeInstanceOf(Uint8Array);
    } finally {
      pool[Symbol.dispose]();
    }
    // no throw
  });

  it('rejects unknown options', () => {
    expect(() => new PowerBufferPool({ foo: 1 })).toThrow();
  });
});
