import { describe, it, expect } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

describe('PowerCache getOrSetAsync inflight dedupe', () => {
  it('counts a single miss for concurrent inflight factories', async () => {
    const c = new PowerCache();
    let runs = 0;
    const factory = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    };

    const p1 = c.getOrSetAsync('k', factory);
    const p2 = c.getOrSetAsync('k', factory);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    // only one factory invocation
    expect(runs).toBe(1);
    // only one recorded miss
    expect(c.misses).toBe(1);
  });
});
