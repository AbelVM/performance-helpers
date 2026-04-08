import { describe, it, expect, vi } from 'vitest';
import { PowerSubscriberSet, cleanupWeakRefs } from '../src/helpers/powerSubscriberSet.js';

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

  it('forEach iterates live listeners in insertion order', () => {
    const subs = new PowerSubscriberSet();
    const calls = [];
    const a = () => calls.push('a');
    const b = () => calls.push('b');
    subs.add(a);
    subs.add(b);

    const seen = [];
    subs.forEach((listener) => {
      seen.push(listener);
      listener();
    });

    expect(seen).toEqual([a, b]);
    expect(calls).toEqual(['a', 'b']);
  });

  it('clear removes listeners and resets once subscriptions', () => {
    const subs = new PowerSubscriberSet();
    const fn = vi.fn();
    subs.addOnce(fn);
    subs.clear();

    expect(subs.size).toBe(0);
    expect(subs.delete(fn)).toBe(false);
  });

  it('enforces maxListeners and rejects invalid listeners unless weak refs are supplied', () => {
    const subs = new PowerSubscriberSet({ maxListeners: 1 });
    subs.add(() => {});

    expect(() => subs.add(() => {})).toThrow(/maxListeners/);
    expect(() => subs.add(null)).toThrow(TypeError);
    expect(() => subs.addOnce(null)).toThrow(TypeError);
  });

  it('accepts weak-ref-like entries in weak mode and cleans dead refs during access', () => {
    const liveFn = () => {};
    const deadRef = { deref: () => undefined };
    const liveRef = { deref: () => liveFn };
    const subs = new PowerSubscriberSet({ weak: true });

    const unsubscribe = subs.add(liveRef);
    subs.add(deadRef);

    expect(subs.values()).toEqual([liveFn]);
    expect(subs.size).toBe(1);
    unsubscribe();
    expect(subs.size).toBe(0);
  });

  it('cleanupWeakRefs supports cleanup, _cleanup, and iterable buckets', () => {
    const cleanupBucket = { cleanup: vi.fn() };
    cleanupWeakRefs(cleanupBucket);
    expect(cleanupBucket.cleanup).toHaveBeenCalled();

    const privateCleanupBucket = { _cleanup: vi.fn() };
    cleanupWeakRefs(privateCleanupBucket);
    expect(privateCleanupBucket._cleanup).toHaveBeenCalled();

    const dead = { deref: () => undefined };
    const live = { deref: () => () => {} };
    const iterableBucket = new Set([dead, live]);
    const deleted = [];
    iterableBucket.delete = ((original) => (entry) => {
      deleted.push(entry);
      return original.call(iterableBucket, entry);
    })(iterableBucket.delete);

    cleanupWeakRefs(iterableBucket);
    expect(deleted).toContain(dead);
    expect(iterableBucket.has(live)).toBe(true);
  });
});
