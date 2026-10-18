import { describe, it, expect } from 'vitest';
import { PowerChunker } from '../src/helpers/powerChunking.js';

describe('PowerChunker highWaterMark backpressure (S-15)', () => {
  it('accepts highWaterMark option', () => {
    function* g() {
      for (let i = 0; i < 5; i++) yield i;
    }
    const pool = new PowerChunker(g(), async () => 1, { chunkSize: 2, highWaterMark: 1 });
    expect(pool).toBeDefined();
    pool.terminate();
  });

  it('rejects unknown option', () => {
    function* g() {
      yield 1;
    }
    expect(() => new PowerChunker(g(), async () => 1, { foo: 1 })).toThrow();
  });
});
