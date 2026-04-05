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
    await b.add('a');
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
});
