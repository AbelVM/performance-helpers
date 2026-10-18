import { describe, it, expect } from 'vitest';
import { PowerTaskGroup } from '../src/helpers/powerTaskGroup.js';

describe('PowerTaskGroup', () => {
  it('runs a task and returns its result', async () => {
    const scope = new PowerTaskGroup();
    const r = await scope.run(async () => 42);
    expect(r).toBe(42);
    await scope.dispose();
  });

  it('passes an AbortSignal to the task', async () => {
    const scope = new PowerTaskGroup();
    let received;
    await scope.run(async (signal) => {
      received = signal;
      return 'ok';
    });
    expect(received).toBeInstanceOf(AbortSignal);
    await scope.dispose();
  });

  it('cancels siblings on error when cancelOnError is true', async () => {
    const scope = new PowerTaskGroup({ cancelOnError: true });
    const aborted = [];
    const p1 = scope.run(async (signal) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(true);
          resolve();
        });
        setTimeout(() => reject(new Error('boom')), 10);
      });
    });
    const p2 = scope.run(async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted.push(true);
          resolve();
        });
        // never resolves otherwise
      });
    });

    await expect(p1).rejects.toThrow('boom');
    // p2 should have been aborted
    await Promise.allSettled([p2]);
    expect(aborted.length).toBeGreaterThanOrEqual(1);
    await scope.dispose();
  });

  it('does not cancel siblings when cancelOnError is false', async () => {
    const scope = new PowerTaskGroup({ cancelOnError: false });
    const p1 = scope.run(async () => {
      throw new Error('boom');
    });
    const p2 = scope.run(async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    await scope.dispose();
  });

  it('dispose aborts all tasks', async () => {
    const scope = new PowerTaskGroup();
    let aborted = false;
    const p = scope.run(async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    });
    await scope.dispose();
    await Promise.allSettled([p]);
    expect(aborted).toBe(true);
    expect(scope.disposed).toBe(true);
  });

  it('rejects run after dispose', async () => {
    const scope = new PowerTaskGroup();
    await scope.dispose();
    await expect(scope.run(async () => 1)).rejects.toThrow();
  });

  it('supports await using (via asyncDispose)', async () => {
    let aborted = false;
    const scope = new PowerTaskGroup();
    scope.run(async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    });
    await scope[Symbol.asyncDispose]();
    expect(aborted).toBe(true);
  });

  it('supports sync using (aborts, does not await) via Symbol.dispose', () => {
    const scope = new PowerTaskGroup();
    scope.run(async (signal) => {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    });
    expect(scope.disposed).toBe(false);
    scope[Symbol.dispose]();
    expect(scope.disposed).toBe(true);
  });

  it('all() returns settled results', async () => {
    const scope = new PowerTaskGroup({ cancelOnError: false });
    scope.run(async () => 1);
    scope.run(async () => 2);
    const results = await scope.all();
    expect(results).toContain(1);
    expect(results).toContain(2);
    await scope.dispose();
  });

  it('size tracks in-flight tasks', async () => {
    const scope = new PowerTaskGroup();
    let resolveTask;
    const p = scope.run(
      async () =>
        new Promise((r) => {
          resolveTask = r;
        })
    );
    expect(scope.size).toBe(1);
    resolveTask();
    await p;
    expect(scope.size).toBe(0);
    await scope.dispose();
  });
});
