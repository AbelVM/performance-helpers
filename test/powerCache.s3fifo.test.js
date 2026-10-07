import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

describe('PowerCache S3-FIFO (ALG-002)', () => {
  it('accepts s3fifo policy and defaults to lru', () => {
    expect(new PowerCache()._policy).toBe('lru');
    expect(new PowerCache({ policy: 's3fifo' })._policy).toBe('s3fifo');
  });

  it('places new entries in Small', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1);
    expect(c._smallMap.has('a')).toBe(true);
    expect(c._map.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(false);
    expect(c.size).toBe(1);
  });

  it('promotes Small hits to Main', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1);
    expect(c._smallMap.has('a')).toBe(true);
    c.get('a');
    expect(c._map.has('a')).toBe(true);
    expect(c._smallMap.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(false);
  });

  it('admits Ghost hits directly to Main', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Insert 'a' and promote to Main.
    c.set('a', 1);
    c.get('a');
    expect(c._map.has('a')).toBe(true);
    // Overfill Main to evict 'a' to Ghost.
    for (let i = 0; i < 10; i++) {
      c.set(`k${i}`, 1);
      c.get(`k${i}`);
    }
    expect(c._ghostMap.has('a')).toBe(true);
    // Now access 'a' - should be admitted to Main directly.
    c.get('a');
    expect(c._map.has('a')).toBe(true);
    expect(c._smallMap.has('a')).toBe(false);
    expect(c._ghostMap.has('a')).toBe(false);
  });

  it('evicts Small to Ghost when Small is full', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Small max size is 10% of 10 = 1.
    expect(c._smallMaxSize).toBe(1);
    c.set('a', 1);
    expect(c._smallSize).toBe(1);
    c.set('b', 1);
    // 'a' should have been evicted to Ghost.
    expect(c._smallSize).toBe(1);
    expect(c._ghostMap.has('a')).toBe(true);
    expect(c._smallMap.has('b')).toBe(true);
  });

  it('evicts Main to Ghost when Main is over capacity', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Fill Main to capacity by promoting from Small.
    for (let i = 0; i < 9; i++) {
      c.set(`k${i}`, 1);
      c.get(`k${i}`); // promote to Main
    }
    expect(c._map.size).toBe(9);
    // Insert a new key and promote it to Main, triggering eviction.
    c.set('extra', 1);
    c.get('extra');
    expect(c._map.size).toBe(9);
    expect(c._ghostMap.has('k0')).toBe(true);
    expect(c._map.has('extra')).toBe(true);
  });

  it('drops evicted entries when Ghost is full', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    // Ghost max size is 20% of 10 = 2.
    expect(c._ghostMaxSize).toBe(2);
    // Fill Ghost.
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    c.set('d', 1);
    // 'a' and 'b' should be in Ghost, 'c' and 'd' should have been dropped.
    expect(c._ghostSize).toBe(2);
    expect(c._ghostMap.has('a')).toBe(true);
    expect(c._ghostMap.has('b')).toBe(true);
  });

  it('handles delete for all three queues', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1); // Small
    c.get('a'); // Main
    c.set('b', 1); // Small
    // Evict 'b' to Ghost.
    c.set('c', 1);
    expect(c._ghostMap.has('b')).toBe(true);
    // Delete from each queue.
    expect(c.delete('a')).toBe(true);
    expect(c._map.has('a')).toBe(false);
    expect(c.delete('b')).toBe(true);
    expect(c._ghostMap.has('b')).toBe(false);
    expect(c.delete('missing')).toBe(false);
  });

  it('clears all queues', () => {
    const c = new PowerCache({ maxEntries: 10, policy: 's3fifo' });
    c.set('a', 1);
    c.get('a');
    c.set('b', 1);
    c.set('c', 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c._map.size).toBe(0);
    expect(c._smallMap.size).toBe(0);
    expect(c._ghostMap.size).toBe(0);
    expect(c._smallSize).toBe(0);
    expect(c._ghostSize).toBe(0);
  });

  it('retains hot entries under scan (characterisation)', () => {
    const run = (policy) => {
      const c = new PowerCache({ maxEntries: 100, policy });
      const hot = Array.from({ length: 40 }, (_, i) => `hot-${i}`);
      for (let round = 0; round < 5; round++) {
        for (const k of hot) {
          c.set(k, 1);
          c.get(k);
        }
      }
      for (let i = 0; i < 500; i++) c.set(`scan-${i}`, 1);
      return hot.filter((k) => c.has(k)).length;
    };
    const lruHits = run('lru');
    const s3fifoHits = run('s3fifo');
    expect(s3fifoHits).toBeGreaterThanOrEqual(lruHits);
  });
});
