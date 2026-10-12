import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * PISC-006: a pluggable load balancer.
 *
 * **The default policy is not replaced.** PowerPool's least-loaded-plus-EWMA rule
 * beats Piscina's for heterogeneous tasks, and the option exists to *add* a choice,
 * not to take one away. Omitting `loadBalancer` must behave exactly as before.
 *
 * **The per-worker view is a plain frozen object, not the live `WorkerObj`.** This is
 * the security-shaped half of the change and the reason the test is written before
 * the implementation: a caller-supplied balancer is caller code running *inside* the
 * pool. Handing it the live object hands it `worker.terminate()`, the pending-response
 * map and the `WorkerAgnostic` — everything needed to break the pool from a callback
 * the pool itself invokes. A frozen snapshot of four fields cannot do any of that.
 *
 * `latencyEwma` is exposed explicitly rather than left for a balancer to reach past
 * the view for, because the whole point of the view is that reaching past it is not
 * possible.
 */

/** A worker that never answers, so tasks stay in flight and the balancer is exercised. */
function Busy() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

/** A pool over fakes, created eagerly. */
function makePool(options = {}) {
  return new PowerPool(Busy, { size: 3, minSize: 3, maxSize: 3, lazy: false, ...options });
}

describe('PISC-006 the default policy is unchanged', () => {
  it('picks the least-loaded worker, and breaks ties on EWMA latency', () => {
    // The existing rule, pinned so that adding the option cannot quietly change it.
    const pool = makePool();
    const [a, b, c] = pool.workers;
    // All idle: the first wins, as before.
    expect(pool._findLeastLoadedWorker()).toBe(a);
    // `a` is now busiest, so the choice moves on.
    a.tasks = 2;
    expect(pool._findLeastLoadedWorker()).toBe(b);
    // Equal load, lower EWMA wins.
    b.tasks = 2;
    c.tasks = 2;
    b.latencyEwma = 50;
    c.latencyEwma = 10;
    expect(pool._findLeastLoadedWorker()).toBe(c);
  });

  it('is what runs when no loadBalancer is given', () => {
    const pool = makePool();
    const spy = vi.spyOn(pool, '_findLeastLoadedWorker');
    pool.postMessage({ n: 1 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('PISC-006 a caller-supplied balancer', () => {
  it('is called, and its choice is honoured', () => {
    const pool = makePool();
    const target = pool.workers[2];
    const balancer = vi.fn(() => target.id);
    pool._loadBalancer = balancer;
    pool.postMessage({ n: 1 });
    expect(balancer).toHaveBeenCalledTimes(1);
    expect(target.tasks, 'the chosen worker took the task').toBe(1);
  });

  it('may return the worker object rather than the id', () => {
    // Both spellings, because a balancer that just read the view has the id in hand
    // and one that kept a reference has the object. Refusing one would be a
    // needless sharp edge.
    const pool = makePool();
    const target = pool.workers[1];
    pool._loadBalancer = () => target;
    pool.postMessage({ n: 1 });
    expect(target.tasks).toBe(1);
  });

  it('falls back to the default when it returns nothing usable', () => {
    // A balancer that returns `null`, `undefined`, or an id that is not in the pool
    // must not break dispatch. Silently falling back is the only safe answer: the
    // alternative is throwing from inside the pool's own send path.
    const pool = makePool();
    for (const bad of [null, undefined, 9999, 'nonsense']) {
      pool._loadBalancer = () => bad;
      expect(() => pool.postMessage({ n: 1 })).not.toThrow();
    }
    expect(pool.getStats().activeTasks).toBeGreaterThan(0);
  });

  it('is not called when the pool has no workers', () => {
    const pool = makePool({ size: 0, minSize: 0, maxSize: 0, lazy: true });
    const balancer = vi.fn();
    pool._loadBalancer = balancer;
    pool.postMessage({ n: 1 });
    expect(balancer).not.toHaveBeenCalled();
  });
});

describe('PISC-006 the view a balancer receives', () => {
  it('is a plain frozen object, not the live WorkerObj', () => {
    // The security-shaped half. Asserted on the constructor and on frozenness,
    // because a live `WorkerObj` is neither plain nor frozen and carries
    // `terminate()`.
    const pool = makePool();
    let seen = null;
    pool._loadBalancer = (workers) => {
      seen = workers[0];
      return workers[0].id;
    };
    pool.postMessage({ n: 1 });

    expect(seen).not.toBeNull();
    expect(seen.constructor).toBe(Object);
    expect(Object.isFrozen(seen)).toBe(true);
    // And it carries none of the live object's handles.
    expect(seen.terminate).toBeUndefined();
    expect(seen.worker).toBeUndefined();
    expect(seen._agnostic).toBeUndefined();
  });

  it('exposes exactly the four fields a balancer needs, including latencyEwma', () => {
    // `latencyEwma` explicitly, rather than leaving a balancer to reach past the view
    // for it — the whole point of the view is that reaching past it is not possible.
    const pool = makePool();
    let seen = null;
    pool._loadBalancer = (workers) => {
      seen = workers[0];
      return workers[0].id;
    };
    pool.postMessage({ n: 1 });
    expect(Object.keys(seen).sort()).toEqual(['id', 'lastActive', 'latencyEwma', 'tasks']);
  });

  it('cannot be mutated to affect the pool', () => {
    // The consequence of frozenness, asserted end to end rather than by inspection:
    // a balancer that tries to rewrite the view must leave the pool's own accounting
    // untouched.
    const pool = makePool();
    const target = pool.workers[0];
    pool._loadBalancer = (workers) => {
      const view = workers[0];
      try {
        view.tasks = 999;
        view.id = 999;
      } catch {
        // Frozen in strict mode; silently ignored in sloppy mode. Either way the
        // pool must not notice.
      }
      return view.id;
    };
    pool.postMessage({ n: 1 });
    expect(target.tasks, 'the real worker count is unchanged').toBe(1);
    expect(target.id, 'and so is its id').toBe(pool.workers[0].id);
  });

  it('is a snapshot, so a later change to the worker is not visible through it', () => {
    // A view that aliased the live object would let a balancer observe — and be
    // confused by — mutations it did not cause.
    const pool = makePool();
    const views = [];
    pool._loadBalancer = (workers) => {
      views.push(workers[0]);
      return workers[0].id;
    };
    pool.postMessage({ n: 1 });
    pool.postMessage({ n: 2 });
    expect(views).toHaveLength(2);
    expect(views[0]).not.toBe(views[1]);
    expect(views[0].tasks).toBe(0);
    expect(views[1].tasks).toBe(1);
  });
});

describe('PISC-006 the read-only view in getStats()', () => {
  it('is exposed per worker, frozen, and carries latencyEwma', () => {
    // The same shape a balancer sees, so an operator debugging a custom policy reads
    // exactly what the policy read.
    const pool = makePool();
    pool.postMessage({ n: 1 });
    const workers = pool.getStats().workers;
    expect(Array.isArray(workers)).toBe(true);
    expect(workers).toHaveLength(3);
    for (const w of workers) {
      expect(w.constructor).toBe(Object);
      expect(Object.isFrozen(w)).toBe(true);
      expect(Object.keys(w).sort()).toEqual(['id', 'lastActive', 'latencyEwma', 'tasks']);
    }
  });
});
