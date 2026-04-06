import { describe, it, expect } from 'vitest';
import { PowerQueue } from '../src/helpers/powerQueue.js';

describe('PowerQueue iterators and helpers', () => {
  it('values() and Symbol.iterator yield values in FIFO order without consuming', () => {
    const q = new PowerQueue(4);
    q.push(1);
    q.push(2);
    q.push(3);

    // values()
    expect(Array.from(q.values())).toEqual([1, 2, 3]);

    // default iterator (for...of / spread)
    expect([...q]).toEqual([1, 2, 3]);

    // original queue must be intact
    expect(q.length).toBe(3);
  });

  it('keys() yields zero-based indexes corresponding to positions', () => {
    const q = new PowerQueue(4);
    q.push('a');
    q.push('b');
    q.push('c');
    expect(Array.from(q.keys())).toEqual([0, 1, 2]);
  });

  it('entries() yields [index, value] pairs non-destructively', () => {
    const q = new PowerQueue(4);
    q.push('x');
    q.push('y');
    expect(Array.from(q.entries())).toEqual([
      [0, 'x'],
      [1, 'y'],
    ]);
    // still intact
    expect(q.length).toBe(2);
  });

  it('toArray() returns a shallow FIFO snapshot without consuming', () => {
    const q = new PowerQueue(4);
    q.push(10);
    q.push(20);
    expect(q.toArray()).toEqual([10, 20]);
    expect(q.length).toBe(2);
  });

  it('drain() consumes the queue and yields items in FIFO order', () => {
    const q = new PowerQueue(4);
    q.push(7);
    q.push(8);
    const result = [];
    for (const v of q.drain()) result.push(v);
    expect(result).toEqual([7, 8]);
    expect(q.length).toBe(0);
  });

  it('iterators behave correctly on empty queue', () => {
    const q = new PowerQueue(4);
    expect(Array.from(q.values())).toEqual([]);
    expect(Array.from(q.keys())).toEqual([]);
    expect(Array.from(q.entries())).toEqual([]);
    expect(q.toArray()).toEqual([]);
    expect(Array.from(q.drain())).toEqual([]);
  });
});
