import { expect } from 'chai';
import { describe, it } from 'vitest';
import { PowerChunker } from '../src/helpers/powerChunking.js';

describe('PowerChunking error handling', () => {
  it('emits per-item normalized error objects for sync throws and async rejections', async () => {
    const items = [1, 2, 3, 4];
    // 2 throws sync with code, 3 rejects async with code
    const fn = (item) => {
      if (item === 2) {
        const e = new Error('sync fail');
        e.code = 'SYNC_CODE';
        throw e;
      }
      if (item === 3) {
        const e = new Error('async fail');
        e.code = 'ASYNC_CODE';
        return Promise.reject(e);
      }
      return item * 10;
    };

    const pool = new PowerChunker(items, fn, { poolOptions: { size: 2 }, chunkSize: 2 });

    const chunkResults = [];
    pool.onmessage = (e) => {
      if (e && e.data) chunkResults.push(e.data);
    };

    await pool.drain();

    // flatten per-item results
    const all = chunkResults.flatMap((c) => c.results || []);

    // should contain two errors (SYNC_CODE and ASYNC_CODE) and two numeric results
    const codes = all
      .filter((r) => r && r.error)
      .map((r) => r.code)
      .sort();
    expect(codes).to.include('SYNC_CODE');
    expect(codes).to.include('ASYNC_CODE');

    const numbers = all.filter((r) => !r || !r.error);
    // two successful items 1 and 4 -> 10 and 40
    expect(numbers).to.include(10);
    expect(numbers).to.include(40);

    pool.terminate();
  });
});
