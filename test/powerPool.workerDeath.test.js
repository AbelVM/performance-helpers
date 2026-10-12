import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * PISC-001: a worker that dies is detected, settled and replaced.
 *
 * Before this, a dead worker was simply absent. Three things followed, all
 * observable from outside as "the pool stopped working":
 *
 *   - `drain()` hung, waiting for a response that would never arrive;
 *   - every `awaitResponse` promise timed out instead of rejecting, so a caller
 *     waited the full timeout to learn what had already happened;
 *   - the pool sat below `minSize` permanently, because nothing noticed the
 *     shortfall.
 *
 * **The bootstrap guard is the half that is easy to get wrong.** A worker that
 * dies having never completed a task is a worker that failed to *load* — a syntax
 * error, a missing module, bad `workerOptions`. Refilling on every such death is
 * a respawn storm: each replacement loads, throws, dies, and is replaced, at full
 * CPU, forever. So consecutive load-failures past a small bound stop the refill.
 *
 * A worker that had been working and then died is a *crash*, not a load failure,
 * and must not count toward that bound — otherwise one bad deploy permanently
 * shrinks a healthy pool. The two cases are separated by `everCompletedTask`, and
 * the tests below pin both directions.
 */

/** A worker stand-in whose `onexit` can be driven by hand. */
function makeUnderlying() {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    onexit: null,
    postMessage() {},
    terminate() {},
  };
}

/** A pool over fakes, created eagerly. */
function makePool(options = {}) {
  return new PowerPool(makeUnderlying, { size: 2, minSize: 2, idleTimeout: 0, ...options });
}

/** Fire the `exit` event on worker `i`'s underlying native worker. */
function killWorker(pool, i = 0, code = 1) {
  const workerObj = pool.workers[i];
  // The pool subscribes through `WorkerAgnostic`, which normalises onto the
  // native model. Driving the native `onexit` is what a real runtime does.
  workerObj.worker._underlying.onexit?.(code);
}

describe('PISC-001 worker death', () => {
  it('rejects the pending response instead of leaving it to time out', async () => {
    // The user-visible half. Before the fix this promise sat until
    // `awaitResponseTimeout` — 30 s by default, forever under `Infinity`.
    const pool = makePool({ size: 1, minSize: 1 });
    const pending = pool.postMessage({ n: 1 }, undefined, { awaitResponse: true });
    const settled = vi.fn();
    pending.then(settled, settled);

    killWorker(pool, 0);

    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    await expect(pending).rejects.toThrow();
    pool.dispose();
  });

  it('refills toward minSize, so the pool does not shrink permanently', () => {
    const pool = makePool({ size: 3, minSize: 3, maxSize: 3 });
    expect(pool.workers.length).toBe(3);
    killWorker(pool, 0);
    expect(pool.workers.length, 'the dead worker is replaced').toBe(3);
    pool.dispose();
  });

  it('emits pool:worker:exit with the exit code and whether it had worked', () => {
    const pool = makePool({ size: 1, minSize: 1 });
    const seen = [];
    pool._bus.on('pool:worker:exit', (e) => seen.push(e));
    killWorker(pool, 0, 7);
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe(7);
    expect(seen[0].completedTask).toBe(false);
    pool.dispose();
  });

  it('is idempotent, so a second exit for the same worker does not double-count', () => {
    // `'exit'` can arrive after an explicit `terminate()` — the pool shutting
    // down, a `resize()`, an idle reap — and re-running the teardown would
    // double-count the worker's completed tasks and re-reject responses that were
    // already settled.
    //
    // **Called directly rather than through the native event.** Driving
    // `underlying.onexit` twice cannot work: `_terminateWorker` disposes the
    // `WorkerAgnostic`, which restores the saved properties and puts `onexit` back
    // to `null`, so the second native fire reaches nobody. That is safe by
    // construction and is *not* what this guard is for — the guard is for a second
    // arrival on a path where the handler is still attached, which is what calling
    // the method twice reproduces.
    //
    // Asserted on the event and the terminated-worker tally, not on `workerCount`:
    // a second teardown of an already-removed worker does not change how many
    // workers are present, so `workerCount` passes either way.
    const pool = makePool({ size: 1, minSize: 1 });
    const events = [];
    pool._bus.on('pool:worker:exit', (e) => events.push(e));
    const tallyBefore = pool._terminatedWorkerTaskCountsCount;
    const workerObj = pool.workers[0];

    pool._handleWorkerExit(workerObj, 1);
    pool._handleWorkerExit(workerObj, 1); // the same worker, again

    expect(events, 'the exit is reported once').toHaveLength(1);
    expect(pool._terminatedWorkerTaskCountsCount, 'and tallied once').toBe(tallyBefore + 1);
    pool.dispose();
  });

  it('does not refill once the pool is shut down', () => {
    // A `shutdown()` that respawns workers on the way out never finishes. The
    // guard reads `_terminated`, the flag `shutdown()` actually sets — a first
    // draft tested a `_shuttingDown` that does not exist anywhere in the file, so
    // the guard was a silent no-op that read as coverage.
    //
    // The worker is captured *before* `shutdown()`, because shutdown terminates
    // and clears the set — reaching for `pool.workers[0]` afterwards is undefined,
    // which is how the first draft of this test failed.
    //
    // **Asserted on workers *created*, not workers present.** `shutdown()` already
    // empties the set, so `workers.length` is 0 either way and the assertion cannot
    // tell a refill from no refill. The creation counter is what moves if the guard
    // is missing, which is how the first draft of this test passed against the
    // defect.
    const pool = makePool({ size: 2, minSize: 2 });
    const underlying = pool.workers[0].worker._underlying;
    pool.shutdown();
    const created = pool._totalWorkersCreated;
    underlying.onexit?.(1);
    expect(pool._totalWorkersCreated, 'no worker is created after shutdown').toBe(created);
  });
});

