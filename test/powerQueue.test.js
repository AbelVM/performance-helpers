import { describe, it, expect } from 'vitest';
import { PowerQueue } from '../src/helpers/powerQueue.js';

describe('PowerQueue', () => {
  it('push/shift preserves order and length updates', () => {
    const q = new PowerQueue(4);
    expect(q.length).toBe(0);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.length).toBe(3);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBeUndefined();
    expect(q.length).toBe(0);
  });

  it('grows capacity when full and preserves order', () => {
    const q = new PowerQueue(2);
    const pushed = [];
    for (let i = 0; i < 10; i++) {
      q.push(i);
      pushed.push(i);
    }
    expect(q.capacity).toBeGreaterThanOrEqual(10);
    const got = [];
    while (!q.isEmpty) got.push(q.shift());
    expect(got).toEqual(pushed);
  });

  it('peek returns next item without removing it', () => {
    const q = new PowerQueue(4);
    q.push('a');
    expect(q.peek()).toBe('a');
    expect(q.length).toBe(1);
    expect(q.shift()).toBe('a');
  });

  it('clear empties the queue', () => {
    const q = new PowerQueue(4);
    q.push(1);
    q.push(2);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.shift()).toBeUndefined();
  });
});
