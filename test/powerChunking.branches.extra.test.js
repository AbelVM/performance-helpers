import { describe, it, expect, vi } from 'vitest';
import { PowerChunker } from '../src/helpers/powerChunking.js';
import { PowerPool } from '../src/helpers/powerPool.js';
import { o2u8 } from '../src/helpers/powerBuffer.js';

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

  it('handles async item functions and preserves correlationId on direct pool posts', async () => {
    const pool = new PowerChunker([], async (item) => item * 2, { chunkSize: 2 });

    const payload = await new Promise((resolve) => {
      pool.onmessage = (e) => resolve(e.data);
      pool.postMessage({ chunk: [2, 4], correlationId: 'cid-1' });
    });

    expect(payload.processed).toBe(2);
    expect(payload.results).toEqual([4, 8]);
    expect(payload.correlationId).toBe('cid-1');
    pool.terminate();
  });

  it('continues streaming when pool.postMessage throws for a chunk', async () => {
    const original = PowerPool.prototype.postMessage;
    let calls = 0;

    PowerPool.prototype.postMessage = function patchedPostMessage(...args) {
      calls += 1;
      if (calls === 1) throw new Error('chunk dispatch failed');
      return original.apply(this, args);
    };

    try {
      function* values() {
        yield 1;
        yield 2;
        yield 3;
      }

      const seen = [];
      const pool = new PowerChunker(values(), (value) => value + 1, { chunkSize: 1 });
      pool.onmessage = (e) => {
        seen.push(...(e.data.results || []));
      };

      await pool.drain();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toContain(3);
      expect(seen).toContain(4);
      pool.terminate();
    } finally {
      PowerPool.prototype.postMessage = original;
    }
  });

  it('decodes transferable chunk payloads and supports inline worker add/remove listeners', async () => {
    const pool = new PowerChunker([], (value) => value + 1, {
      poolOptions: { size: 1, minSize: 1, lazy: false },
    });

    try {
      const worker = pool.workers[0].worker._underlying;
      const seen = [];
      const onMessage = (e) => seen.push(e.data);
      worker.addEventListener('message', onMessage);

      worker.postMessage(o2u8({ chunk: [2], correlationId: 'buf-1' }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(seen[0]).toMatchObject({
        processed: 1,
        results: [3],
        correlationId: 'buf-1',
      });

      worker.removeEventListener('message', onMessage);
      worker.postMessage(o2u8({ chunk: [5] }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(seen).toHaveLength(1);
    } finally {
      pool.terminate();
    }
  });

  it('routes inline worker failures to onerror and stops processing after terminate()', async () => {
    const pool = new PowerChunker([], (value) => value + 1, {
      poolOptions: { size: 1, minSize: 1, lazy: false },
    });

    try {
      const worker = pool.workers[0].worker._underlying;
      const errors = [];
      const messages = [];
      const onError = (err) => errors.push(err);
      worker.addEventListener('error', onError);
      worker.onmessage = () => {
        throw new Error('message handler failed');
      };

      worker.postMessage({ chunk: [1] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errors.some((err) => /message handler failed/.test(String(err && err.message)))).toBe(true);

      worker.onmessage = (e) => messages.push(e.data);
      worker.postMessage(o2u8(null));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errors.length).toBeGreaterThanOrEqual(2);

      worker.terminate();
      worker.postMessage({ chunk: [9] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages).toHaveLength(0);

      worker.removeEventListener('error', onError);
    } finally {
      pool.terminate();
    }
  });
});
