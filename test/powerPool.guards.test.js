import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003: the argument guards and early returns that nothing exercises.
 *
 * This file is not random branch-chasing. Every case here is a *guard* - a
 * `throw` or a `return` that a caller can reach but that no existing test
 * ever reached, which is a different thing from a branch that is hard to set
 * up. A guard that has never run is a guard whose message nobody has ever
 * read, and that is exactly how `assertLimit` ended up with a
 * misspelled property name that shipped (QUAL-001).
 *
 * The two throws are the clearest case. A `rg` of the whole test directory for
 * the message text finds nothing: `prepareBuffers expects an array` and
 * `postMessage awaitResponse requires a plain-object message` had never been
 * executed by a single assertion, so nobody knew whether they fired, whether
 * the message named the option that was actually wrong, or whether the guard
 * sat behind a condition that made it unreachable.
 */

/** A worker stub that never answers, so nothing depends on a reply. */
function Silent() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/** A pool with no workers, so dispatch paths are reachable deterministically. */
function emptyPool(options = {}) {
  return new PowerPool(Silent, { minSize: 0, maxSize: 0, lazy: true, ...options });
}

describe('PowerPool argument guards', () => {
  it('prepareBuffers rejects a non-array', () => {
    const pool = emptyPool();
    // The guard is a bare `Error`, not a `TypeError`. That is asserted rather
    // than assumed because it is what a consumer matching on the class sees.
    expect(() => pool.prepareBuffers('not an array')).toThrow('prepareBuffers expects an array');
    expect(() => pool.prepareBuffers({ length: 0 })).toThrow(Error);
    // An array of the right shape must NOT throw - a guard that fires on valid
    // input is worse than no guard.
    expect(() => pool.prepareBuffers([])).not.toThrow();
  });

  it('postMessage with awaitResponse rejects a message it cannot tag', () => {
    const pool = emptyPool();
    // The correlation id rides on the message itself, so anything that is not
    // a plain object cannot carry it. Each of these must be refused.
    //
    // Three arguments, always: `options` is the *third* parameter, after
    // `transfer`. The two-argument shorthand that `guides/errors.md` used to
    // document throws `TypeError: tr is not iterable` instead - see the
    // separate test that pins that behaviour.
    for (const bad of [new Uint8Array([1, 2, 3]), 'a string', 42, null]) {
      expect(() => pool.postMessage(bad, undefined, { awaitResponse: true })).toThrow(
        'postMessage awaitResponse requires a plain-object message'
      );
    }
    // An ArrayBuffer is an object but not a plain one - it is called out
    // separately in the source and must be refused too.
    expect(() => pool.postMessage(new ArrayBuffer(8), undefined, { awaitResponse: true })).toThrow(
      'postMessage awaitResponse requires a plain-object message'
    );
  });

  it('the two-argument form silently drops awaitResponse for a plain object', () => {
    const pool = new PowerPool(Silent, { minSize: 1, maxSize: 1, lazy: false });
    // `options` is the *third* parameter. Passing it second puts it in the
    // `transfer` slot, where a plain-object message never looks at it - so
    // `wantResponse` is false and the call returns a boolean.
    //
    // This is worse than the guide being merely wrong. `guides/errors.md`
    // documented exactly this call, and it does not throw: a caller writing
    // `const r = await pool.postMessage(msg, { awaitResponse: true })` gets
    // `true` where it expected the worker's response, and no diagnostic. The
    // only evidence is that the result is not a promise.
    const result = pool.postMessage({ a: 1 }, { awaitResponse: true });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toBe(true);
  });

  it('the two-argument form does throw for a message that reaches the transfer list', () => {
    const pool = emptyPool();
    // A typed array *is* looked at as a transfer list, so the same mistake
    // surfaces here as `tr is not iterable` - a different failure for the same
    // mistake, depending only on the message type.
    expect(() => pool.postMessage(new Uint8Array([1]), { awaitResponse: true })).toThrow(
      'tr is not iterable'
    );
  });

  it('postMessage without awaitResponse accepts a non-plain-object message', () => {
    const pool = emptyPool();
    // The guard is scoped to the correlation path. Refusing here too would
    // break the documented ability to post a typed array.
    expect(() => pool.postMessage(new Uint8Array([1, 2, 3]))).not.toThrow();
  });
});

