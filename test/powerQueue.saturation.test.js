import { it, expect } from 'vitest';
import { PowerQueue } from '../src/helpers/powerQueue.js';

it('grows and preserves FIFO order under heavy pushMany usage', () => {
  const q = new PowerQueue(4);
  const N = 1000;
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = i;
  q.pushMany(arr);
  expect(q.length).toBe(N);
  // ensure capacity grew at least once
  expect(q.capacity).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < N; i++) {
    const v = q.shift();
    expect(v).toBe(i);
  }
  expect(q.length).toBe(0);
});
