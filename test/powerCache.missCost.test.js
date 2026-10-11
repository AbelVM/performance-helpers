import { describe, it, expect, vi } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

// AUD-032. Every test here drives the injected behaviour directly rather than
// through a timing window: the claim under test is *which* entry is evicted, and
// that is a property of the hook's return values, not of how long anything took.

describe('PowerCache missCost', () => {
  describe('the default path is untouched', () => {
    it('evicts the LRU head when no hook is supplied', () => {
      // The whole reason the hook is opt-in. A cache that has never heard of
      // `missCost` must behave exactly as it did before the option existed, and
      // this is the assertion that says so — not a comment claiming it.
      const cache = new PowerCache({ maxEntries: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // 'a' is now MRU, so 'b' is the LRU head
      cache.set('d', 4);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('treats missCostScan of 1 as plain LRU even with a hook', () => {
      // A scan width of one compares a single candidate, so the cheapest of one
      // is that one. This is the assertion that the width knob actually reaches
      // zero rather than bottoming out at some hidden minimum.
      const cache = new PowerCache({
        maxEntries: 3,
        missCost: (k) => (k === 'b' ? 1 : 1000),
        missCostScan: 1,
      });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a');
      cache.set('d', 4);
      // 'b' is the LRU head and the scan never looks past it.
      expect(cache.has('b')).toBe(false);
    });

    it('never enters the cost scan when no hook is supplied', () => {
      // The guard on the eviction path is a **performance** guard, and this is
      // the assertion that says so — because removing it is behaviourally
      // equivalent, which the mutation check established rather than assumed.
      // Without the guard, `_cheapestEvictionCandidate` still returns the
      // eviction candidate (every cost reads as `NaN`, and `NaN` loses every
      // comparison), so the same entry is evicted either way. What changes is
      // that the common path now calls a `null` hook once per candidate per
      // eviction and catches the resulting TypeError.
      //
      // Asserted by spying on the private method rather than by a duration,
      // per the house rule: a counter or a shape, never a timing window. The
      // same convention `powerQueue.test.js` uses when it reads `_buffer`.
      const cache = new PowerCache({ maxEntries: 3 });
      const scan = vi.spyOn(cache, '_cheapestEvictionCandidate');
      for (let i = 0; i < 20; i++) cache.set(i, i);
      expect(cache.size).toBe(3);
      expect(scan).not.toHaveBeenCalled();
    });
  });

  describe('the hook chooses the victim', () => {
    it('evicts the cheapest candidate rather than the LRU head', () => {
      // The behaviour the option exists for. 'b' is the least recently used, but
      // a miss on it costs 1000 while a miss on 'c' costs 1, so 'c' goes.
      const cache = new PowerCache({
        maxEntries: 3,
        missCost: (k) => (k === 'b' ? 1000 : 1),
        missCostScan: 8,
      });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // 'b' is now the LRU head
      cache.set('d', 4);
      expect(cache.has('c')).toBe(false);
      expect(cache.has('b')).toBe(true);
    });

    it('passes the key and the value to the hook', () => {
      // A hook that cannot see the value cannot weight by anything derived from
      // it, which is most of what a caller would want to weight by.
      const seen = [];
      const cache = new PowerCache({
        maxEntries: 2,
        missCost: (k, v) => {
          seen.push([k, v]);
          return 1;
        },
      });
      cache.set('k1', 'v1');
      cache.set('k2', 'v2');
      cache.set('k3', 'v3');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some(([k, v]) => k === 'k1' && v === 'v1')).toBe(true);
    });

    it('respects the scan width', () => {
      // The bound is the design. With a width of 2 the hook only ever sees the
      // two least-recently-used candidates, so a cheap entry further back is
      // never found and the LRU head survives.
      const cache = new PowerCache({
        maxEntries: 4,
        missCost: (k) => (k === 'far' ? 1 : 1000),
        missCostScan: 2,
      });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('far', 3);
      cache.set('c', 4);
      // Recency order, LRU first: a, b, far, c. A width-2 scan sees only a and b.
      cache.set('d', 5);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('far')).toBe(true);
    });

    it('still honours maxEntries', () => {
      // The hook changes *which* entry leaves, never *whether* the cache is
      // bounded. A cost-weighted policy that let the cache grow would be a
      // memory leak with a helpful name.
      const cache = new PowerCache({
        maxEntries: 5,
        missCost: () => 1,
        missCostScan: 8,
      });
      for (let i = 0; i < 200; i++) cache.set(i, i);
      expect(cache.size).toBe(5);
    });
  });

  describe('a hook that misbehaves', () => {
    it('does not let a throwing hook break eviction', () => {
      // The eviction path has no `try/catch` above it, so a callback error here
      // would surface as an exception from `set()` — turning a cache write into
      // a crash on the strength of a caller's own hook. Same reasoning as the
      // guard around `onEvict`.
      const cache = new PowerCache({
        maxEntries: 4,
        missCost: () => {
          throw new Error('hook exploded');
        },
      });
      expect(() => {
        for (let i = 0; i < 50; i++) cache.set(i, i);
      }).not.toThrow();
      expect(cache.size).toBe(4);
    });

    it('falls back to recency when the hook returns a non-number', () => {
      // `NaN` loses every comparison, so a candidate whose cost could not be read
      // never wins — which leaves `best` where the recency order put it. That is
      // the safe direction: an unreadable cost must not promote an entry.
      const cache = new PowerCache({
        maxEntries: 3,
        missCost: () => Number.NaN,
        missCostScan: 8,
      });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a');
      cache.set('d', 4);
      expect(cache.has('b')).toBe(false);
    });

    it('rejects a non-function hook at construction', () => {
      // Validated here rather than at the eviction site, because a hook checked
      // only when the cache first fills is a hook whose type error arrives under
      // load.
      expect(() => new PowerCache({ missCost: 42 })).toThrow(TypeError);
      expect(() => new PowerCache({ missCost: 'nope' })).toThrow(TypeError);
      expect(() => new PowerCache({ missCost: null })).not.toThrow();
    });

    it('clamps a nonsensical scan width', () => {
      const wide = new PowerCache({ missCost: () => 1, missCostScan: 0 });
      expect(wide.missCostScan).toBe(1);
      const negative = new PowerCache({ missCost: () => 1, missCostScan: -5 });
      expect(negative.missCostScan).toBe(1);
      const fractional = new PowerCache({ missCost: () => 1, missCostScan: 4.7 });
      expect(fractional.missCostScan).toBe(4);
    });
  });

  describe('the measured behaviour, pinned', () => {
    // These two are characterisations, not aspirations, and they say so. The
    // measurement behind them is in `_cheapestEvictionCandidate`'s docblock and
    // in the guide; what is pinned here is that the implementation still does
    // what was measured, so a future change to the eviction path cannot quietly
    // invert either result.

    /** The two-class workload the measurement used. */
    function workload({ missCost, missCostScan, dearReuse }) {
      let s = 999 >>> 0;
      const rng = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
      const cheapKeys = 2000;
      const dearKeys = 400;
      const costOf = (k) => (k < cheapKeys ? 1 : 100);
      const cache = new PowerCache({ maxEntries: 500, missCost, missCostScan });
      let total = 0;
      let cursor = 0;
      for (let i = 0; i < 60000; i++) {
        let key;
        if (rng() < 0.1) {
          key = dearReuse ? cheapKeys + Math.floor(rng() * dearKeys) : cheapKeys + cursor++;
        } else {
          key = Math.floor(rng() * cheapKeys);
        }
        if (cache.has(key)) continue;
        total += costOf(key);
        cache.set(key, 1);
      }
      return total;
    }

    const hook = (k) => (k < 2000 ? 1 : 100);

    it('cuts total miss cost sharply when expensive keys are re-read', () => {
      const lru = workload({ missCost: null, dearReuse: true });
      const aware = workload({ missCost: hook, missCostScan: 8, dearReuse: true });
      // Measured at -84.1%. Pinned as a wide band rather than the exact figure,
      // because the point is the order of magnitude and not the third digit.
      expect(aware).toBeLessThan(lru * 0.5);
    });

    it('costs slightly more when expensive keys are never re-read', () => {
      // The adversarial case, and the reason the default scan width is small.
      // Measured at +0.9% for a width of 8 and +1.7% for a full scan. Pinned so
      // that "the hook is free" cannot be claimed by someone reading only the
      // beneficial row above.
      const lru = workload({ missCost: null, dearReuse: false });
      const aware = workload({ missCost: hook, missCostScan: 8, dearReuse: false });
      expect(aware).toBeGreaterThan(lru);
      // ...but the penalty stays small. A width-8 scan must not approach the
      // full-scan penalty, or the bound is not doing its job.
      expect(aware).toBeLessThan(lru * 1.05);
    });
  });
});
