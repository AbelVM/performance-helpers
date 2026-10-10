import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * A worker that never replies. `postMessage` does nothing, so the task the pool
 * dispatched never completes and the pool stays busy for as long as the test
 * needs it to.
 *
 * This is the whole shape of the AUD-006 regression tests below. `drain()` has a
 * fast path that returns before *any* listener is registered when the pool is
 * already idle, so a test written against an idle pool observes zero listeners
 * whether or not the bug is present — it passes either way, which makes it
 * decoration. The pool has to be kept busy for the wait to be *abandoned*
 * (timeout or abort) rather than resolved, because abandoning is the path that
 * leaves the listener behind.
 */
class NeverReplies {
  constructor() {
    this.onmessage = null;
    this.postMessage = () => {};
    this.terminate = () => {};
  }
}

describe('PowerPool.drain()', () => {
  it('resolves immediately when pool is idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      const stats = await pool.drain();
      expect(stats).toBeDefined();
      expect(Array.isArray(stats.status)).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  it('resolves when the pool is terminated before becoming idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      // post a task that never completes so the pool stays busy
      pool.postMessage({ n: 1 });
      const drained = pool.drain();
      // terminate before the pool ever becomes idle
      pool.terminate();
      const stats = await drained;
      expect(stats).toBeDefined();
      expect(Array.isArray(stats.status)).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  it('resolves when shutdown() is called before the pool becomes idle', async () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    try {
      // post a task that never completes so the pool stays busy
      pool.postMessage({ n: 1 });
      const drained = pool.drain();
      // shutdown() must emit idle so the in-flight drain() resolves instead
      // of hanging forever (regression: shutdown did not emit idle).
      pool.shutdown();
      const stats = await drained;
      expect(stats).toBeDefined();
      expect(Array.isArray(stats.status)).toBe(true);
    } finally {
      pool.terminate();
    }
  });

  // --- AUD-006: the abort listener leaked on every non-abort exit -----------

  it('removes the abort listener when the wait times out (AUD-006)', async () => {
    // `release()` cleared the timer, decremented `_drainWaiters` and removed the
    // `idle` listener, but never removed the `abort` listener registered
    // alongside it. `{ once: true }` auto-removes a listener only when it
    // *fires*, so a wait that ended via `idle` or `timeout` left it attached —
    // and each retained one closes over `resolve`, `reject`, `timer` and `this`,
    // which is the entire pool.
    //
    // Reproduced at 5 retained listeners after 5 timed-out drains. With a
    // long-lived signal — a server-lifetime `AbortSignal`, or a framework that
    // reuses one across requests — that grows without bound and eventually trips
    // Node's max-listeners warning.
    const pool = new PowerPool(NeverReplies, { size: 1, idleTimeout: 1000 });
    const ac = new AbortController();
    try {
      // Keep the pool busy so the drain has to wait rather than take the
      // already-idle fast path.
      pool.postMessage({ n: 1 });
      for (let i = 0; i < 5; i++) {
        // The refusal code is a property, not part of the message — `poolRefusal`
        // builds `new Error(message)` and sets `err.code`.
        await expect(pool.drain({ signal: ac.signal, timeout: 20 })).rejects.toMatchObject({
          code: 'ERR_POOL_DRAIN_TIMEOUT',
        });
      }
      expect(getEventListeners(ac.signal, 'abort').length).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it('removes the abort listener when the pool becomes idle (AUD-006)', async () => {
    // The resolved path, which is the one the leak actually bit in production:
    // a drain that *succeeded* still left its abort listener behind, so a caller
    // draining in a loop against a shared signal accumulated one listener per
    // successful drain.
    //
    // An Echo worker rather than `NeverReplies`, because the wait has to end by
    // the pool going idle for this to be the resolved path at all.
    class Echo {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 1);
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Echo, { size: 1, idleTimeout: 1000 });
    const ac = new AbortController();
    try {
      pool.postMessage({ n: 1 });
      await pool.drain({ signal: ac.signal });
      expect(getEventListeners(ac.signal, 'abort').length).toBe(0);
    } finally {
      pool.terminate();
    }
  });

  it('does not leak the waiter slot when the wait is abandoned (AUD-006)', async () => {
    // The listener and the waiter slot are released by the same `release()`, so
    // a leak in one would show up as a leak in the other. This pins the counter
    // directly, because `_drainWaiters` is what `maxDrainWaiters` bounds and a
    // caller draining in a loop would otherwise be refused for listeners that
    // are no longer there.
    //
    // Mutation-checked: deleting the `this._drainWaiters--` in `release()` turns
    // this red. It is kept as the invariant guard rather than as a second copy of
    // the listener assertion above.
    const pool = new PowerPool(NeverReplies, { size: 1, idleTimeout: 1000 });
    const ac = new AbortController();
    try {
      pool.postMessage({ n: 1 });
      for (let i = 0; i < 5; i++) {
        await pool.drain({ signal: ac.signal, timeout: 20 }).catch(() => {});
      }
      expect(pool._drainWaiters).toBe(0);
    } finally {
      pool.terminate();
    }
  });
});
