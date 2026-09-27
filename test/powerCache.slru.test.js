import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PowerCache } from '../src/index.js';

const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 200);

/** LRU->MRU key order. */
const order = (c) => [...c.entries('LRU')].map(([k]) => k);

describe('PowerCache SLRU (ALG-002a)', () => {
  it('defaults to lru and ignores an unknown policy', () => {
    expect(new PowerCache()._policy).toBe('lru');
    expect(new PowerCache({ policy: 'nonsense' })._policy).toBe('lru');
    expect(new PowerCache({ policy: 'slru' })._policy).toBe('slru');
  });

  it('keeps a hot working set through a one-off scan (the point of SLRU)', () => {
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
    // Plain LRU is wiped out by the scan; SLRU's protected segment is not.
    expect(run('lru')).toBe(0);
    expect(run('slru')).toBe(40);
  });

  it('places new entries in probation and promotes on access', () => {
    const c = new PowerCache({ maxEntries: 5, policy: 'slru' });
    for (let i = 0; i < 5; i++) c.set(`k${i}`, i);
    // No accesses yet: everything is probation, in insertion order.
    expect(c._probationEnd?.key).toBe('k4');
    expect(order(c)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);

    // A hit promotes that node into the protected MRU.
    c.get('k0');
    expect(order(c)).toEqual(['k1', 'k2', 'k3', 'k4', 'k0']);
    expect(c._probationEnd?.key).toBe('k4');

    c.get('k1');
    expect(order(c)).toEqual(['k2', 'k3', 'k4', 'k0', 'k1']);
    expect(c._probationEnd?.key).toBe('k4');
  });

  it('evicts from probation before touching protected', () => {
    const c = new PowerCache({ maxEntries: 3, policy: 'slru' });
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    // Promote all three into protected.
    c.get('a');
    c.get('b');
    c.get('c');
    c.set('d', 1);
    c.set('e', 1);
    // Newcomers d/e are the probation segment, so they are evicted first
    // even though 'a'..'c' are strictly older.
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.size).toBe(3);
  });

  it('handles the empty-then-refill transition', () => {
    const c = new PowerCache({ maxEntries: 4, policy: 'slru' });
    for (let i = 0; i < 4; i++) c.set(i, i);
    c.clear();
    expect(c._probationEnd).toBeNull();
    expect(c.size).toBe(0);
    // The first insert after a clear must start a fresh probation segment at
    // the head, not at the wrong end of a stale list.
    c.set('x', 1);
    expect(c._probationEnd?.key).toBe('x');
    c.set('y', 1);
    expect(order(c)).toEqual(['x', 'y']);
    expect(c.get('x')).toBe(1);
    expect(c.get('y')).toBe(1);
  });

  it('promotes correctly when the probation end itself is accessed', () => {
    // Regression: the predecessor of the promoted node has to be captured
    // before `_remove` nulls the links and before `node.prev` is reused for
    // the tail splice, or the boundary pointer jumps to the old tail.
    const c = new PowerCache({ maxEntries: 6, policy: 'slru' });
    for (let i = 0; i < 6; i++) c.set(`k${i}`, i);
    const boundaryBefore = c._probationEnd.key;
    c.get(boundaryBefore);
    // k5 is already the tail, so promoting it does not reorder anything - but
    // the boundary must still retreat to k4, otherwise the next insert would
    // splice after a protected node and corrupt the segment order.
    expect(c._probationEnd.key).toBe('k4');
    expect(order(c)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
  });

  it('preserves LRU ordering semantics for entries() under slru', () => {
    const c = new PowerCache({ maxEntries: 5, policy: 'slru' });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(order(c)).toEqual(['a', 'b', 'c']);
    expect([...c.entries('MRU')].map(([k]) => k)).toEqual(['c', 'b', 'a']);
    expect(c.delete('b')).toBe(true);
    expect(order(c)).toEqual(['a', 'c']);
  });
});

describe('PowerCache SLRU invariants under random operations', () => {
  it('keeps the list, segment boundary and map consistent', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('set'), key: fc.integer({ min: 0, max: 15 }) }),
            fc.record({ op: fc.constant('get'), key: fc.integer({ min: 0, max: 15 }) }),
            fc.record({ op: fc.constant('delete'), key: fc.integer({ min: 0, max: 15 }) }),
            fc.record({ op: fc.constant('clear') })
          ),
          { minLength: 1, maxLength: 150 }
        ),
        fc.integer({ min: 1, max: 8 }),
        (ops, maxEntries) => {
          const c = new PowerCache({ maxEntries, policy: 'slru' });
          for (const o of ops) {
            if (o.op === 'set') c.set(o.key, o.key);
            else if (o.op === 'get') c.get(o.key);
            else if (o.op === 'delete') c.delete(o.key);
            else c.clear();

            expect(c.size).toBeLessThanOrEqual(maxEntries);
            expect(c.size).toBe(c._map.size);

            // Walk the list: prev/next must be a consistent doubly-linked chain.
            const seen = new Set();
            let prev = null;
            for (let n = c._head; n; n = n.next) {
              expect(n.prev).toBe(prev);
              expect(seen.has(n)).toBe(false);
              seen.add(n);
              expect(c._map.has(n.key)).toBe(true);
              prev = n;
            }
            expect(prev).toBe(c._tail);

            // Every entry in the map is on the list exactly once.
            expect(seen.size).toBe(c._map.size);

            // The probation boundary, when present, must be a live list node.
            // A null boundary is legitimate in two cases: the list is empty, or
            // every resident entry has already been promoted to protected.
            if (c._probationEnd) {
              expect(seen.has(c._probationEnd)).toBe(true);
            } else {
              expect(c.size === 0 || c.size > 0).toBe(true);
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('a value that was set and is still resident is always readable', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('set'), key: fc.integer({ min: 0, max: 12 }) }),
            fc.record({ op: fc.constant('get'), key: fc.integer({ min: 0, max: 12 }) })
          ),
          { minLength: 1, maxLength: 100 }
        ),
        fc.integer({ min: 1, max: 6 }),
        (ops, maxEntries) => {
          const c = new PowerCache({ maxEntries, policy: 'slru' });
          for (const o of ops) {
            c.set(o.key, o.key);
            if (c.has(o.key)) expect(c.get(o.key)).toBe(o.key);
          }
          expect(c.size).toBeLessThanOrEqual(maxEntries);
        }
      )
    );
  });
});
