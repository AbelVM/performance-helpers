import { expect } from 'chai';
import { describe, it } from 'vitest';
import { PowerChunker } from '../src/helpers/powerChunking.js';

describe('PowerChunking helper', () => {
  it('processes all items in chunks and returns processed counts (awaitResponse)', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i + 1);
    const processed = [];
    const fn = (item) => {
      processed.push(item);
    };
    const pool = new PowerChunker(items, fn, { poolOptions: { size: 2 } });
    expect(pool && typeof pool.postMessageBatch === 'function').to.equal(true);
    // wait until the pool has finished processing all chunks
    await pool.drain();
    // ensure the fn ran for each item
    expect(processed.length).to.equal(items.length);
    pool.terminate();
  });

  it('uses explicit chunkSize when provided', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const fn = () => {};
    const pool = new PowerChunker(items, fn, { poolOptions: { size: 2 }, chunkSize: 3 });
    // Each processed chunk emits one `message` event; wait for drain and verify
    let messageCount = 0;
    let totalProcessed = 0;
    pool.onmessage = (e) => {
      messageCount++;
      if (e && e.data && e.data.processed) totalProcessed += e.data.processed;
    };
    return pool.drain().then(() => {
      // Ensure all items were processed and at least the expected number of chunk messages occurred
      expect(totalProcessed).to.equal(items.length);
      expect(messageCount).to.be.at.least(Math.ceil(items.length / 3));
      pool.terminate();
    });
  });
});
