/**
 * GAP-008: `PowerCrossLock`, over the platform's Web Locks implementation.
 *
 * ## What these tests are actually for
 *
 * The plan row's premise was **half wrong and has to be pinned here**, because a wrapper
 * written to the row's spelling would not have worked at all: it named
 * `locks.acquire(name, {steal, signal})`, and `acquire` is an *earlier Web Locks draft*.
 * What ships in Node 24.18 and in Chromium and Firefox is `LockManager.request`. Measured:
 * `worker_threads.locks` exposes exactly `request` and `query` on its prototype and
 * `acquire` is `undefined`.
 *
 * The row also listed `steal: true` pre-emption as a plain capability. It is not a polite
 * hand-over, and `describe('steal')` below pins what it actually does — including the
 * part that makes it dangerous, which is the reason this helper documents it rather than
 * burying it.
 *
 * Counters, orderings and shapes throughout. **No durations**: the harness measures a
 * ~29 % timing spread, and every claim here is a fact about what ran.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { PowerCrossLock, hasCrossWorkerLocks } from '../src/helpers/powerCrossLock.js';

/**
 * Let queued microtasks and lock-manager bookkeeping settle.
 *
 * A fixed tick rather than a duration assertion: the tests below assert *what* happened,
 * and this only has to be long enough for the platform to have done it.
 *
 * @param {number} [ms=10]
 * @returns {Promise<void>}
 */
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/**
 * The platform probe the whole suite rides on. `PowerCrossLock` wraps Web Locks
 * (`node:worker_threads.locks` on Node 24, `navigator.locks` in a browser), and
 * **the floor has none**: `require('node:worker_threads').locks` is `undefined`
 * on Node 22.12, so `hasCrossWorkerLocks()` returns `false` and every lock
 * operation throws "this platform has no cross-worker lock manager". The suite
 * is therefore `skipUnless`d on this probe rather than run and fail — a helper
 * that cannot run is still a helper, and its `supported` flag is the contract a
 * caller checks before relying on it.
 */
const HAS_LOCKS = hasCrossWorkerLocks();

describe('PowerCrossLock support probe', () => {
  // Ungated and separate from the suite below on purpose: this is the one
  // assertion that must hold on *every* runtime the library supports, including
  // the floor, and it is the thing a caller reads before calling `run()`.
  it('reports support, and agrees with the platform probe', async () => {
    expect(hasCrossWorkerLocks()).toBe(HAS_LOCKS);
    expect(new PowerCrossLock().supported).toBe(HAS_LOCKS);
    if (!HAS_LOCKS) {
      // The documented residual, pinned rather than asserted away: without a
      // manager there is no cross-worker answer, and `run()` says so.
      await expect(new PowerCrossLock().run('x', () => {})).rejects.toThrow(
        /no cross-worker lock manager/
      );
    }
  });
});

