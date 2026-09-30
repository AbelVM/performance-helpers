import { describe, it, expect } from 'vitest';
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';

describe('PowerSemaphore', () => {
  it('acquires immediately when permits are available', async () => {
    const sem = new PowerSemaphore(2);
    const release = await sem.acquire();
    expect(typeof release).toBe('function');
    expect(sem.active).toBe(1);
    expect(sem.available).toBe(1);
    release();
    expect(sem.active).toBe(0);
  });

  it('queues acquire requests when limit is reached', async () => {
    const sem = new PowerSemaphore(1);
    const first = await sem.acquire();
    const pending = sem.acquire();
    expect(sem.pending).toBe(1);
    let released = false;
    const promise = pending.then((release) => {
      released = true;
      release();
    });

    expect(released).toBe(false);
    first();
    await promise;
    expect(sem.pending).toBe(0);
    expect(released).toBe(true);
  });

  it('tryAcquire returns null when no permit is available', () => {
    const sem = new PowerSemaphore(1);
    const release = sem.tryAcquire();
    expect(typeof release).toBe('function');
    expect(sem.tryAcquire()).toBeNull();
    release();
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it('run serializes work to the concurrency limit', async () => {
    const sem = new PowerSemaphore(2);
    const results = [];

    const task = async (name, delayMs) => {
      await sem.run(async () => {
        results.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        results.push(`${name}-end`);
      });
    };

    const a = task('a', 30);
    const b = task('b', 30);
    const c = task('c', 10);

    await Promise.all([a, b, c]);
    expect(results[0]).toBe('a-start');
    expect(results[1]).toBe('b-start');
    expect(results).toContain('c-start');
    expect(results).toContain('c-end');
    expect(results.indexOf('c-start')).toBeGreaterThan(results.indexOf('a-end'));
    expect(results.indexOf('c-start')).toBeGreaterThan(results.indexOf('b-start'));
    expect(results.indexOf('b-end')).toBeGreaterThan(results.indexOf('c-start'));
  });

  it('isLocked reflects when the semaphore is fully acquired', async () => {
    const sem = new PowerSemaphore(1);
    expect(sem.isLocked).toBe(false);
    const release = await sem.acquire();
    expect(sem.isLocked).toBe(true);
    release();
    expect(sem.isLocked).toBe(false);
  });

  it('run releases the permit when the callback throws', async () => {
    const sem = new PowerSemaphore(1);

    await expect(
      sem.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(sem.active).toBe(0);
    expect(sem.available).toBe(1);
    expect(sem.isLocked).toBe(false);
  });

  it('reset rejects queued waiters without admitting a second holder', async () => {
    // RES-023. The reset is a teardown, not a licence to over-issue: a `run()`
    // in flight at scope exit is the case that reached it, because
    // `using sem = new PowerSemaphore(1)` disposes while the first `run()` is
    // still awaiting. The old `reset()` set `available` to the limit regardless,
    // so the next `tryAcquire()` succeeded and two tasks ran against a limit of
    // one - permanently, since the first holder's release was absorbed by the
    // capacity clamp.
    const sem = new PowerSemaphore(1);
    const release = await sem.acquire();
    const pending = sem.acquire();

    expect(sem.pending).toBe(1);
    sem.reset();

    await expect(pending).rejects.toThrow();
    expect(sem.pending).toBe(0);
    expect(sem.active).toBe(1);
    expect(sem.available).toBe(0);
    expect(sem.tryAcquire()).toBeNull();

    // The permit returns when the holder that owns it releases.
    release();
    expect(sem.active).toBe(0);
    expect(sem.available).toBe(1);
    const nextRelease = sem.tryAcquire();
    expect(typeof nextRelease).toBe('function');
    nextRelease();
  });
});
