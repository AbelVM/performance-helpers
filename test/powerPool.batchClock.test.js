/**
 * POOL-006: a batched dispatch read the clock once per item.
 *
 * `_dispatchToWorker` takes `startTime` as a **default parameter**:
 * `const { correlationId, startTime = nowMs() } = options`. Every call that omits
 * it pays a clock read — and `postMessageBatch`'s loops called it per item, so a
 * batch of N cost N syscalls to stamp N tasks that all dispatch at the same
 * moment.
 *
 * `postMessage` and `broadcast` already hoisted the read, and both say why in a
 * comment ("capture a single timestamp for this dispatch to avoid multiple
 * syscalls"). The batch was the one path not given the same treatment, so this is
 * a consistency fix rather than a new idea: the four call sites now pass the
 * single `now` the method takes at the top.
 *
 * **A count, not a clock.** The count is exact, needs no threshold, and cannot
 * flake on a loaded machine — the same instrument TEST-001 established when it
 * replaced a `toBeLessThan(200)` that could not fail. Timing a `nowMs()` call
 * would be measuring the thing being removed, and at the harness's ~28% median
 * spread a duration could not separate one read from N reliably.
 *
 * Counting goes through `vi.mock` on the clock module, because `powerPool.js`
 * imports `nowMs` directly and a spy on the module namespace would not be seen by
 * the already-bound import.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

/** A minimal assertion shim so the static check reads like the runtime ones. */
function assert(cond, message) {
  expect(cond, message).toBe(true);
}

/** @type {Array<any>} */
const pools = [];

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
  vi.doUnmock('../src/utils/now.js');
  vi.resetModules();
});

/**
 * A fresh `PowerPool` whose `nowMs` is counted, plus a recording worker.
 *
 * `reads()` is the count, and `resetReads()` discards anything read during
 * construction so a test can measure only its own operation.
 *
 * @returns {Promise<{pool: any, worker: () => any, reads: () => number, resetReads: () => void}>}
 */
async function poolWithCountedClock() {
  let reads = 0;
  vi.resetModules();
  vi.doMock('../src/utils/now.js', async () => {
    const actual = await vi.importActual('../src/utils/now.js');
    return {
      ...actual,
      // A constant, so the shared `startTime` is observable as "a stamp", not as
      // a distinct time per item.
      nowMs: () => ((reads += 1), 1_000_000_000_000),
    };
  });
  const { PowerPool } = await import('../src/helpers/powerPool.js');

  /** @type {any} */
  let worker = null;
  function FakeWorker() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.tasks = 0;
    this.completedTasks = 0;
    this.id = 'w1';
    this._startTimes = [];
    this.posted = [];
    worker = this;
    this.postMessage = (msg) => {
      this.posted.push({ msg });
    };
    this.terminate = () => {};
    this.postMessageToWorker = this.postMessage;
  }

  const pool = new PowerPool(FakeWorker, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    maxTasksPerWorker: Infinity,
  });
  pools.push(pool);

  return {
    pool,
    worker: () => worker,
    reads: () => reads,
    resetReads: () => {
      reads = 0;
    },
  };
}

