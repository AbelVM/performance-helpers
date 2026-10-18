import { describe, it, expect } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

describe('PowerTTLMap maxSize LRU', () => {
  it('evicts LRU when over maxSize', () => {
    const m = new PowerTTLMap(0, { maxSize: 2 });
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.size).toBe(2);
    expect(m.get('a')).toBeUndefined();
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
  });
  it('get makes key MRU', () => {
    const m = new PowerTTLMap(0, { maxSize: 2 });
    m.set('a', 1);
    m.set('b', 2);
    m.get('a'); // a becomes MRU
    m.set('c', 3); // evicts b
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBeUndefined();
    expect(m.get('c')).toBe(3);
  });
  it('maxSize 0 is unbounded', () => {
    const m = new PowerTTLMap(0, { maxSize: 0 });
    for (let i = 0; i < 100; i++) m.set(i, i);
    expect(m.size).toBe(100);
  });
});
