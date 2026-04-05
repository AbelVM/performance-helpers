import { describe, it, expect } from 'vitest';
import { PowerChunker } from '../src/helpers/powerChunking.js';

describe('PowerChunker branches extra', () => {
  it('throws when missing iterable or fn not function', () => {
    expect(() => new PowerChunker(null, () => {})).toThrow();
    expect(() => new PowerChunker([1, 2, 3], null)).toThrow();
  });

  it('processes array and emits error objects for thrown items', async () => {
    const items = [1, 2, 3];
    const messages = [];
    const pool = new PowerChunker(
      items,
      (item) => {
        if (item === 2) throw new Error('boom');
        return item * 2;
      },
      { chunkSize: 2 }
    );
    pool.onmessage = (e) => messages.push(e.data);
    await pool.drain();
    // At least one message should contain an error result for the thrown item
    const allResults = messages.flatMap((m) => m.results || []);
    expect(allResults.some((r) => r && r.error)).toBe(true);
  });

  it('streams an iterator and returns the pool instance when iterable throws', async () => {
    function* badGen() {
      yield 1;
      yield 2;
      throw new Error('stream fail');
    }
    const pool = new PowerChunker(badGen(), (n) => n + 1);
    // ensure we get a pool back and drain resolves without throwing
    expect(pool).toBeTruthy();
    await pool.drain();
  });
});
