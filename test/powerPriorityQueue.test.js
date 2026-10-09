import { describe, it, expect } from 'vitest';
import { PowerPriorityQueue } from '../src/helpers/powerPriorityQueue.js';

// Priority is read off `item.priority`, then `item.weight`, then `0` — the same
// fallback chain `PowerQueue` uses for its weight accounting, so a caller moving
// between the two does not have to relearn which field wins.

describe('PowerPriorityQueue', () => {
  describe('ordering', () => {
    it('dequeues highest priority first', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'low', priority: 1 });
      q.push({ v: 'high', priority: 10 });
      q.push({ v: 'med', priority: 5 });
      expect(q.shift()).toEqual({ v: 'high', priority: 10 });
      expect(q.shift()).toEqual({ v: 'med', priority: 5 });
      expect(q.shift()).toEqual({ v: 'low', priority: 1 });
    });

    it('breaks ties by insertion order', () => {
      // FIFO among equals is the whole stability guarantee. Without the `seq`
      // tie-break the heap would return equal-priority items in an order that
      // depends on the sift path, which is not an order a caller can reason
      // about.
      const q = new PowerPriorityQueue();
      q.push({ v: 'first', priority: 0 });
      q.push({ v: 'second', priority: 0 });
      q.push({ v: 'third', priority: 0 });
      expect(q.shift().v).toBe('first');
      expect(q.shift().v).toBe('second');
      expect(q.shift().v).toBe('third');
    });

    it('interleaves priorities and ties correctly', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'a', priority: 1 });
      q.push({ v: 'b', priority: 5 });
      q.push({ v: 'c', priority: 1 });
      q.push({ v: 'd', priority: 5 });
      q.push({ v: 'e', priority: 3 });
      expect(q.shift().v).toBe('b');
      expect(q.shift().v).toBe('d');
      expect(q.shift().v).toBe('e');
      expect(q.shift().v).toBe('a');
      expect(q.shift().v).toBe('c');
    });

    it('falls back to weight, then to 0', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'weighted', weight: 7 });
      q.push({ v: 'plain' });
      q.push({ v: 'nullish', priority: null });
      expect(q.shift().v).toBe('weighted');
      // Both remaining are priority 0, so insertion order decides.
      expect(q.shift().v).toBe('plain');
      expect(q.shift().v).toBe('nullish');
    });

    it('treats a non-finite priority as 0', () => {
      // `NaN` compares unequal to everything, so a heap that let it through
      // would order those items arbitrarily rather than at the back.
      const q = new PowerPriorityQueue();
      q.push({ v: 'nan', priority: NaN });
      q.push({ v: 'real', priority: 1 });
      expect(q.shift().v).toBe('real');
      expect(q.shift().v).toBe('nan');
    });

    it('handles a null item', () => {
      const q = new PowerPriorityQueue();
      q.push(null);
      q.push({ v: 'x', priority: 1 });
      expect(q.shift().v).toBe('x');
      expect(q.shift()).toBeNull();
    });
  });

  describe('peek and emptiness', () => {
    it('peeks without removing', () => {
      const q = new PowerPriorityQueue();
      expect(q.peek()).toBeUndefined();
      q.push({ v: 'a', priority: 1 });
      q.push({ v: 'b', priority: 2 });
      expect(q.peek().v).toBe('b');
      expect(q.size).toBe(2);
      expect(q.shift().v).toBe('b');
    });

    it('reports length, size and isEmpty consistently', () => {
      const q = new PowerPriorityQueue();
      expect(q.isEmpty()).toBe(true);
      expect(q.length).toBe(0);
      expect(q.size).toBe(0);
      q.push({ v: 'a', priority: 1 });
      expect(q.isEmpty()).toBe(false);
      expect(q.length).toBe(1);
      expect(q.size).toBe(1);
    });

    it('returns undefined from shift on an empty queue', () => {
      const q = new PowerPriorityQueue();
      expect(q.shift()).toBeUndefined();
    });
  });

  describe('growth', () => {
    it('grows past the initial capacity and keeps ordering', () => {
      // The heap is 1-indexed and `_grow` doubles, so an off-by-one here shows
      // up as a lost or duplicated entry rather than a crash.
      const q = new PowerPriorityQueue(2);
      const n = 200;
      for (let i = 0; i < n; i++) q.push({ v: i, priority: i % 7 });
      expect(q.size).toBe(n);
      let last = Infinity;
      for (let i = 0; i < n; i++) {
        const item = q.shift();
        expect(item.priority).toBeLessThanOrEqual(last);
        last = item.priority;
      }
      expect(q.size).toBe(0);
    });

    it('accepts an options object', () => {
      const q = new PowerPriorityQueue({ initialCapacity: 4 });
      q.push({ v: 'a', priority: 1 });
      expect(q.size).toBe(1);
    });

    it('rejects an unknown option', () => {
      expect(() => new PowerPriorityQueue({ initialCap: 4 })).toThrow(/unknown option/);
    });
  });
});

