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
});
