import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

describe('PowerTTLMap', () => {
  // TEST-008. This file previously used real wall-clock sleeps with margins
  // wide enough to absorb them: a 60ms TTL asserted after a 120ms sleep, a 10ms
  // TTL after 30ms. Those passed on an idle machine and failed whenever
  // `verify` happened to be running a fresh `vite build` first - a 10ms TTL
  // asserted after an 8ms sleep is a race against the scheduler, and the fix
  // was to widen the sleep rather than remove the race.
  //
  // The file's own note said the honest options were "fake timers or a wide
  // margin", and took the margin. This takes the other one. `PowerTTLMap` reads
  // `nowMs()`, and `vi.advanceTimersByTimeAsync` moves the high-resolution
  // clock, so expiry becomes an explicit number rather than a hope. The wide
  // margins are gone: 120ms of real sleep per case became 61ms of clock, and
  // the assertions can now sit *just* past the TTL, which is where a boundary
  // bug would show up. A margin is slack you cannot tighten; a clock is not.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Advance the clock by `ms`, letting any timer callbacks run.
   *
   * `PowerTTLMap` stores `expiresAt = nowMs() + ttl + 1` and expires on
   * `nowMs() > expiresAt`, so a TTL of `t` is only past after **`t + 2`** ms —
   * the internal `+ 1` is a margin of its own, and an earlier draft that used
   * `t + 1` produced a suite where nothing was ever expired. The margins below
   * are that tight deliberately: a clock makes it possible to test the
   * boundary rather than merely clear it, which is the point of the conversion.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

  it('set/get respects TTL and returns undefined after expiry', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 60);
    expect(m.get('a')).toBe(1);
    await tick(62); // past the 60ms TTL *and* its internal +1 margin
    expect(m.get('a')).toBeUndefined();
  });

  it('has() returns false after expiry', async () => {
    const m = new PowerTTLMap();
    m.set('b', 2, 60);
    expect(m.has('b')).toBe(true);
    await tick(62);
    expect(m.has('b')).toBe(false);
  });

  it('size counts resident entries; expiredCount and purge() are separate', async () => {
    const m = new PowerTTLMap();
    m.set('x', 'x', 60);
    m.set('y', 'y', 300);
    expect(m.size).toBe(2);
    await tick(62);
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
    await tick(12);
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
    await tick(20);
    expect(m.touch('t')).toBe(true);
    // Only 20ms of the refreshed 60ms has elapsed, so the value must survive.
    await tick(20);
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
    await tick(12);
    // Collection is what fires the callback, and it is now an explicit call.
    m.purge();
    expect(called).toEqual([['o', 'val']]);
  });

  it('touch returns false for missing and expired keys', async () => {
    const m = new PowerTTLMap(5);

    expect(m.touch('missing')).toBe(false);

    m.set('gone', 1, 5);
    await tick(7);

    expect(m.touch('gone')).toBe(false);
    expect(m.has('gone')).toBe(false);
  });

  it('iterators and forEach skip expired entries and preserve live values', async () => {
    const m = new PowerTTLMap();
    m.set('a', 1, 5);
    m.set('b', 2, 50);
    m.set('c', 3);

    await tick(7);

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
    await tick(22);
    expect(m.get('a')).toBeUndefined();

    m.set('b', 2);
    expect(m.touch('b', { ttl: 20 })).toBe(true);
    expect(m.get('b')).toBe(2);
    await tick(22);
    expect(m.get('b')).toBeUndefined();
  });

  it('accepts options-object constructor form (defaultTTL + onExpire)', async () => {
    const called = [];
    const m = new PowerTTLMap({ defaultTTL: 10, onExpire: (k, v) => called.push([k, v]) });
    m.set('o', 'val'); // uses defaultTTL from options
    await tick(12);
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
    await tick(7);

    expect(() => m.get('temp')).not.toThrow();
    expect(m.get('temp')).toBeUndefined();
    expect(m.delete('missing')).toBe(false);
  });
});
