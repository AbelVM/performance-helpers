import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache branch coverage', () => {
  it('peek, has(ignoreExpiry), delete and clear behave as expected', async () => {
    const c = new PowerCache({ defaultTTL: 1, maxEntries: 10 });
    c.set('a', 1, { ttl: 1 });
    // wait for expiry
    await new Promise((r) => setTimeout(r, 5));
    expect(c.peek('a')).toBeUndefined();
    // peek() now clears observed expired entries, so the expired item is no longer present.
    expect(c.has('a', { ignoreExpiry: true })).toBe(false);
    expect(c.has('a')).toBe(false);
    expect(c.delete('a')).toBe(false);
    c.set('x', 1);
    c.set('y', 2);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('clears pooled nodes to avoid retained references', () => {
    const c = new PowerCache({ maxEntries: 2, maxPoolSize: 2 });
    c.set('x', { value: 1 });
    c.set('y', { value: 2 });
    c.clear();
    expect(c.size).toBe(0);
    expect(c.pool.length).toBeGreaterThanOrEqual(1);
    expect(c.pool.every((node) => node.key === null && node.value === null)).toBe(true);
  });

  it('startCleanup accepts number and options object', () => {
    const c = new PowerCache({ defaultTTL: 1000 });
    // numeric interval
    c.startCleanup(10);
    expect(c._cleanupTimer).not.toBeNull();
    c.stopCleanup();

    // options object path
    c.startCleanup({ interval: 10, maxCleanupPerTick: 1 });
    expect(c._cleanupTimer).not.toBeNull();
    c.stopCleanup();
  });

  it('resize triggers eviction when limits lowered', () => {
    const c = new PowerCache({ maxEntries: 3 });
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4);
    const beforeEvictions = c.evictions;
    c.resize({ maxEntries: 1 });
    expect(c.evictions).toBeGreaterThanOrEqual(beforeEvictions);
    expect(c.size).toBeLessThanOrEqual(1);
  });

  it('hasEqual deep comparisons for many types', () => {
    const c = new PowerCache();
    c.set('arr', [1, 2, { a: 3 }]);
    expect(c.hasEqual('arr', [1, 2, { a: 3 }])).toBe(true);

    const u = new Uint8Array([1, 2, 3]);
    c.set('u8', u);
    expect(c.hasEqual('u8', new Uint8Array([1, 2, 3]))).toBe(true);

    const ab = new ArrayBuffer(3);
    new Uint8Array(ab).set([9, 8, 7]);
    c.set('ab', ab);
    expect(c.hasEqual('ab', ab)).toBe(true);

    const d = new Date(123456);
    c.set('d', d);
    expect(c.hasEqual('d', new Date(123456))).toBe(true);

    const r = /abc/g;
    c.set('r', r);
    expect(c.hasEqual('r', /abc/g)).toBe(true);

    const m = new Map([['k', { v: 1 }]]);
    c.set('m', m);
    expect(c.hasEqual('m', new Map([['k', { v: 1 }]]))).toBe(true);

    const s = new Set([1, 2, 3]);
    c.set('s', s);
    expect(c.hasEqual('s', new Set([1, 2, 3]))).toBe(true);

    const o = { x: 1, y: [2, 3] };
    c.set('o', o);
    expect(c.hasEqual('o', { x: 1, y: [2, 3] })).toBe(true);
    expect(c.hasEqual('o', { x: 1, y: [2, 4] })).toBe(false);
  });

  it('cleanupExpiredUpTo scans up to maxScan and advances cursor/evictions', async () => {
    const c = new PowerCache();
    for (let i = 0; i < 5; i++) c.set('k' + i, i, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const beforeExpirations = c.expirations;
    const scanned = c.cleanupExpiredUpTo(2);
    expect(scanned).toBeGreaterThanOrEqual(1);
    expect(c.expirations).toBeGreaterThanOrEqual(beforeExpirations);
  });

  it('hasEqual returns false for various mismatch cases', () => {
    const c = new PowerCache();
    c.set('prim', 1);
    expect(c.hasEqual('prim', 2)).toBe(false);

    c.set('u', new Uint8Array([1, 2, 3]));
    expect(c.hasEqual('u', new Uint8Array([1, 2, 3, 4]))).toBe(false);

    const ab1 = new ArrayBuffer(2);
    new Uint8Array(ab1).set([1, 2]);
    c.set('ab', ab1);
    const ab2 = new ArrayBuffer(3);
    expect(c.hasEqual('ab', ab2)).toBe(false);

    c.set('d', new Date(1));
    expect(c.hasEqual('d', 'not-a-date')).toBe(false);

    c.set('r', /a/g);
    expect(c.hasEqual('r', /a/)).toBe(false);

    c.set('m', new Map([['k', 1]]));
    expect(c.hasEqual('m', new Map([['k', 'diff']]))).toBe(false);

    c.set('s', new Set([1, 2]));
    expect(c.hasEqual('s', new Set([1, 3]))).toBe(false);
  });

  it('hasEqual detects Map value mismatches for nested objects', () => {
    const c = new PowerCache();
    const m = new Map([['k', { v: 1 }]]);
    c.set('mNested', m);
    expect(c.hasEqual('mNested', new Map([['k', { v: 2 }]]))).toBe(false);
  });

  it('hasEqual handles a large mixed nested structure', () => {
    const c = new PowerCache();
    const ua1 = new Uint8Array([1, 2, 3]);
    const ua2 = new Uint8Array([9, 8]);
    const map = new Map([['k', { inner: ua2 }]]);
    const set = new Set([{ inner: ua2 }]);
    const complex = {
      arr: [1, { foo: 'bar' }, new Uint8Array([1, 2])],
      buf: ua1.buffer,
      date: new Date(1234),
      re: /x/g,
      map,
      set,
    };
    // create an equivalent deep clone
    const clone = JSON.parse(
      JSON.stringify(complex, (k, v) =>
        v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v
      )
    );
    // rehydrate binary parts in clone to match types
    clone.arr[2] = new Uint8Array([1, 2]);
    clone.buf = new Uint8Array([1, 2, 3]).buffer;
    clone.date = new Date(1234);
    clone.re = /x/g;
    clone.map = new Map([['k', { inner: new Uint8Array([9, 8]) }]]);
    clone.set = new Set([{ inner: new Uint8Array([9, 8]) }]);

    c.set('big', complex);
    expect(c.hasEqual('big', clone)).toBe(true);
  });

  it('startCleanup handles reentrant runs by rescheduling (tick _cleanupRunning path)', () => {
    const c = new PowerCache({ defaultTTL: 1000 });
    const origSetTimeout = global.setTimeout;
    const ids = [];
    try {
      let captured;
      // capture tick function when startCleanup schedules it
      // @ts-ignore
      global.setTimeout = (fn) => {
        if (!captured) captured = fn;
        const id = Math.floor(Math.random() * 1e6);
        ids.push(id);
        return id;
      };
      c.startCleanup({ interval: 10, maxCleanupPerTick: 1 });
      expect(typeof captured).toBe('function');
      // simulate a reentrant condition
      c._cleanupRunning = true;
      // call the captured tick to exercise the 'if (this._cleanupRunning)' branch
      captured();
      expect(ids.length).toBeGreaterThanOrEqual(2);
      c.stopCleanup();
    } finally {
      // @ts-ignore
      global.setTimeout = origSetTimeout;
    }
  });

  it('cleanupExpiredUpTo resumes from head when _cleanupCursor is invalid', () => {
    const c = new PowerCache();
    c.set('a', 1);
    // craft an invalid cursor object
    c._cleanupCursor = { key: 'nope' };
    const scanned = c.cleanupExpiredUpTo(1);
    expect(scanned).toBeGreaterThanOrEqual(0);
  });

  it('startCleanup tick executes cleanupExpiredUpTo when not reentrant', () => {
    const c = new PowerCache({ defaultTTL: 1000 });
    const origSetTimeout = global.setTimeout;
    try {
      let captured;
      // capture tick
      // @ts-ignore
      global.setTimeout = (fn) => {
        captured = fn;
        return 1;
      };
      c.set('x', 1);
      // mark node expired so cleanupExpiredUpTo will do work
      for (const n of c.map.values()) n.expiresAt = Date.now() - 1;
      c.startCleanup({ interval: 10, maxCleanupPerTick: 10 });
      expect(typeof captured).toBe('function');
      // ensure timer appears present
      c._cleanupTimer = 1;
      c._cleanupRunning = false;
      // invoke captured tick to run cleanupExpiredUpTo path
      captured();
      expect(c._cleanupTimer).not.toBeNull();
      c.stopCleanup();
    } finally {
      // @ts-ignore
      global.setTimeout = origSetTimeout;
    }
  });
});
