import { describe, it, expect } from 'vitest';
import { PowerBatch } from '../src/helpers/powerBatch.js';

describe('PowerBatch', () => {
  it('coalesces synchronous adds into a single handler call', async () => {
    const calls = [];
    const handler = async (items) => {
      calls.push(items.slice());
    };
    const b = new PowerBatch(handler);
    b.add(1);
    b.add(2);
    await b.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([1, 2]);
  });

  it('flushes immediately when maxSize is reached', async () => {
    const calls = [];
    const handler = (items) => calls.push(items.slice());
    const b = new PowerBatch(handler, { maxSize: 2 });
    b.add('a');
    await b.add('b'); // this should trigger immediate flush
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['a', 'b']);
  });

  it('flush waits for async handler completion', async () => {
    const calls = [];
    const handler = async (items) => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push(items.slice());
    };
    const b = new PowerBatch(handler);
    b.add(42);
    await b.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([42]);
  });

  it('add returns a promise that resolves after the handler completes', async () => {
    const calls = [];
    const handler = async (items) => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push(items.slice());
    };
    const b = new PowerBatch(handler);
    const promise = b.add('x');
    expect(promise).toBeInstanceOf(Promise);
    await promise;
    expect(calls).toEqual([['x']]);
  });

  it('add resolves after async handler completion when maxSize triggers immediate flush', async () => {
    const calls = [];
    const handler = async (items) => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push(items.slice());
    };
    const b = new PowerBatch(handler, { maxSize: 2 });
    const promise = b.add('a');
    const promise2 = b.add('b');
    expect(promise).toBeInstanceOf(Promise);
    expect(promise2).toBeInstanceOf(Promise);
    await Promise.all([promise, promise2]);
    expect(calls).toEqual([['a', 'b']]);
  });

  it('accepts scheduling option (macrotask) and preserves basic behavior', async () => {
    const calls = [];
    const handler = (items) => calls.push(items.slice());
    const b = new PowerBatch(handler, { scheduling: 'macrotask' });
    b.add('x');
    b.add('y');
    await b.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['x', 'y']);
  });
});
