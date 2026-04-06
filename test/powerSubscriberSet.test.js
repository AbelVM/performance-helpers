import { describe, it, expect } from 'vitest';
import { PowerSubscriberSet } from '../src/helpers/powerSubscriberSet.js';

describe('PowerSubscriberSet', () => {
  it('stores and returns listeners', () => {
    const subs = new PowerSubscriberSet();
    const fn = () => {};
    subs.add(fn);
    expect(subs.size).toBe(1);
    expect(subs.values()).toEqual([fn]);
  });

  it('is iterable and supports Array.from', () => {
    const subs = new PowerSubscriberSet();
    const fn = () => {};
    subs.add(fn);
    expect(Array.from(subs)).toEqual([fn]);
  });

  it('supports once listeners and removes them after invocation', () => {
    const subs = new PowerSubscriberSet();
    let called = 0;
    const fn = () => {
      called += 1;
    };
    subs.addOnce(fn);
    expect(subs.size).toBe(1);
    for (const listener of subs.values()) listener();
    expect(called).toBe(1);
    expect(subs.size).toBe(0);
  });

  it('returns an unsubscribe callback from add', () => {
    const subs = new PowerSubscriberSet();
    const fn = () => {};
    const unsubscribe = subs.add(fn);
    expect(subs.size).toBe(1);
    unsubscribe();
    expect(subs.size).toBe(0);
  });

  it('delete removes original function passed to addOnce', () => {
    const subs = new PowerSubscriberSet();
    const fn = () => {};
    subs.addOnce(fn);
    expect(subs.size).toBe(1);
    subs.delete(fn);
    expect(subs.size).toBe(0);
  });
});
