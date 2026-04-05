import { describe, it, expect } from 'vitest';
import { PowerQueue } from '../src/helpers/powerQueue.js';

describe('PowerQueue.unshiftMany', () => {
  it('prepends items to an empty queue and grows as needed', () => {
    const q = new PowerQueue(2);
    const items = [0, 1, 2, 3, 4, 5];
    q.unshiftMany(items);
    expect(q.length).toBe(items.length);
    expect(q.capacity).toBeGreaterThanOrEqual(items.length);
    const got = [];
    while (!q.isEmpty) got.push(q.shift());
    expect(got).toEqual(items);
  });

  it('preserves order when prepending to a wrapped buffer', () => {
    const q = new PowerQueue(4);
    // fill then consume to cause head/tail to wrap
    q.push(0);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.shift()).toBe(0);
    expect(q.shift()).toBe(1);
    // now head points to 2, tail wrapped
    q.unshiftMany(['a', 'b', 'c']);
    expect(q.length).toBe(5);
    const got = [];
    while (!q.isEmpty) got.push(q.shift());
    expect(got).toEqual(['a', 'b', 'c', 2, 3]);
  });

  it('handles large prepend that forces multiple resizes and keeps order', () => {
    const q = new PowerQueue(4);
    // create some existing items
    q.push('x');
    q.push('y');
    const many = Array.from({ length: 50 }, (_, i) => `p${i}`);
    q.unshiftMany(many);
    expect(q.length).toBe(52);
    const first = q.shift();
    expect(first).toBe('p0');
    // consume some and ensure tail data preserved
    const tail = [];
    while (!q.isEmpty) tail.push(q.shift());
    expect(tail.slice(0, many.length - 1)).toEqual(many.slice(1));
    expect(tail.slice(-2)).toEqual(['x', 'y']);
  });
});
