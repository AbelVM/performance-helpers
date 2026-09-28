import { describe, it, expect } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

describe('PowerTTLMap', () => {
  // The margins in these four are deliberately wide. They were 2-10ms against
  // real wall-clock sleeps, which passed on an idle machine and failed
  // whenever `verify` happened to be running a fresh `vite build` first: a
  // 10ms TTL asserted after an 8ms sleep is a 2ms race against the scheduler.
  // `PowerTTLMap` reads `nowMs()` rather than anything injectable, so the
  // honest options are fake timers or a wide margin; wide margin chosen here
  // because the whole file still finishes in well under half a second.

  it('set/get respects TTL and returns undefined after expiry', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 60);
    expect(m.get('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(m.get('a')).toBeUndefined();
  });

  it('has() returns false after expiry', async () => {
    const m = new PowerTTLMap();
    m.set('b', 2, 60);
    expect(m.has('b')).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(m.has('b')).toBe(false);
  });

  it('size counts resident entries; expiredCount and purge() are separate', async () => {
    const m = new PowerTTLMap();
    m.set('x', 'x', 60);
    m.set('y', 'y', 300);
    expect(m.size).toBe(2);
    await new Promise((r) => setTimeout(r, 120));
    // 'x' has expired but is still resident. Reading `.size` is a pure O(1)
    // property read — it must not collect anything as a side effect.
    expect(m.size).toBe(2);
    expect(m.expiredCount).toBe(1);
    // Collection is explicit, and the reported count matches what it removed.
    // (`keys()` also collects as it iterates, so it must come *after* `purge()`
    // if the count is to be observable.)
    expect(m.purge()).toBe(1);
    expect(m.size).toBe(1);
    expect(m.expiredCount).toBe(0);
    // The live view skips it whether or not it was collected.
    expect([...m.keys()]).toEqual(['y']);
  });

  it('reading size does not fire onExpire; purge() does', async () => {
    const called = [];
    const m = new PowerTTLMap({ onExpire: (k) => called.push([k, 'val']) });
    m.set('x', 'x', 10);
    m.set('y', 'y', 10);
    await new Promise((r) => setTimeout(r, 30));
    // A property read with a callback side effect is an operation wearing a
    // property's syntax; this pins that reading it stays free of that.
    expect(m.size).toBe(2);
    expect(called).toEqual([]);
    expect(m.expiredCount).toBe(2);
    expect(called).toEqual([]);
    m.purge();
    expect(called).toHaveLength(2);
    expect(m.size).toBe(0);
  });

  it('purge() is a no-op with nothing expired', () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 5000);
    m.set('b', 2); // no TTL -> never expires
    expect(m.purge()).toBe(0);
    expect(m.size).toBe(2);
    expect(m.expiredCount).toBe(0);
  });

  it('touch refreshes TTL', async () => {
    const m = new PowerTTLMap(60);
    m.set('t', 123); // defaultTTL 60
    await new Promise((r) => setTimeout(r, 20));
    expect(m.touch('t')).toBe(true);
    // Only 20ms of the refreshed 60ms has elapsed, so the value must survive.
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get('t')).toBe(123);
  });

  it('delete and clear behave correctly', () => {
    const m = new PowerTTLMap();
    m.set('k', 'v');
    expect(m.get('k')).toBe('v');
    expect(m.delete('k')).toBe(true);
    expect(m.get('k')).toBeUndefined();
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
  });

  it('invokes onExpire callback when entries expire', async () => {
    const called = [];
    const onExpire = (k, v) => called.push([k, v]);
    const m = new PowerTTLMap(0, { onExpire });
    m.set('o', 'val', 10);
    // wait for expiry
    await new Promise((r) => setTimeout(r, 20));
    // Collection is what fires the callback, and it is now an explicit call.
    m.purge();
    expect(called).toEqual([['o', 'val']]);
  });

  it('touch returns false for missing and expired keys', async () => {
    const m = new PowerTTLMap(5);

    expect(m.touch('missing')).toBe(false);

    m.set('gone', 1, 5);
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(m.touch('gone')).toBe(false);
    expect(m.has('gone')).toBe(false);
  });

  it('iterators and forEach skip expired entries and preserve live values', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 5);
    m.set('b', 2, 50);
    m.set('c', 3);

    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(Array.from(m.entries())).toEqual([
      ['b', 2],
      ['c', 3],
    ]);
    expect(Array.from(m.keys())).toEqual(['b', 'c']);
    expect(Array.from(m.values())).toEqual([2, 3]);
    expect(Array.from(m)).toEqual([
      ['b', 2],
      ['c', 3],
    ]);

    const seen = [];
    const ctx = { tag: 'ctx' };
    m.forEach(function (value, key, self) {
      seen.push([this.tag, key, value, self === m]);
    }, ctx);
    expect(seen).toEqual([
      ['ctx', 'b', 2, true],
      ['ctx', 'c', 3, true],
    ]);
  });

  it('accepts options-object form for set/touch (consistent with PowerCache.set)', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, { ttl: 20 });
    expect(m.get('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get('a')).toBeUndefined();

    m.set('b', 2);
    expect(m.touch('b', { ttl: 20 })).toBe(true);
    expect(m.get('b')).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get('b')).toBeUndefined();
  });

  it('accepts options-object constructor form (defaultTTL + onExpire)', async () => {
    const called = [];
    const m = new PowerTTLMap({ defaultTTL: 10, onExpire: (k, v) => called.push([k, v]) });
    m.set('o', 'val'); // uses defaultTTL from options
    await new Promise((r) => setTimeout(r, 20));
    m.purge();
    expect(called).toEqual([['o', 'val']]);
  });

  it('positional constructor still works (no regression)', () => {
    const m = new PowerTTLMap(10);
    m.set('p', 1);
    expect(m.get('p')).toBe(1);
  });

  it('supports non-expiring values and swallows onExpire callback errors', async () => {
    const m = new PowerTTLMap(0, {
      onExpire() {
        throw new Error('expire hook failed');
      },
    });

    m.set('persist', 1);
    expect(m.size).toBe(1);
    expect(m.get('persist')).toBe(1);

    m.set('temp', 2, 5);
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(() => m.get('temp')).not.toThrow();
    expect(m.get('temp')).toBeUndefined();
    expect(m.delete('missing')).toBe(false);
  });
});