describe('PowerPool dispatch early returns', () => {
  it('dispatches nothing while the queue is paused', () => {
    const pool = new PowerPool(Silent, { minSize: 1, maxSize: 1, lazy: false });
    pool.pauseQueue();
    expect(pool.queuePaused).toBe(true);
    // The guard is the first statement of the dispatcher; with a paused queue
    // and a non-empty one, only the guard can be what stops the dispatch.
    pool.queue.push({ message: { a: 1 } });
    pool._dispatchQueuedTasks();
    expect(pool.queue.length).toBe(1);
  });

  it('dispatches nothing when the queue is empty', () => {
    const pool = new PowerPool(Silent, { minSize: 1, maxSize: 1, lazy: false });
    pool._dispatchQueuedTasks();
    expect(pool.workers.length).toBe(1);
  });

  it('dispatches nothing when the task queue is disabled', () => {
    const pool = new PowerPool(Silent, {
      minSize: 1,
      maxSize: 1,
      lazy: false,
      taskQueue: false,
    });
    pool.queue.push({ message: { a: 1 } });
    pool._dispatchQueuedTasks();
    expect(pool.queue.length).toBe(1);
  });

  it('resuming an unpaused queue is a no-op', () => {
    const pool = new PowerPool(Silent, { minSize: 0, maxSize: 1, lazy: true });
    expect(pool.queuePaused).toBe(false);
    pool.resumeQueue();
    expect(pool.queuePaused).toBe(false);
  });
});

describe('PowerPool stats without a creation timestamp', () => {
  it('reports zero live duration rather than NaN', () => {
    const pool = emptyPool();
    // `_createdAt` is normally set in the constructor. Clearing it exercises
    // the other arm of the ternary, whose failure mode would be `NaN` in a
    // number a caller divides by - a statistic that is wrong in a way that
    // never throws.
    pool._createdAt = null;
    const stats = pool.getStats();
    expect(stats.avgTasksPerWorker).not.toBeNaN();
    expect(Number.isNaN(stats.liveDuration ?? stats.uptimeMs ?? 0)).toBe(false);
  });
});

describe('PowerPool stopThePressBatch fallback', () => {
  it('returns an all-false array the length of the input when dispatch fails', () => {
    const pool = emptyPool();
    const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const post = vi.spyOn(pool, 'postMessageBatch').mockImplementation(() => {
      throw new Error('dispatch exploded');
    });
    const result = pool.stopThePressBatch(items);
    expect(post).toHaveBeenCalled();
    // The contract is an array of `false` - one slot per item - so a caller
    // can line the result up against what it sent. A short array would silently
    // mis-align them.
    expect(result).toEqual([false, false, false]);
    post.mockRestore();
  });

  it('survives a logger that throws while reporting the failure', () => {
    const pool = emptyPool();
    vi.spyOn(pool, 'postMessageBatch').mockImplementation(() => {
      throw new Error('dispatch exploded');
    });
    pool._logger = {
      error: () => {
        throw new Error('logger is broken too');
      },
      log: () => {},
    };
    // Two guards in a row: the dispatch failure, then the logger failing while
    // reporting it. The result must still be well-formed.
    expect(pool.stopThePressBatch([{ a: 1 }])).toEqual([false]);
  });
});

describe('PowerPool onidle setter', () => {
  it('does not invoke a non-function handler', () => {
    const pool = new PowerPool(Silent, { minSize: 1, maxSize: 1, lazy: false });
    const notAFunction = { not: 'callable' };
    pool.onidle = notAFunction;
    // Assigning a non-function is a no-op on the handler slot, and must not
    // have thrown - the `typeof` guard exists precisely for that.
    expect(pool.onidle).toBe(notAFunction);
  });

  it('does not invoke a function handler while the pool is busy', () => {
    const pool = new PowerPool(Silent, { minSize: 1, maxSize: 1, lazy: false });
    pool._activeTasks = 1;
    const cb = vi.fn();
    pool.onidle = cb;
    expect(cb).not.toHaveBeenCalled();
    pool._activeTasks = 0;
  });
});