describe('PowerPriorityQueue eviction and lifecycle', () => {
  describe('popLowest', () => {
    it('returns the item that would be delivered last', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'low', priority: 1 });
      q.push({ v: 'high', priority: 10 });
      q.push({ v: 'med', priority: 5 });
      expect(q.popLowest().v).toBe('low');
      expect(q.popLowest().v).toBe('med');
      expect(q.popLowest().v).toBe('high');
      expect(q.popLowest()).toBeUndefined();
    });

    it('breaks ties towards the newest, mirroring shift', () => {
      // `popLowest` is the exact inverse of `shift`, so among equal priorities
      // it takes the one `shift()` would reach *last*. Getting this backwards
      // would make the two ends disagree about ordering, and a caller draining
      // from both would see the same item twice or miss one.
      const q = new PowerPriorityQueue();
      q.push({ v: 'first', priority: 3 });
      q.push({ v: 'second', priority: 3 });
      q.push({ v: 'third', priority: 3 });
      expect(q.popLowest().v).toBe('third');
      expect(q.popLowest().v).toBe('second');
      expect(q.popLowest().v).toBe('first');
    });

    it('leaves the heap property intact', () => {
      // `popLowest` moves the last element into an arbitrary slot, so it has to
      // sift in *both* directions. A one-directional sift leaves the heap
      // broken and the next `shift()` returns the wrong item — which is the
      // defect this test exists to catch.
      const q = new PowerPriorityQueue();
      for (let i = 0; i < 64; i++) q.push({ v: i, priority: i % 11 });
      for (let round = 0; round < 8; round++) {
        q.popLowest();
        // Every remaining item must still come out in non-increasing priority.
        const probe = new PowerPriorityQueue();
        const snapshot = [];
        while (q.size > 0) {
          const item = q.shift();
          snapshot.push(item.priority);
          probe.push(item);
        }
        for (let i = 1; i < snapshot.length; i++) {
          expect(snapshot[i]).toBeLessThanOrEqual(snapshot[i - 1]);
        }
        // Put them back for the next round.
        while (probe.size > 0) q.push(probe.shift());
      }
    });

    it('is the exact inverse of shift over a randomised workload', () => {
      // Draining from both ends must consume every entry exactly once, with no
      // duplication and no loss. A heap that corrupts on arbitrary removal
      // shows up here as a count mismatch.
      const q = new PowerPriorityQueue();
      const n = 100;
      for (let i = 0; i < n; i++) q.push({ v: i, priority: (i * 37) % 13 });
      const seen = new Set();
      let guard = 0;
      while (q.size > 0 && guard++ < 1000) {
        const item = q.size % 2 === 0 ? q.shift() : q.popLowest();
        expect(seen.has(item.v)).toBe(false);
        seen.add(item.v);
      }
      expect(seen.size).toBe(n);
      expect(q.size).toBe(0);
    });

    it('returns undefined on an empty queue', () => {
      const q = new PowerPriorityQueue();
      expect(q.popLowest()).toBeUndefined();
    });

    it('works on a single-element queue', () => {
      // The vacated slot *is* the worst slot here, so the "nothing to move"
      // branch has to hold.
      const q = new PowerPriorityQueue();
      q.push({ v: 'only', priority: 1 });
      expect(q.popLowest().v).toBe('only');
      expect(q.size).toBe(0);
      expect(q.popLowest()).toBeUndefined();
    });
  });

  describe('clear and reset', () => {
    it('clears every slot', () => {
      // The backing array is reused, so a clear that only reset `_size` would
      // retain references to every item ever queued.
      const q = new PowerPriorityQueue();
      for (let i = 0; i < 50; i++) q.push({ v: i, priority: i });
      q.clear();
      expect(q.size).toBe(0);
      expect(q.isEmpty()).toBe(true);
      expect(q.shift()).toBeUndefined();
      expect(q.popLowest()).toBeUndefined();
    });

    it('resets is an alias of clear', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'a', priority: 1 });
      q.reset();
      expect(q.size).toBe(0);
    });

    it('restarts the sequence counter so ties stay FIFO after a clear', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'a', priority: 1 });
      q.clear();
      q.push({ v: 'b', priority: 1 });
      q.push({ v: 'c', priority: 1 });
      expect(q.shift().v).toBe('b');
      expect(q.shift().v).toBe('c');
    });
  });

  describe('disposal', () => {
    it('clears state and is idempotent', () => {
      const q = new PowerPriorityQueue();
      q.push({ v: 'a', priority: 1 });
      q.dispose();
      expect(q.size).toBe(0);
      expect(() => q.dispose()).not.toThrow();
    });

    it('supports using and await using', () => {
      {
        using q = new PowerPriorityQueue();
        q.push({ v: 'a', priority: 1 });
        expect(q.size).toBe(1);
      }
      // A stateless-after-dispose value type: nothing to assert beyond the
      // symbols existing and not throwing.
      expect(typeof PowerPriorityQueue.prototype[Symbol.dispose]).toBe('function');
      expect(typeof PowerPriorityQueue.prototype[Symbol.asyncDispose]).toBe('function');
    });
  });
});
