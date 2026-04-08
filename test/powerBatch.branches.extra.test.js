import { describe, it, expect } from 'vitest';
import { PowerBatch } from '../src/helpers/powerBatch.js';

describe('PowerBatch branches extra', () => {
  it('constructor throws when handler not a function', () => {
    expect(() => new PowerBatch(null)).toThrow();
  });

  it('flush returns resolved promise when empty and not scheduled', async () => {
    const b = new PowerBatch(async () => {});
    // ensure empty
    expect(b.size).toBe(0);
    const res = await b.flush();
    expect(res).toBeUndefined();
  });

  it('add schedules handler and resolves regular add promise', async () => {
    let called = false;
    const b = new PowerBatch(async (items) => {
      called = true;
      expect(items.length).toBeGreaterThan(0);
    });
    const p = b.add(1);
    await p;
    // wait a tick for handler
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(true);
  });

  it('flush returns a promise that rejects when handler throws', async () => {
    const b = new PowerBatch(async () => {
      throw new Error('boom');
    });
    b.add(1);
    await expect(b.flush()).rejects.toThrow('boom');
  });

  it('clear rejects pending add promises and empties queue', async () => {
    let called = false;
    const b = new PowerBatch(async () => {
      called = true;
    });
    const promise = b.add(1);
    b.clear();
    await expect(promise).rejects.toThrow('PowerBatch cleared before flush');
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
    expect(b.size).toBe(0);
  });

  it('creates a fresh pending batch for items added while the handler is running', async () => {
    const calls = [];
    let releaseFirstBatch;
    const firstBatchGate = new Promise((resolve) => {
      releaseFirstBatch = resolve;
    });

    const b = new PowerBatch(async (items) => {
      calls.push(items.slice());
      if (calls.length === 1) {
        await firstBatchGate;
      }
    });

    const first = b.add('a');
    await Promise.resolve();
    const second = b.add('b');
    releaseFirstBatch();

    await Promise.all([first, second]);

    expect(calls).toEqual([['a'], ['b']]);
  });

  it('normalizes invalid maxSize and scheduling options', async () => {
    const calls = [];
    const b = new PowerBatch(
      async (items) => {
        calls.push(items.slice());
      },
      { maxSize: 0, scheduling: 'invalid' }
    );

    b.add(1);
    b.add(2);
    await b.flush();

    expect(calls).toEqual([[1, 2]]);
  });

  it('flush re-schedules queued work if a pending batch exists but the scheduler was canceled', async () => {
    const calls = [];
    const b = new PowerBatch(async (items) => {
      calls.push(items.slice());
    });

    const addPromise = b.add('x');
    b._scheduler.cancel();

    await b.flush();
    await addPromise;

    expect(calls).toEqual([['x']]);
  });

  it('resolves orphaned pending promises on empty internal runs and rethrows handler errors without pending state', async () => {
    const b = new PowerBatch(async () => {});
    const pending = b.add('x');
    b._queue.clear();

    await b._runBatch();
    await expect(pending).resolves.toBeUndefined();
    expect(b._pending).toBeNull();

    const b2 = new PowerBatch(async () => {
      throw new Error('boom');
    });
    b2._queue.push('y');

    await expect(b2._runBatch()).rejects.toThrow('boom');
  });
});
