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
});
