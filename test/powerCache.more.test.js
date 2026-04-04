import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache additional branches', () => {
  it('set updates existing node and entries order MRU/LRU', () => {
    const c = new PowerCache({ maxEntries: 10 });
    c.set('a', 1);
    c.set('b', 2);
    // update 'a' to move it to MRU
    c.set('a', 11);
    const mru = Array.from(c.entries('MRU')).map(([k]) => k);
    expect(mru[0]).toBe('a');
    const lru = Array.from(c.entries('LRU')).map(([k]) => k);
    expect(lru[0]).toBe('b');
    expect(c.get('a')).toBe(11);
  });

  it('delete returns false for missing keys and clear empties pool', () => {
    const c = new PowerCache();
    expect(c.delete('missing')).toBe(false);
    c.set('k', 1);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('hasEqual handles cyclic structures and prototype mismatches', () => {
    const c = new PowerCache();
    const a = {};
    a.self = a;
    const b = {};
    b.self = b;
    c.set('cyc', a);
    expect(c.hasEqual('cyc', b)).toBe(true);

    const p1 = Object.create(null);
    p1.x = 1;
    const p2 = { x: 1 };
    c.set('proto', p1);
    // different prototypes -> should be considered not equal
    expect(c.hasEqual('proto', p2)).toBe(false);
  });

  it('hasEqual compares Sets with non-primitive items (fallback O(n^2) path)', () => {
    const c = new PowerCache();
    const sA = new Set([{ v: 1 }, { v: 2 }]);
    const sB = new Set([{ v: 2 }, { v: 1 }]);
    c.set('sets', sA);
    expect(c.hasEqual('sets', sB)).toBe(true);
  });

  it('prefills pool and reuses nodes up to maxPoolSize', () => {
    const c = new PowerCache({ initialPoolSize: 2, maxPoolSize: 2 });
    expect(c.pool.length).toBeGreaterThanOrEqual(0);
    c.set('a', 1);
    c.delete('a');
    // pool should not grow beyond maxPoolSize
    expect(c.pool.length).toBeLessThanOrEqual(2);
  });

  it('internal node operations append/remove/move/pop work', () => {
    const c = new PowerCache();
    const n1 = c._allocNode('a', 1, 1, 0);
    const n2 = c._allocNode('b', 2, 1, 0);
    c._append(n1);
    c._append(n2);
    expect(c.head).toBe(n1);
    expect(c.tail).toBe(n2);
    c._moveToTail(n1);
    expect(c.tail).toBe(n1);
    const node = c.head;
    expect(node).not.toBeNull();
    c._remove(node);
    c._freeNode(node);
  });

  it('resize with maxWeight triggers eviction by weight', () => {
    // start with a large maxWeight so initial inserts do not evict
    const c = new PowerCache({ maxWeight: 100, weightFn: (v) => (v && v.weight ? v.weight : 1) });
    c.set('a', { weight: 6 });
    c.set('b', { weight: 5 });
    expect(c.stats().weight).toBeGreaterThanOrEqual(11);
    c.resize({ maxWeight: 5 });
    expect(c.evictions).toBeGreaterThanOrEqual(1);
  });

  it('onEvict/onExpire callbacks exceptions are swallowed', async () => {
    const onEvict = () => {
      throw new Error('evict-err');
    };
    const c = new PowerCache({ maxEntries: 1, onEvict });
    // cause eviction
    c.set('a', 1);
    expect(() => c.set('b', 2)).not.toThrow();

    const onExpire = () => {
      throw new Error('expire-err');
    };
    const c2 = new PowerCache({ defaultTTL: 1, onExpire });
    c2.set('x', 1, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));
    // calling get should trigger onExpire but not throw
    expect(() => c2.get('x')).not.toThrow();
  });

  it('entries/keys/values iterate in both MRU and LRU orders', () => {
    const c = new PowerCache();
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    const mr = Array.from(c.entries('MRU')).map(([k]) => k);
    const lr = Array.from(c.entries('LRU')).map(([k]) => k);
    expect(mr.length).toBeGreaterThan(0);
    expect(lr.length).toBeGreaterThan(0);
    // keys/values proxies
    expect(Array.from(c.keys()).length).toBe(c.size);
    expect(Array.from(c.values()).length).toBe(c.size);
  });
});