describe('POOL-006: one clock read per batch, not per item', () => {
  it('reads the clock once for a batch of many', async () => {
    const { pool, worker, reads, resetReads } = await poolWithCountedClock();
    const BATCH = 50;

    // Discard anything read during construction, so the count is the batch's.
    resetReads();
    pool.postMessageBatch(Array.from({ length: BATCH }, (_, i) => ({ message: { i } })));

    // The whole point: one syscall for the batch. Before the hoist, one per item.
    expect(reads()).toBe(1);
    // And every item really was dispatched, so the read was not hoisted by
    // skipping work — the mutation that would fake this fix.
    expect(worker().posted).toHaveLength(BATCH);
  });

  it('stamps every item of the batch with that one timestamp', async () => {
    // The shared `startTime` has to reach the worker for each item, or hoisting
    // the read would have broken the stamp rather than amortised it. `startTime`
    // is what feeds `_startTimes` and `lastActive`, which is what
    // `getStats().performance.timePerTask` reads.
    //
    // Read from `pool.workers[0]`, the pool's **wrapper**, not from the fake
    // `Worker` instance: `_dispatchToWorker` stamps `workerObj`, and `workerObj`
    // is the wrapper. The first version read `worker()._startTimes` off the fake
    // and got `[]` — the same "that is not the object" trap this repository has
    // hit before with `pool.workers[0].worker`.
    const { pool } = await poolWithCountedClock();
    const BATCH = 10;

    pool.postMessageBatch(Array.from({ length: BATCH }, (_, i) => ({ message: { i } })));

    const wrapper = pool.workers[0];
    expect(wrapper._startTimes).toHaveLength(BATCH);
    for (const stamp of wrapper._startTimes) {
      expect(typeof stamp).toBe('number');
    }
    // `lastActive` is stamped from the same value, so it must be a number too.
    expect(typeof wrapper.lastActive).toBe('number');
  });

  it('reads the clock once even for a single-item batch', async () => {
    // The boundary. A hoist that only fired for batches above some size would
    // pass the 50-item test and fail here.
    const { pool, reads, resetReads } = await poolWithCountedClock();
    resetReads();
    pool.postMessageBatch([{ message: { only: true } }]);
    expect(reads()).toBe(1);
  });

  it('an empty batch still costs one read, not zero', async () => {
    // Recorded as measured rather than as a target. The read is taken at method
    // entry, before the length is known, so an empty batch pays for it — which is
    // the same shape as every other hoisted read in this file, and worth pinning
    // because a future "optimisation" that moved it inside a length check would
    // otherwise be an invisible behaviour change.
    const { pool, reads, resetReads } = await poolWithCountedClock();
    resetReads();
    pool.postMessageBatch([]);
    expect(reads()).toBe(1);
  });
});

/**
 * Every dispatch inside the batch passes the hoisted stamp.
 *
 * The runtime test above only reaches the **single-worker fast path**, because
 * that is what `size: 1` and `maxTasksPerWorker: Infinity` select. Mutation
 * found the consequence: dropping `startTime` from the *fallback* site alone
 * left all four tests green, because that branch is never taken under this
 * setup. Three of the four call sites were therefore changed and unverified —
 * which is the same trap as a test that cannot fail, reached a different way.
 *
 * Reaching the multi-worker branches needs a saturated pool, a grow, and a
 * fallback, which is a lot of arrangement to assert one argument. A **static**
 * check over the method body is the honest instrument here: it is exactly the
 * invariant, it covers every site including the ones the runtime test cannot
 * reach, and it costs nothing. The repo already asserts on source text elsewhere
 * (`docsCodeAgreement.test.js` reads the guides; `verifyGate.test.js` reads
 * `verify.mjs`).
 */
describe('POOL-006: the hoist reaches every dispatch in the batch', () => {
  it('no dispatch inside postMessageBatch omits startTime', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(path.join(ROOT, 'src/helpers/powerPool.js'), 'utf8');

    // Slice out the method, not the file: `postMessage` and `broadcast` hoist
    // their own reads and are not what this row is about.
    const start = source.indexOf('  postMessageBatch(items, options) {');
    assert(start !== -1, 'postMessageBatch not found');
    const rest = source.slice(start);
    const end = rest.search(/\n {2}[a-zA-Z_#]/);
    const body = end === -1 ? rest : rest.slice(0, end);

    const calls = body.match(/this\._dispatchToWorker\([^)]*\)/g) ?? [];
    // Four sites: the single-worker fast path, the chosen-worker path, the
    // grow path, and the fallback.
    expect(calls.length).toBeGreaterThanOrEqual(4);

    const missing = calls.filter((call) => !call.includes('startTime: now'));
    expect(
      missing,
      'every dispatch in postMessageBatch must pass the hoisted `startTime`:\n' + missing.join('\n')
    ).toEqual([]);

    // And the hoist itself is at the top of the method, not inside a loop.
    const hoist = body.indexOf('const now = nowMs();');
    const firstLoop = body.indexOf('for (');
    expect(hoist, 'the hoisted read is missing').toBeGreaterThan(-1);
    expect(hoist, 'the read must precede the first loop').toBeLessThan(firstLoop);
  });
});
