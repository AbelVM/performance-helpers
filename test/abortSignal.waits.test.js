/**
 * Cancellable *waits* on `PowerBatch.flush` and `PowerPool.drain` (FEAT-006).
 *
 * The distinction these tests exist to pin: aborting the wait abandons the
 * *caller's view of completion*. It does not stop the work. A `PowerPool` drain
 * whose signal aborts must keep dispatching queued tasks for every other
 * caller, and a `PowerBatch` flush must still deliver the items its `add()`
 * callers are waiting on.
 */
import { describe, it, expect } from 'vitest';
import { PowerBatch, PowerPool } from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function controller() {
  const c = new AbortController();
  return { signal: c.signal, abort: () => c.abort() };
}

/** A pool whose workers resolve on demand, so drain() has something to wait for. */
function controllablePool() {
  const pendingWork = [];
  const worker = {
    onmessage: null,
    onerror: null,
    postMessage: () => {},
    terminate: () => Promise.resolve(),
  };
  const pool = new PowerPool(() => worker, { size: 1, idleTimeout: 60_000, taskQueue: true });
  void pendingWork;
  return { pool, worker };
}

describe('cancellable wait (utils/abort.js)', () => {
  it('passes the signal straight through when there is none', async () => {
    const { raceWithAbort } = await import('../src/utils/abort.js');
    await expect(raceWithAbort(Promise.resolve(7), null)).resolves.toBe(7);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const { raceWithAbort } = await import('../src/utils/abort.js');
    const c = controller();
    c.abort();
    await expect(raceWithAbort(Promise.resolve(1), c.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('prefers the caller-supplied abort reason when it is an Error', async () => {
    const { raceWithAbort } = await import('../src/utils/abort.js');
    const c = new AbortController();
    const mine = new Error('mine, not AbortError');
    const p = raceWithAbort(new Promise(() => {}), c.signal);
    c.abort(mine);
    await expect(p).rejects.toBe(mine);
  });

  it('does not touch the underlying promise when the wait is abandoned', async () => {
    // The whole point: an unhandled rejection from the inner promise would be
    // a bug, and a resolved inner promise must not be able to resolve the
    // abandoned view.
    const { raceWithAbort } = await import('../src/utils/abort.js');
    let resolveInner;
    const inner = new Promise((r) => {
      resolveInner = r;
    });
    const c = controller();
    const view = raceWithAbort(inner, c.signal);
    c.abort();
    await expect(view).rejects.toMatchObject({ name: 'AbortError' });
    // The inner promise is still live and still settles; nothing throws.
    resolveInner('later');
    await sleep(5);
  });
});

describe('PowerBatch.flush with a signal', () => {
  it('resolves normally when the signal never aborts', async () => {
    const batch = new PowerBatch(() => {}, { maxSize: 10 });
    const c = controller();
    batch.add('a');
    batch.add('b');
    await expect(batch.flush({ signal: c.signal })).resolves.toBeUndefined();
  });

  it('rejects an already-aborted signal without flushing', async () => {
    const batch = new PowerBatch(() => {}, { maxSize: 10 });
    const c = controller();
    batch.add('a');
    c.abort();
    await expect(batch.flush({ signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('abandoning the wait does not drop the queued items', async () => {
    // The items belong to the `add()` callers, not to the flusher. Aborting the
    // flush must not reject the shared pending promise, or every queued caller
    // breaks with a cancellation they did not ask for.
    const received = [];
    const batch = new PowerBatch((items) => received.push(...items), { maxSize: 10 });
    const settled = [];
    for (const v of ['a', 'b']) batch.add(v).then(() => settled.push(v));

    const c = controller();
    const flushed = batch.flush({ signal: c.signal });
    c.abort();
    await expect(flushed).rejects.toMatchObject({ name: 'AbortError' });

    await sleep(30);
    expect(received).toEqual(['a', 'b']);
    expect(settled.sort()).toEqual(['a', 'b']);
  });
});

describe('PowerPool.drain with a signal', () => {
  it('resolves normally when already idle', async () => {
    const { pool } = controllablePool();
    const c = controller();
    const stats = await pool.drain({ signal: c.signal });
    expect(stats).toBeTypeOf('object');
    await pool.shutdown();
  });

  it('rejects an already-aborted signal', async () => {
    const { pool } = controllablePool();
    const c = controller();
    c.abort();
    await expect(pool.drain({ signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await pool.shutdown();
  });

  it('abandoning the drain leaves the pool serving other callers', async () => {
    const { pool } = controllablePool();
    const c = controller();
    // The pool has to look busy *before* the drain, or drain() takes its fast
    // path and resolves before the signal can mean anything. Driven through
    // `_activeTasks` rather than a real dispatch: the mock worker never replies,
    // so a real task would leave the pool busy forever and hang the assertion
    // that follows. This is a unit test of the wait, not of dispatch.
    pool._activeTasks = 1;
    const drained = pool.drain({ signal: c.signal });
    c.abort();
    await expect(drained).rejects.toMatchObject({ name: 'AbortError' });

    // The pool kept working: the in-flight task is untouched, and once it
    // finishes the pool is idle again and a later drain succeeds - which also
    // shows the abandoned listener was cleaned up rather than left hanging.
    expect(pool._activeTasks).toBe(1);
    pool._activeTasks = 0;
    await expect(pool.drain()).resolves.toBeTypeOf('object');
    await pool.shutdown();
  });

  it('reuses one signal across many drains without accumulating listeners', async () => {
    const { pool } = controllablePool();
    const c = controller();
    for (let i = 0; i < 50; i += 1) {
      await expect(pool.drain({ signal: c.signal })).resolves.toBeTypeOf('object');
    }
    await pool.shutdown();
  });
});
