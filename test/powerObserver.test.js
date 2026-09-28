import { describe, it, expect } from 'vitest';
import { PowerObserver } from '../src/helpers/powerObserver.js';

describe('PowerObserver', () => {
  it('notifies subscribers asynchronously and returns unsubscribe', async () => {
    const obs = new PowerObserver(1);
    let called = 0;
    const unsub = obs.subscribe((next, prev) => {
      expect(prev).toBe(1);
      expect(next).toBe(2);
      called++;
    });
    obs.value = 2;
    await Promise.resolve();
    expect(called).toBe(1);
    unsub();
    obs.value = 3;
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it('clear removes all subscribers and size reflects count', () => {
    const obs = new PowerObserver('a');
    const sub = () => {};
    obs.subscribe(sub);
    obs.subscribe(() => {});
    expect(obs.size).toBe(2);
    obs.clear();
    expect(obs.size).toBe(0);
  });

  it('throws on invalid subscriber', () => {
    const obs = new PowerObserver(0);
    expect(() => obs.subscribe(null)).toThrow();
  });

  it('respects distinct and map options', async () => {
    const obs = new PowerObserver(2, { distinct: true, map: (v) => v % 2 });
    let calls = 0;
    obs.subscribe(() => {
      calls++;
    });
    obs.value = 4; // maps 0 -> previous 0 -> no notify
    await Promise.resolve();
    expect(calls).toBe(0);
    obs.value = 5; // maps 1 -> notify
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('allows setting map function via .map()', async () => {
    const obs = new PowerObserver(1);
    obs.map((v) => v * 2);
    let called = 0;
    obs.subscribe((n, p) => {
      expect(n).toBe(4);
      expect(p).toBe(2);
      called++;
    });
    obs.value = 2;
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it('supports sync delivery and swallows subscriber errors', () => {
    const obs = new PowerObserver(1, { async: false });
    const seen = [];
    obs.subscribe(() => {
      throw new Error('listener failed');
    });
    obs.subscribe((next, prev) => {
      seen.push([prev, next]);
    });

    obs.value = 2;

    expect(seen).toEqual([[1, 2]]);
  });

  it('coalesces multiple async writes into the latest next value while preserving the first prev', async () => {
    const obs = new PowerObserver(1);
    const seen = [];
    obs.subscribe((next, prev) => {
      seen.push([prev, next]);
    });

    obs.value = 2;
    obs.value = 3;
    await Promise.resolve();

    expect(seen).toEqual([[1, 3]]);
  });

  it('drain aliases flush and map(null) clears the mapping function', async () => {
    const obs = new PowerObserver(2, { async: 'macrotask', map: (v) => v * 2 });
    const seen = [];
    obs.subscribe((next, prev) => {
      seen.push([prev, next]);
    });

    obs.map(null);
    obs.value = 4;
    obs.drain();

    expect(seen).toEqual([[2, 4]]);
  });

  it('throws when map is set to a non-function value', () => {
    const obs = new PowerObserver(1);
    expect(() => obs.map(123)).toThrow('map must be a function');
  });

  it('supports macrotask scheduling and flush()', async () => {
    const obs = new PowerObserver(1, { async: 'macrotask' });
    let called = 0;
    obs.subscribe((n, p) => {
      expect(p).toBe(1);
      expect(n).toBe(2);
      called++;
    });
    obs.value = 2;
    // macrotask: microtask await won't observe it
    await Promise.resolve();
    expect(called).toBe(0);
    // flush synchronously
    obs.flush();
    expect(called).toBe(1);
  });
});

// ─── ALG-008: derived observables ────────────────────────────────────────────
//
// The load-bearing property is the lazy subscribe / release, not the value
// arithmetic. A derived observer that eagerly subscribes upstream, or that never
// releases, leaks: a chain of ten derived observers held by one consumer keeps
// all ten upstreams alive, and a consumer that unsubscribes and is collected
// leaves every one of them running. These tests count upstream subscribers
// directly so that is caught.
describe('PowerObserver derived observables (ALG-008)', () => {
  const src = () => new PowerObserver(0, { async: false });

  it('derive() produces a new observer, leaves the source alone, and is synchronous', () => {
    const a = src();
    const doubled = a.derive((v) => v * 2);
    expect(doubled).not.toBe(a);
    const seen = [];
    doubled.subscribe((v) => seen.push(v));
    a.value = 5;
    // Synchronous because the derived inherited the source's `async: false`.
    // Had it defaulted to a microtask, this would be `[]` and the chain would
    // quietly deliver on a different turn than the one that caused it.
    expect(seen).toEqual([10]);
    expect(a.value).toBe(5);
  });

  it('does not subscribe upstream until something subscribes downstream', () => {
    const a = src();
    const d = a.derive((v) => v + 1);
    // Building a chain must not create upstream subscriptions; only the one the
    // consumer actually needs.
    expect(a.size).toBe(0);
    d.subscribe(() => {});
    expect(a.size).toBe(1);
  });

  it('releases the upstream when the last subscriber leaves', () => {
    const a = src();
    const d = a.derive((v) => v + 1);
    const off1 = d.subscribe(() => {});
    const off2 = d.subscribe(() => {});
    expect(a.size).toBe(1);
    off1();
    expect(a.size).toBe(1); // one consumer left, so still subscribed
    off2();
    expect(a.size).toBe(0); // nobody left, so nothing upstream
  });

  it('a released chain does not track the source, and comes current on re-subscribe', () => {
    const a = src();
    const d = a.derive((v) => v * 3);
    const seen = [];
    const off = d.subscribe((v) => seen.push(v));
    a.value = 2;
    off();
    a.value = 100; // no subscribers, so this is not propagated
    expect(seen).toEqual([6]);

    const seen2 = [];
    d.subscribe((v) => seen2.push(v));
    a.value = 4;
    expect(seen2).toEqual([12]);
  });

  it('holds a snapshot, not a live value, while nobody is subscribed', () => {
    // Deliberate and surprising enough to pin: an un-subscribed chain does not
    // subscribe upstream, so `.value` is what it captured when it was built.
    // That is the same trade that makes an unused chain free.
    const a = src();
    const d = a.derive((v) => v * 2);
    expect(d.value).toBe(0);
    a.value = 5;
    expect(d.value).toBe(0); // snapshot
    d.subscribe(() => {}); // attaching is what makes it current
    a.value = 6;
    expect(d.value).toBe(12);
  });

  it('unsubscribing twice is harmless', () => {
    const a = src();
    const d = a.derive((v) => v);
    const off = d.subscribe(() => {});
    off();
    expect(() => off()).not.toThrow();
  });

  describe('filter', () => {
    it('only notifies when the predicate passes', () => {
      const a = src();
      const evens = a.filter((v) => v % 2 === 0);
      const seen = [];
      evens.subscribe((v) => seen.push(v));
      for (const v of [1, 2, 3, 4, 5, 6]) a.value = v;
      expect(seen).toEqual([2, 4, 6]);
    });

    it('exposes the last value that passed, not the latest upstream value', () => {
      const a = src();
      const evens = a.filter((v) => v % 2 === 0);
      evens.subscribe(() => {}); // an un-subscribed chain is only a snapshot
      a.value = 2;
      a.value = 3; // filtered out
      expect(evens.value).toBe(2);
    });

    it('rejects a non-function predicate', () => {
      expect(() => src().filter(null)).toThrow(TypeError);
      expect(() => src().filter('nope')).toThrow(TypeError);
    });
  });

  describe('distinct', () => {
    it('only notifies when the value changes', () => {
      const a = src();
      const d = a.distinct();
      const seen = [];
      d.subscribe((v) => seen.push(v));
      a.value = 1;
      a.value = 1;
      a.value = 1;
      a.value = 2;
      expect(seen).toEqual([1, 2]);
    });

    it('uses Object.is, so NaN equals itself and -0 differs from 0', () => {
      const a = new PowerObserver(Number.NaN, { async: false });
      const d = a.distinct();
      const seen = [];
      d.subscribe((v) => seen.push(Number.isNaN(v) ? 'NaN' : String(v)));
      a.value = Number.NaN; // suppressed: Object.is(NaN, NaN) is true
      expect(seen).toEqual([]);
      a.value = 0;
      a.value = -0; // distinct under Object.is
      expect(seen).toEqual(['0', '0']);
    });
  });

  describe('combineLatest', () => {
    it('emits the latest value of every source when any changes', () => {
      const a = new PowerObserver(1, { async: false });
      const b = new PowerObserver('x', { async: false });
      const both = PowerObserver.combineLatest(a, b);
      const seen = [];
      both.subscribe((v) => seen.push(v.slice()));
      a.value = 2;
      b.value = 'y';
      a.value = 3;
      expect(seen).toEqual([
        [2, 'x'],
        [2, 'y'],
        [3, 'y'],
      ]);
    });

    it('subscribes to every source only on first use, and releases all of them', () => {
      const a = new PowerObserver(1, { async: false });
      const b = new PowerObserver(2, { async: false });
      const both = PowerObserver.combineLatest(a, b);
      expect(a.size).toBe(0);
      expect(b.size).toBe(0);
      const off = both.subscribe(() => {});
      expect(a.size).toBe(1);
      expect(b.size).toBe(1);
      off();
      expect(a.size).toBe(0);
      expect(b.size).toBe(0);
    });

    it('rejects fewer than two sources and non-observers', () => {
      const a = new PowerObserver(1, { async: false });
      expect(() => PowerObserver.combineLatest(a)).toThrow(/at least two/);
      expect(() => PowerObserver.combineLatest(a, 5)).toThrow(/PowerObserver instances/);
    });
  });
});
