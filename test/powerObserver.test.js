import { describe, it, expect } from 'vitest';
import { PowerObserver } from '../src/helpers/powerObserver.js';

describe('PowerObserver', () => {
  it('notifies subscribers asynchronously and returns unsubscribe', async () => {
    const obs = new PowerObserver(1);
    let called = 0;
    const unsub = obs.subscribe((next, prev) => {
      expect(prev).toBe(1);
      expect(next).toBe(2);
      called++;
    });
    obs.value = 2;
    await Promise.resolve();
    expect(called).toBe(1);
    unsub();
    obs.value = 3;
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it('clear removes all subscribers and size reflects count', () => {
    const obs = new PowerObserver('a');
    const sub = () => {};
    obs.subscribe(sub);
    obs.subscribe(() => {});
    expect(obs.size).toBe(2);
    obs.clear();
    expect(obs.size).toBe(0);
  });

  it('throws on invalid subscriber', () => {
    const obs = new PowerObserver(0);
    expect(() => obs.subscribe(null)).toThrow();
  });

  it('respects distinct and map options', async () => {
    const obs = new PowerObserver(2, { distinct: true, map: (v) => v % 2 });
    let calls = 0;
    obs.subscribe(() => {
      calls++;
    });
    obs.value = 4; // maps 0 -> previous 0 -> no notify
    await Promise.resolve();
    expect(calls).toBe(0);
    obs.value = 5; // maps 1 -> notify
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('allows setting map function via .map()', async () => {
    const obs = new PowerObserver(1);
    obs.map((v) => v * 2);
    let called = 0;
    obs.subscribe((n, p) => {
      expect(n).toBe(4);
      expect(p).toBe(2);
      called++;
    });
    obs.value = 2;
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it('supports sync delivery and swallows subscriber errors', () => {
    const obs = new PowerObserver(1, { async: false });
    const seen = [];
    obs.subscribe(() => {
      throw new Error('listener failed');
    });
    obs.subscribe((next, prev) => {
      seen.push([prev, next]);
    });

    obs.value = 2;

    expect(seen).toEqual([[1, 2]]);
  });

  it('coalesces multiple async writes into the latest next value while preserving the first prev', async () => {
    const obs = new PowerObserver(1);
    const seen = [];
    obs.subscribe((next, prev) => {
      seen.push([prev, next]);
    });

    obs.value = 2;
    obs.value = 3;
    await Promise.resolve();

    expect(seen).toEqual([[1, 3]]);
  });

  it('drain aliases flush and map(null) clears the mapping function', async () => {
    const obs = new PowerObserver(2, { async: 'macrotask', map: (v) => v * 2 });
    const seen = [];
    obs.subscribe((next, prev) => {
      seen.push([prev, next]);
    });

    obs.map(null);
    obs.value = 4;
    obs.drain();

    expect(seen).toEqual([[2, 4]]);
  });

  it('throws when map is set to a non-function value', () => {
    const obs = new PowerObserver(1);
    expect(() => obs.map(123)).toThrow('map must be a function');
  });

  it('supports macrotask scheduling and flush()', async () => {
    const obs = new PowerObserver(1, { async: 'macrotask' });
    let called = 0;
    obs.subscribe((n, p) => {
      expect(p).toBe(1);
      expect(n).toBe(2);
      called++;
    });
    obs.value = 2;
    // macrotask: microtask await won't observe it
    await Promise.resolve();
    expect(called).toBe(0);
    // flush synchronously
    obs.flush();
    expect(called).toBe(1);
  });
});