describe('PISC-001 the bootstrap-failure guard', () => {
  it('stops refilling after consecutive load failures, rather than storming', () => {
    // The storm. Each replacement is a worker that dies having done no work, so
    // each one counts; past the bound the pool stops replacing them.
    //
    // The loop stops as soon as the pool is empty, which is the bound having done
    // its job rather than a test that ran out of workers to kill.
    const pool = makePool({ size: 1, minSize: 1, maxSize: 4 });
    const created = pool._totalWorkersCreated;

    for (let i = 0; i < 8 && pool.workers.length > 0; i++) {
      killWorker(pool, 0);
    }

    // The bound is 3 consecutive failures, so at most 3 replacements were made.
    expect(pool._totalWorkersCreated - created).toBeLessThanOrEqual(3);
    expect(pool._consecutiveBootstrapFailures).toBeGreaterThanOrEqual(3);
    pool.dispose();
  });

  it('resets the bound when a worker completes a task and then dies', () => {
    // The other direction, and the one that keeps a healthy pool healthy: a crash
    // is not a load failure, so it must not accumulate toward the storm bound.
    //
    // **The counter is raised first.** Asserting `0` after a crash on a fresh pool
    // passes whether or not the reset exists, because the counter was already 0 —
    // which is how the first draft of this test passed against the defect. So a
    // load-failure is booked first, and only then does the working worker die.
    const pool = makePool({ size: 1, minSize: 1, maxSize: 4 });

    // One load failure, to put the counter somewhere non-zero.
    killWorker(pool, 0);
    expect(pool._consecutiveBootstrapFailures).toBe(1);

    // Now a worker that has done real work dies. That is a crash.
    const workerObj = pool.workers[0];
    workerObj.everCompletedTask = true;
    killWorker(pool, 0);

    expect(pool._consecutiveBootstrapFailures, 'a crash resets the bound').toBe(0);
    expect(pool.workers.length, 'and the pool still refills').toBe(1);
    pool.dispose();
  });

  it('counts a worker that died without working toward the bound', () => {
    const pool = makePool({ size: 1, minSize: 1, maxSize: 4 });
    killWorker(pool, 0);
    expect(pool._consecutiveBootstrapFailures).toBe(1);
    pool.dispose();
  });
});
