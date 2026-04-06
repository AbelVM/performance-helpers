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
});