const describeWithLocks = HAS_LOCKS ? describe : describe.skip;
describeWithLocks('PowerCrossLock', () => {
  it('runs the section, and returns what it returned', async () => {
    const lock = new PowerCrossLock();
    const seen = [];
    const result = await lock.run('basic', () => {
      seen.push('inside');
      return 'returned';
    });
    expect(seen).toEqual(['inside']);
    expect(result).toBe('returned');
    expect(lock.stats().acquisitions).toBe(1);
  });

  it('serialises two sections on the same name', async () => {
    // The whole point. Asserted as **non-overlap**, not as a duration: each section records
    // that it was the only one inside.
    const lock = new PowerCrossLock();
    const order = [];
    let concurrent = 0;
    let overlapped = false;

    const section = (tag) =>
      lock.run('serial', async () => {
        concurrent += 1;
        if (concurrent > 1) overlapped = true;
        order.push(`${tag}:in`);
        await settle(5);
        order.push(`${tag}:out`);
        concurrent -= 1;
      });

    await Promise.all([section('a'), section('b')]);
    expect(overlapped, 'two sections were inside at once').toBe(false);
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
    lock.dispose();
  });

  it('releases the lock when the section throws', async () => {
    // A leaked lock is the failure this helper's callback shape exists to make impossible,
    // so it is asserted rather than assumed: after a throw, a second acquisition must succeed.
    const lock = new PowerCrossLock();
    await expect(
      lock.run('throwing', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const after = await lock.run('throwing', () => 'acquired');
    expect(after).toBe('acquired');
  });

  it('releases the lock when the section rejects', async () => {
    // The async half of the same property. A bare try/catch only catches a synchronous
    // throw, so a rejected promise is the shape that would actually have leaked.
    const lock = new PowerCrossLock();
    await expect(
      lock.run('rejecting', async () => Promise.reject(new Error('nope')))
    ).rejects.toThrow('nope');
    expect(await lock.run('rejecting', () => 'acquired')).toBe('acquired');
  });

  describe('steal', () => {
    it('takes the lock from a holder that is still running', async () => {
      // **The measured hazard, pinned.** `steal: true` is not a queue hand-over: the
      // thief's section runs *while the previous holder's section is still going*, and the
      // previous holder's `run()` promise rejects with `AbortError`.
      //
      // Recorded shape from Node 24.18:
      //   holder acquired          true
      //   thief section ran        true
      //   holder promise rejected  AbortError/20
      //   holder's own work finished  false   <- the work is orphaned, not stopped
      const lock = new PowerCrossLock();
      let releaseHolder;
      const held = new Promise((r) => {
        releaseHolder = r;
      });
      let holderWorkFinished = false;
      let holderError = null;

      const holder = lock
        .run('stolen', () =>
          held.then(() => {
            holderWorkFinished = true;
          })
        )
        .catch((e) => {
          holderError = e;
        });
      await settle();

      const stolen = await lock.run('stolen', () => 'thief-section', { steal: true });
      expect(stolen, 'the thief got the lock').toBe('thief-section');
      expect(holderError && holderError.name, 'the holder is told it lost').toBe('AbortError');
      expect(
        holderWorkFinished,
        "and the holder's work is still running — the lock is free before it stops"
      ).toBe(false);

      releaseHolder();
      await holder;
      expect(holderWorkFinished, 'the orphaned work does finish, afterwards').toBe(true);
      expect(lock.stats().steals).toBe(1);
      lock.dispose();
    });

    it('gives the stolen holder nothing to identify which lock it lost', async () => {
      // Checked on Node 24.18 and it is the reason the guide tells callers to make the
      // section idempotent rather than to react: the `AbortError` carries **no lock name
      // and no own properties**, so a holder cannot distinguish a steal from its own
      // `signal` abort by inspecting the error.
      const lock = new PowerCrossLock();
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      let err = null;
      const holder = lock
        .run('unidentifiable', () => held)
        .catch((e) => {
          err = e;
        });
      await settle();
      await lock.run('unidentifiable', () => 'taken', { steal: true });

      expect(err).toBeTruthy();
      expect(err.name).toBe('AbortError');
      expect(err.lock, 'no lock name on the error').toBeUndefined();
      expect(Object.keys(err), 'no own properties at all').toEqual([]);
      release();
      await holder;
      lock.dispose();
    });

    it('rejects a non-boolean steal rather than coercing it', async () => {
      const lock = new PowerCrossLock();
      await expect(lock.run('s', () => {}, { steal: 'yes' })).rejects.toThrow(TypeError);
      await expect(lock.run('s', () => {}, { steal: 1 })).rejects.toThrow(TypeError);
      lock.dispose();
    });

    it('does not pass steal when it is false', async () => {
      // `steal: false` must behave exactly like omitting it, so a caller can compute the
      // flag from a condition and pass it unconditionally. Asserted as *blocking*: the
      // second section is queued rather than admitted, which is the observable difference
      // from `steal: true` and the reason this assertion is not "both return".
      const lock = new PowerCrossLock();
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      let holderError = null;
      const holder = lock
        .run('no-steal', () => held)
        .catch((e) => {
          holderError = e;
        });
      await settle();

      let ran = false;
      const blocked = lock.run(
        'no-steal',
        () => {
          ran = true;
        },
        { steal: false }
      );
      await settle();
      expect(ran, 'the second section waits rather than stealing').toBe(false);

      release();
      await holder;
      await blocked;
      expect(ran, 'and runs once the holder lets go').toBe(true);
      expect(holderError, 'and the holder was not displaced').toBe(null);
      expect(lock.stats().steals, 'false is not counted as a steal').toBe(0);
      lock.dispose();
    });
  });

  describe('signal', () => {
    it('cancels the wait without invoking the section', async () => {
      const lock = new PowerCrossLock();
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      let holderError = null;
      const holder = lock
        .run('signalled', () => held)
        .catch((e) => {
          holderError = e;
        });
      await settle();

      const ac = new AbortController();
      let sectionRan = false;
      const waiter = lock.run(
        'signalled',
        () => {
          sectionRan = true;
        },
        { signal: ac.signal }
      );
      await settle();
      ac.abort();

      await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
      expect(sectionRan, 'an aborted waiter never enters the section').toBe(false);
      expect(holderError, 'and the holder is untouched').toBe(null);
      expect(lock.stats().aborted).toBe(1);
      release();
      await holder;
      lock.dispose();
    });

    it('rejects a non-signal rather than ignoring it', async () => {
      // A `signal` that is not a signal would be a silent no-op on the cancel path, which
      // is the same failure mode as a misspelled option.
      const lock = new PowerCrossLock();
      await expect(lock.run('s', () => {}, { signal: 'abort' })).rejects.toThrow(TypeError);
      await expect(lock.run('s', () => {}, { signal: null })).rejects.toThrow(TypeError);
      lock.dispose();
    });
  });

  describe('query', () => {
    it('reports who holds a lock and who is queued for it — in this thread', async () => {
      // **Scoped to this thread, which is the finding this test pins.** Measured on Node
      // 24.18: a lock held in a `Worker` is **invisible** to the main thread's `query()`
      // — `held: []` — while the worker's own `query()` sees it. So `query()` answers
      // "what is *my* thread doing here", not "who has this lock in the process", and the
      // cross-worker guarantee rests on `request()` alone.
      const lock = new PowerCrossLock();
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      const holder = lock.run('watched', () => held);
      await settle();

      const waiter = lock.run('watched', () => 'waited');
      await settle();

      const q = await lock.query('watched');
      expect(q.held.length, 'this thread is the holder').toBe(1);
      expect(q.held[0].name).toBe('watched');
      expect(q.pending.length, 'this thread is also the waiter').toBe(1);
      expect(await lock.waiterCount('watched')).toBe(1);

      const all = await lock.query();
      expect(all.held.length + all.pending.length).toBeGreaterThanOrEqual(2);

      release();
      await holder;
      await waiter;
      lock.dispose();
    });

    it('is empty for a lock this thread has not taken', async () => {
      const lock = new PowerCrossLock();
      expect(await lock.waiterCount('never-taken')).toBe(0);
      expect(await lock.query('never-taken')).toEqual({ held: [], pending: [] });
      lock.dispose();
    });

    it('does not see a lock held by another thread', async () => {
      // The negative half of the per-thread finding, asserted against a real Worker so
      // that a future change making `query()` cross-thread would fail here rather than
      // silently report more.
      const src = `
        const { parentPort, locks } = require('node:worker_threads');
        let rel = null;
        parentPort.on('message', async (m) => {
          if (m.op === 'hold') {
            const gate = new Promise((r) => { rel = r; });
            locks.request(m.name, async () => gate);
            parentPort.postMessage({ op: 'holding' });
          } else if (m.op === 'query') {
            const r = await locks.query();
            parentPort.postMessage({ op: 'q', held: r.held.map((x) => x.name) });
          } else if (m.op === 'go') {
            if (rel) rel();
          }
        });
      `;
      const worker = new Worker(src, { eval: true });
      const holding = new Promise((r) => {
        const h = (m) => {
          if (m.op === 'holding') {
            worker.off('message', h);
            r(m);
          }
        };
        worker.on('message', h);
      });
      const queried = new Promise((r) => {
        const h = (m) => {
          if (m.op === 'q') {
            worker.off('message', h);
            r(m);
          }
        };
        worker.on('message', h);
      });
      try {
        worker.postMessage({ op: 'hold', name: 'cross-thread' });
        await holding;
        await settle(20);
        const mainQ = await new PowerCrossLock().query('cross-thread');
        expect(
          mainQ.held.map((x) => x.name),
          'the main thread cannot see the worker holding'
        ).toEqual([]);
        worker.postMessage({ op: 'query' });
        expect((await queried).held, "the worker's own query sees it").toEqual(['cross-thread']);
      } finally {
        worker.postMessage({ op: 'go' });
        await worker.terminate();
      }
    });
  });

  describe('cross-worker', () => {
    it('blocks a second thread until the worker releases', async () => {
      // **The property the class exists for**, against a **real** `Worker`: a fake cannot
      // show it, because the whole claim is that the lock is shared across threads — and
      // faking the worker would have asserted nothing about that.
      //
      // Deliberately built without `ifAvailable`, which this platform ignores (see the
      // class docblock). The assertion is **blocking** — the main thread's section has not
      // run while the worker holds the name, and runs once it lets go — which is both the
      // real mutual-exclusion property and the one that does not depend on the broken
      // option.
      const src = `
        const { parentPort, locks } = require('node:worker_threads');
        let release = null;
        parentPort.on('message', (m) => {
          if (m.op === 'hold') {
            release = null;
            const gate = new Promise((r) => { release = r; });
            locks.request(m.name, async () => gate);
            parentPort.postMessage({ op: 'holding' });
          } else if (m.op === 'go') {
            if (release) release();
            parentPort.postMessage({ op: 'released' });
          }
        });
      `;
      const worker = new Worker(src, { eval: true });
      const once = (op) =>
        new Promise((resolve) => {
          const onMessage = (m) => {
            if (m.op === op) {
              worker.off('message', onMessage);
              resolve(m);
            }
          };
          worker.on('message', onMessage);
        });
      const holding = once('holding');
      worker.postMessage({ op: 'hold', name: 'xw' });
      await holding;
      await settle();

      try {
        const lock = new PowerCrossLock();

        // The worker holds; the main thread must wait.
        // `query()` is per-thread (see the `query` describe), so the main thread cannot
        // *see* the worker holding — which is why this test asserts **blocking** rather
        // than state: the main thread's section has not run while the worker holds the
        // name, and runs once it lets go. Blocking is the property that does not depend
        // on any introspection method.
        let ran = false;
        const blocked = lock.run('xw', () => {
          ran = true;
        });
        await settle(20);
        expect(ran, 'the main thread is still waiting on the worker').toBe(false);
        expect(
          (await lock.query('xw')).pending.length,
          'and this thread can see itself queued'
        ).toBe(1);

        const released = once('released');
        worker.postMessage({ op: 'go' });
        await released;
        await blocked;
        expect(ran, 'then runs once the worker lets go').toBe(true);
        expect((await lock.query('xw')).pending.length, 'and the queue drains').toBe(0);
        lock.dispose();
      } finally {
        await worker.terminate();
      }
    });

    it('serialises a main-thread section against a worker section', async () => {
      // The other direction, and the one that would catch a wrapper that only worked
      // within its own thread: the main thread holds, and the worker's request must queue.
      //
      // **Asserted with timestamps rather than ordering across two arrays**, because the
      // main and worker each record their own timeline and comparing indices between them
      // is meaningless. The property is that the worker's section started *after* the main
      // section ended — i.e. the two never overlapped.
      const src = `
        const { parentPort, locks } = require('node:worker_threads');
        parentPort.on('message', async (m) => {
          const startedAt = Date.now();
          const v = await locks.request(m.name, async () => {
            return 'worker-value';
          });
          parentPort.postMessage({ op: 'done', v, startedAt });
        });
      `;
      const worker = new Worker(src, { eval: true });
      const done = new Promise((resolve) => worker.on('message', resolve));
      try {
        const lock = new PowerCrossLock();
        let mainEnd = 0;
        const mainSection = lock.run('both-ways', async () => {
          await settle(15);
          mainEnd = Date.now();
          return 'main-value';
        });

        // Fire the worker while the main section is in flight.
        await settle(2);
        worker.postMessage({ op: 'go', name: 'both-ways' });
        expect(await mainSection).toBe('main-value');
        const result = await done;
        expect(result.v).toBe('worker-value');
        expect(
          result.startedAt,
          'the worker entered its section only after the main one ended'
        ).toBeGreaterThanOrEqual(mainEnd);
        lock.dispose();
      } finally {
        await worker.terminate();
      }
    });
  });

  describe('validation', () => {
    it('requires a non-empty string name', async () => {
      // Every caller that must exclude the others has to spell the name identically, so an
      // empty or non-string name cannot be a lock. An empty string would otherwise be a
      // perfectly valid key that two unrelated call sites both meant.
      const lock = new PowerCrossLock();
      for (const bad of ['', 0, null, undefined, {}, [], Symbol('x')]) {
        await expect(
          lock.run(bad, () => {}),
          String(bad)
        ).rejects.toThrow(TypeError);
      }
      lock.dispose();
    });

    it('requires a function', async () => {
      const lock = new PowerCrossLock();
      await expect(lock.run('x')).rejects.toThrow(TypeError);
      await expect(lock.run('x', 'not a function')).rejects.toThrow(TypeError);
      lock.dispose();
    });

    it('rejects unknown options rather than ignoring them', async () => {
      // The `assertKnownOptions` contract this library holds everywhere: a misspelled
      // option is the failure mode that survives to production.
      const lock = new PowerCrossLock();
      await expect(
        lock.run('x', () => {}, { signal: null, steal: false, sigal: ac0() })
      ).rejects.toThrow(/unknown option/);
      expect(() => new PowerCrossLock({ nam: 'x' })).toThrow(/unknown option/);
      function ac0() {
        return undefined;
      }
      lock.dispose();
    });
  });

  describe('where the platform has no lock manager', () => {
    it('refuses rather than running the section unlocked', () => {
      // **In a real subprocess, because the manager is memoised at module scope.** Stubbing
      // `globalThis.process` in-process cannot reach it — the probe has already run by the
      // time any test executes, which is why the first draft of this test passed against a
      // platform that *does* have a manager and asserted nothing. This is the
      // `WorkerAgnostic.js` lines 47–65 precedent: behaviour that needs a clean module
      // registry is tested in a real process, and "uncollectable under vitest" is not
      // "uncovered".
      // `globalThis.process` alone is not enough: getModule falls back to
      // globalThis.navigator.locks, and Node 24.18 exposes navigator.locks too — so a
      // stubbed process still resolves a manager. Both have to go, which is what makes this
      // a real test of the no-manager branch rather than a decoration.
      const script = `
         globalThis.process = { getBuiltinModule: () => ({}) };
         // globalThis.navigator = {} fails: navigator is a read-only getter in Node, and
         // getModule falls back to it. Object.defineProperty is the one way to remove it.
         Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
        const { PowerCrossLock } = await import('${new URL('../src/helpers/powerCrossLock.js', import.meta.url).href}');
        const lock = new PowerCrossLock();
        let ran = false;
        let message = '';
        try {
          await lock.run('nope', () => { ran = true; });
        } catch (e) {
          message = e.message;
        }
        console.log(JSON.stringify({
          supported: lock.supported,
          ran,
          mentionsManager: message.includes('no cross-worker lock manager'),
          queryShape: Object.keys(await lock.query()).sort(),
        }));
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      });
      const result = JSON.parse(out.trim().split('\n').pop());
      expect(result.supported, 'the probe found no manager').toBe(false);
      expect(result.ran, 'the section never ran unlocked').toBe(false);
      expect(result.mentionsManager, 'and the refusal names the missing capability').toBe(true);
      expect(result.queryShape, 'query() degrades to an empty shape rather than throwing').toEqual([
        'held',
        'pending',
      ]);
    });
  });

  describe('dispose', () => {
    it('is a state reset, not a teardown, and leaves other holders alone', async () => {
      // The lock manager's locks belong to the platform and to whoever is inside them, so
      // `dispose()` resets this instance's counters and touches nothing else. A dispose
      // that closed shared state here is the defect `powerScheduler.js` documents for its
      // own module-level channel.
      const lock = new PowerCrossLock();
      const other = new PowerCrossLock();
      let release;
      const held = new Promise((r) => {
        release = r;
      });
      // The steal displaces `other`'s holder, whose promise therefore rejects — caught
      // here because an unhandled `AbortError` fails the run for the wrong reason.
      let displaced = null;
      const holder = other
        .run('survives-dispose', () => held)
        .catch((e) => {
          displaced = e;
        });
      await settle();

      await lock.run('survives-dispose', () => 'acquired-after', { steal: true });
      expect(displaced && displaced.name, 'the other holder was displaced').toBe('AbortError');
      lock.dispose();
      lock.dispose();

      expect(lock.stats(), 'counters reset').toMatchObject({
        acquisitions: 0,
        steals: 0,
        aborted: 0,
      });
      release();
      await holder;
      expect(
        await other.run('survives-dispose', () => 'still works'),
        "the other instance's lock manager state is untouched"
      ).toBe('still works');
      other.dispose();
    });

    it('is reachable through Symbol.dispose', async () => {
      let lock;
      {
        lock = new PowerCrossLock();
        await lock.run('using', () => {});
      }
      // `dispose()` was not called by the block, so the counters are still there; what this
      // pins is that the symbol exists and does not throw while idle.
      expect(typeof lock[Symbol.dispose]).toBe('function');
      lock[Symbol.dispose]();
      expect(lock.stats().acquisitions).toBe(0);
    });
  });
});
