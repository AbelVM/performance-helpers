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
});
