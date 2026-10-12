import { describe, it, expect } from 'vitest';
import { PowerPool, PowerPoolShutdownError } from '../src/helpers/powerPool.js';

describe('PowerPool.shutdown and reaper behavior', () => {
  it('shutdown clears the reaper interval', () => {
    class MockUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {};
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000 });
    // ensure reaper was created
    expect(pool._reaperInterval).not.toBeNull();
    pool.shutdown();
    expect(pool._reaperInterval).toBeNull();
  });

  it('shutdown rejects pending awaitResponse Promises', async () => {
    class SilentUnderlying {
      constructor() {
        this.onmessage = null;
        this.postMessage = () => {
          // intentionally do not respond
        };
        this.terminate = () => {};
      }
    }

    const pool = new PowerPool(SilentUnderlying, { size: 1, idleTimeout: 1000 });
    const p = pool.postMessage({ foo: 'bar' }, undefined, { awaitResponse: true });
    // shutdown should reject the pending promise with a distinct error
    pool.shutdown();
    await expect(p).rejects.toBeInstanceOf(PowerPoolShutdownError);
  });
});

describe('PowerPool.close', () => {
  // PISC-011. A single graceful-shutdown entry point composing the existing
  // `drain()` + `shutdown()` model, which stays exactly as it is.
  //
  // What it prevents is the *order*: `shutdown()` alone abandons in-flight work,
  // and `drain()` alone leaves the workers running. A caller reaching for "shut
  // this down properly" wants both halves in the right sequence, and getting it
  // wrong is silent — the pool looks closed and the last few tasks are gone.

  /** A worker that answers after `delay` ms, so work is observably in flight. */
  function slowWorker(delay = 20) {
    return class {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => this.onmessage?.({ data: { ok: true, req: msg } }), delay);
        };
        this.terminate = () => {};
      }
    };
  }

  it('waits for in-flight work and then terminates', async () => {
    // The whole point. Asserted on `activeTasks` reaching 0 *and* the pool being
    // terminated, because either half alone passes against the wrong composition.
    const pool = new PowerPool(slowWorker(), { size: 1, minSize: 1, maxSize: 1, lazy: false });
    pool.postMessage({ n: 1 });
    const stats = await pool.close();
    expect(pool._terminated).toBe(true);
    expect(stats.activeTasks).toBe(0);
    expect(stats.workerCount).toBe(0);
  });

  it('terminates immediately when forced, abandoning the work', async () => {
    // The force case, and the reason it exists: a close that waits for a wedged
    // worker never finishes. Asserted on elapsed time as well as the outcome,
    // because "terminated" alone would pass against a close that waited.
    const pool = new PowerPool(slowWorker(5000), { size: 1, minSize: 1, maxSize: 1, lazy: false });
    pool.postMessage({ n: 1 });
    const started = Date.now();
    await pool.close({ force: true });
    expect(pool._terminated).toBe(true);
    expect(Date.now() - started, 'did not wait for the 5 s task').toBeLessThan(1000);
  });

  it('waits at most `timeout`, then terminates anyway', async () => {
    // A drain that cannot finish must not block the close. The worker answers in
    // 5 s and the timeout is 30 ms, so the close terminates on the timeout.
    const pool = new PowerPool(slowWorker(5000), { size: 1, minSize: 1, maxSize: 1, lazy: false });
    pool.postMessage({ n: 1 });
    const started = Date.now();
    await pool.close({ timeout: 30 });
    expect(pool._terminated).toBe(true);
    const elapsed = Date.now() - started;
    expect(elapsed, 'terminated on the timeout, not on the task').toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(2000);
  });

  it('refuses force and timeout together, rather than picking a precedence', async () => {
    // A forced close has nothing to wait for, so passing both is a contradiction.
    // Silently preferring one would make the other option look honoured.
    //
    // Asserted with `rejects`, not `toThrow`: `close()` is `async`, so the
    // `TypeError` surfaces as a rejected promise. A synchronous `toThrow` passes
    // against an `async` function that throws, which is how the first draft of
    // this test failed to catch anything.
    const pool = new PowerPool(slowWorker(), { size: 1, minSize: 1, maxSize: 1, lazy: false });
    await expect(pool.close({ force: true, timeout: 100 })).rejects.toThrow(/mutually exclusive/);
    pool.shutdown();
  });

  it('is idempotent, so a second close is a no-op', async () => {
    const pool = new PowerPool(slowWorker(), { size: 1, minSize: 1, maxSize: 1, lazy: false });
    await pool.close();
    await expect(pool.close()).resolves.toBeDefined();
    expect(pool._terminated).toBe(true);
  });

  it('resolves with the final stats snapshot', async () => {
    // The return value is the same shape `drain()` resolves with, so a caller can
    // log the closing state without a second call.
    const pool = new PowerPool(slowWorker(), { size: 1, minSize: 1, maxSize: 1, lazy: false });
    const stats = await pool.close();
    expect(stats).toHaveProperty('workerCount');
    expect(stats).toHaveProperty('activeTasks');
    expect(stats).toHaveProperty('queueLength');
  });
});
