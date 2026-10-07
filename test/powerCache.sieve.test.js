import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/index.js';

describe('PowerCache SIEVE (ALG-001)', () => {
  it('accepts sieve policy and defaults to lru', () => {
    expect(new PowerCache()._policy).toBe('lru');
    expect(new PowerCache({ policy: 'sieve' })._policy).toBe('sieve');
  });

  it('maintains FIFO order on insert', () => {
    const c = new PowerCache({ maxEntries: 5, policy: 'sieve' });
    for (let i = 0; i < 5; i++) c.set(`k${i}`, i);
    // SIEVE is FIFO: head is oldest, tail is newest.
    expect(c.head.key).toBe('k0');
    expect(c.tail.key).toBe('k4');
  });

  it('does not move a node on hit, but sets visited', () => {
    const c = new PowerCache({ maxEntries: 3, policy: 'sieve' });
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    // FIFO order: a, b, c
    expect(c.head.key).toBe('a');
    expect(c.tail.key).toBe('c');

    // Hit 'a' - should not move, but should set visited.
    c.get('a');
    expect(c.head.key).toBe('a');
    expect(c.tail.key).toBe('c');
    expect(c._map.get('a').visited).toBe(true);
  });

  it('gives visited entries a second chance during eviction', () => {
    const c = new PowerCache({ maxEntries: 3, policy: 'sieve' });
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    // Visit 'a' so it gets a second chance.
    c.get('a');
    // Insert 'd' to trigger eviction.
    c.set('d', 1);
    // 'a' was visited, so it survives. 'b' is the oldest unvisited.
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(true);
  });

  it('advances the hand past every examined node', () => {
    const c = new PowerCache({ maxEntries: 3, policy: 'sieve' });
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    // Visit all three.
    c.get('a');
    c.get('b');
    c.get('c');
    // Insert 'd' to trigger eviction. All three are visited, so the hand
    // clears their bits and advances past all of them. The first unvisited
    // node encountered (d) is evicted.
    c.set('d', 1);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(false);
  });

  it('resets the hand on clear', () => {
    const c = new PowerCache({ maxEntries: 3, policy: 'sieve' });
    c.set('a', 1);
    c.set('b', 1);
    c.clear();
    expect(c._sieveHand).toBeNull();
    expect(c.size).toBe(0);
  });

  it('survives a scan workload better than LRU (characterisation)', () => {
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
    // SIEVE should retain more of the working set than plain LRU under scan.
    const lruHits = run('lru');
    const sieveHits = run('sieve');
    expect(sieveHits).toBeGreaterThan(lruHits);
  });
});
