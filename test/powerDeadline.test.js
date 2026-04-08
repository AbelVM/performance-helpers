import { describe, it, expect } from 'vitest';
import { PowerDeadline } from '../src/helpers/powerDeadline.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PowerDeadline', () => {
  it('resolves when the function completes before timeout', async () => {
    const value = await PowerDeadline.run(
      async () => {
        await delay(10);
        return 'ok';
      },
      { attemptTimeout: 100 }
    );

    expect(value).toBe('ok');
  });

  it('rejects with ETIMEOUT when an attempt exceeds attemptTimeout', async () => {
    await expect(
      PowerDeadline.run(
        async () => {
          await delay(50);
        },
        { attemptTimeout: 10 }
      )
    ).rejects.toHaveProperty('code', 'ETIMEOUT');
  });

  it('rejects with EDEADLINE when totalTimeout is exceeded', async () => {
    await expect(
      PowerDeadline.run(
        async () => {
          await delay(100);
        },
        { maxAttempts: 3, totalTimeout: 50, retryDelay: 10 }
      )
    ).rejects.toHaveProperty('code', 'EDEADLINE');
  });

  it('retries failed attempts when retryIf returns true', async () => {
    let calls = 0;
    const value = await PowerDeadline.run(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('try again');
        return 'done';
      },
      { maxAttempts: 3, retryDelay: 5, retryIf: () => true }
    );

    expect(value).toBe('done');
    expect(calls).toBe(2);
  });

  it('supports AbortSignal cancellation', async () => {
    const controller = new AbortController();
    const promise = PowerDeadline.run(
      async () => {
        await delay(50);
      },
      { signal: controller.signal, attemptTimeout: 100 }
    );

    controller.abort();
    await expect(promise).rejects.toHaveProperty('code', 'EABORT');
  });

  it('propagates attempts metadata on rejection', async () => {
    await expect(
      PowerDeadline.run(
        async () => {
          throw new Error('bad');
        },
        { maxAttempts: 2, retryIf: () => false }
      )
    ).rejects.toMatchObject({ attempts: 1, attemptTimeout: null });
  });

  it('throws TypeError when fn is not callable', async () => {
    await expect(PowerDeadline.run(null)).rejects.toThrow(TypeError);
  });

  it('rejects immediately when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('user cancelled');

    await expect(
      PowerDeadline.run(
        async () => 'never',
        { signal: controller.signal, totalTimeout: 25 }
      )
    ).rejects.toMatchObject({
      code: 'EABORT',
      reason: 'user cancelled',
      attempts: 1,
      totalTimeout: 25,
    });
  });

  it('treats boolean retryIf values as retry predicates', async () => {
    let calls = 0;
    const value = await PowerDeadline.run(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('retry once');
        return 'ok';
      },
      { maxAttempts: 2, retryIf: true }
    );

    expect(value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('merges instance defaults with per-call overrides', async () => {
    let calls = 0;
    const deadline = new PowerDeadline({ maxAttempts: 3, retryIf: true });
    const value = await deadline.run(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('retry from instance');
        return 'done';
      },
      { retryDelay: 1 }
    );

    expect(value).toBe('done');
    expect(calls).toBe(2);
  });

  it('stops before an attempt starts when the total deadline is already exhausted', async () => {
    await expect(
      PowerDeadline.run(
        async () => {
          await delay(10);
          throw new Error('too late');
        },
        { maxAttempts: 3, totalTimeout: 1, retryDelay: 5, retryIf: true }
      )
    ).rejects.toMatchObject({ code: 'EDEADLINE' });
  });
});
