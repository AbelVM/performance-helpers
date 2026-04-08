import { describe, it, expect } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

describe('PowerTTLMap', () => {
  it('set/get respects TTL and returns undefined after expiry', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 20);
    expect(m.get('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(m.get('a')).toBeUndefined();
  });

  it('has() returns false after expiry', async () => {
    const m = new PowerTTLMap();
    m.set('b', 2, 10);
    expect(m.has('b')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.has('b')).toBe(false);
  });

  it('size reflects active entries and purges expired', async () => {
    const m = new PowerTTLMap();
    m.set('x', 'x', 10);
    m.set('y', 'y', 50);
    expect(m.size).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    // one expired
    expect(m.size).toBe(1);
    expect([...m.keys()]).toEqual(['y']);
  });

  it('touch refreshes TTL', async () => {
    const m = new PowerTTLMap(10);
    m.set('t', 123); // defaultTTL 10
    await new Promise((r) => setTimeout(r, 8));
    expect(m.touch('t')).toBe(true);
    await new Promise((r) => setTimeout(r, 8));
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
    // trigger lazy purge
    void m.size;
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
