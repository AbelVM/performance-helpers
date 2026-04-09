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

  it('surfaces batch dispatch failures via pool error listeners', async () => {
    const pool = new PowerChunker([1, 2, 3], (item) => item, {
      chunkSize: 1,
      poolOptions: {
        size: 1,
        minSize: 1,
        maxSize: 1,
        maxTasksPerWorker: 0,
        taskQueue: true,
        queuePolicy: 'reject',
        lazy: false,
      },
    });

    const errors = [];
    pool.addEventListener('error', (err) => errors.push(err));

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors.length).to.be.greaterThan(0);
    expect(errors[0]).to.include({ code: 'ECHUNKDISPATCH', mode: 'batch' });

    pool.terminate();
  });

  it('reports global failed chunk indexes across array dispatch windows', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i + 1);
    const pool = new PowerChunker(items, (item) => item, {
      chunkSize: 1,
      poolOptions: {
        size: 1,
        minSize: 1,
        maxSize: 1,
        maxTasksPerWorker: 0,
        taskQueue: true,
        queuePolicy: 'reject',
        lazy: false,
      },
    });

    const errors = [];
    pool.addEventListener('error', (err) => errors.push(err));

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const batchErrors = errors.filter(
      (err) => err && err.code === 'ECHUNKDISPATCH' && err.mode === 'batch'
    );
    expect(batchErrors.length).to.be.greaterThan(0);
    for (const err of batchErrors) {
      expect(Array.isArray(err.failedChunks)).to.equal(true);
      for (const idx of err.failedChunks) {
        expect(Number.isInteger(idx)).to.equal(true);
        expect(idx).to.be.at.least(0);
        expect(idx).to.be.below(items.length);
      }
    }

    pool.terminate();
  });

  it('surfaces stream dispatch failures via pool error listeners', async () => {
    function* items() {
      yield 1;
      yield 2;
      yield 3;
    }

    const pool = new PowerChunker(items(), (item) => item, {
      chunkSize: 1,
      poolOptions: {
        size: 1,
        minSize: 1,
        maxSize: 1,
        maxTasksPerWorker: 0,
        taskQueue: true,
        queuePolicy: 'reject',
        lazy: false,
      },
    });

    const errors = [];
    pool.addEventListener('error', (err) => errors.push(err));

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      errors.some((err) => err && err.code === 'ECHUNKDISPATCH' && err.mode === 'stream')
    ).to.equal(true);

    pool.terminate();
  });

  it('emits stream-iterate errors when the input iterable throws', async () => {
    function* badItems() {
      yield 1;
      throw new Error('iter boom');
    }

    const pool = new PowerChunker(badItems(), (item) => item, {
      chunkSize: 1,
      poolOptions: {
        size: 1,
        minSize: 1,
        maxSize: 1,
        taskQueue: true,
        queuePolicy: 'enqueue',
        lazy: false,
      },
    });

    const errors = [];
    pool.addEventListener('error', (err) => errors.push(err));

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      errors.some((err) => err && err.code === 'ECHUNKDISPATCH' && err.mode === 'stream-iterate')
    ).to.equal(true);

    pool.terminate();
  });
});
