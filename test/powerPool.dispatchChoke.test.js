import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * POOL-004: one `_dispatchToWorker` choke point for every dispatch route.
 *
 * Three of the pool's P0 rows — `POOL-001`, `POOL-002`, `POOL-003` — turned out
 * to be *the same defect*: the post-and-account sequence existed in eight copies,
 * and each copy had dropped a different step. The framing marker, the
 * worker-association, and the preparation step are all things a caller must not be
 * able to forget, and a sequence in eight places is eight places to forget.
 *
 * **The first test is syntactic, and that is the point.** Three of the four
 * defects could have been re-introduced by adding a ninth call site, and no
 * behavioural test would notice until something broke on the wire again. A
 * property that can only be checked by reading the source should be checked by
 * reading the source.
 */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SOURCE = readFileSync(path.join(ROOT, 'src/helpers/powerPool.js'), 'utf8');

/** Accepts work and never answers. */
let last = null;
function Silent() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.posted = [];
  last = this;
  this.postMessage = (msg, transfer) => {
    this.posted.push(transfer ? { msg, transfer } : { msg });
  };
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}) {
  last = null;
  const pool = new PowerPool(Silent, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    maxTasksPerWorker: 1,
    queuePolicy: 'queue',
    awaitResponseTimeout: 0,
    ...options,
  });
  pools.push(pool);
  pool.worker = last;
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

describe('every dispatch goes through one choke point (POOL-004)', () => {
  it('is the only place a WorkerObj is posted to', () => {
    // The choke point's own two lines, and nothing else. A regex over the source
    // is the honest instrument here: the property is "there is exactly one call
    // site", and that is not something a behavioural test can see.
    const body = SOURCE.slice(
      SOURCE.indexOf('_dispatchToWorker(workerObj, prepared, options = {}) {')
    );
    const method = body.slice(0, body.indexOf('\n  }\n'));
    const posts = SOURCE.split('\n').filter(
      (l) => /\.worker\.postMessage\(|\bworker\.postMessage\(/.test(l) && !/^\s*\*/.test(l)
    );
    // Exactly the two lines inside the choke point.
    expect(posts.length).toBe(2);
    expect(method).toContain('worker.postMessage(item.message, item.transfer)');
    expect(method).toContain('worker.postMessage(item.message)');
  });

  it('does the accounting, so a caller cannot skip it', () => {
    // The four steps every copy used to have to remember, asserted on the method
    // rather than on any one caller.
    const start = SOURCE.indexOf('_dispatchToWorker(workerObj, prepared, options = {}) {');
    const method = SOURCE.slice(start, SOURCE.indexOf('\n  }\n', start));
    expect(method).toContain('prepared.deferred');
    expect(method).toContain('this._markPendingWorker(correlationId, workerObj.id)');
    expect(method).toContain('workerObj.tasks += 1');
    expect(method).toContain('this._activeTasks += 1');
  });

  it('counts a task and ties a pending response to the worker on every route', () => {
    // The behavioural net under the syntactic one: whichever route dispatched,
    // the observable accounting is the same.
    const pool = makePool();
    const before = pool.workers[0].tasks;
    pool.postMessage({ n: 1 });
    expect(pool.workers[0].tasks).toBe(before + 1);
    expect(pool.worker.posted).toHaveLength(1);

    const batched = makePool({ maxTasksPerWorker: Infinity });
    const beforeBatch = batched.workers[0].tasks;
    batched.postMessageBatch([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(batched.workers[0].tasks).toBe(beforeBatch + 3);
    expect(batched.worker.posted).toHaveLength(3);
  });

  it('frames a deferred item wherever it is dispatched from', () => {
    // `POOL-001` observed through the choke point rather than through the batch
    // fast path specifically, because the marker is now resolved in one place.
    const pool = makePool({ maxTasksPerWorker: Infinity });
    pool.postMessageBatch([{ a: 1 }, { b: 2 }]);
    for (const entry of pool.worker.posted) {
      const bytes = entry.msg;
      expect(bytes[0], 'a batched item reached the worker unframed').toBe(1);
    }
  });
});
