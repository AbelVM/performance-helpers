import { describe, it, expect } from 'vitest';
import { PowerRetry } from '../src/helpers/powerRetry.js';

describe('PowerRetry', () => {
  it('throws a TypeError when fn is not callable', async () => {
    await expect(PowerRetry.run(null)).rejects.toThrow('fn must be a function');
  });

  it('retries failed attempts up to maxAttempts and succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    };

    const res = await PowerRetry.run(fn, { maxAttempts: 4, baseDelay: 1, jitter: false });
    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rejects after exhausting attempts', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error('bad');
    };

    await expect(
      PowerRetry.run(fn, { maxAttempts: 2, baseDelay: 1, jitter: false })
    ).rejects.toThrow('bad');
    expect(calls).toBe(2);
  });

  it('honors retryIf predicate', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      const e = new Error('oops');
      e.status = 400;
      throw e;
    };

    await expect(
      PowerRetry.run(fn, {
        maxAttempts: 3,
        baseDelay: 1,
        jitter: false,
        retryIf: (err) => err.status >= 500,
      })
    ).rejects.toThrow('oops');
    expect(calls).toBe(1);
  });

  it('supports instance-level default options merged with per-call overrides', async () => {
    let calls = 0;
    const retry = new PowerRetry({ maxAttempts: 4, baseDelay: 1, jitter: false });
    const fn = async () => {
      calls += 1;
      if (calls < 2) throw new Error('retry me');
      return 'ok';
    };

    const res = await retry.run(fn, { backoff: 'fixed' });
    expect(res).toBe('ok');
    expect(calls).toBe(2);
  });

  it('treats boolean retryIf values as fixed retry policy', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error('still bad');
    };

    await expect(
      PowerRetry.run(fn, { maxAttempts: 3, baseDelay: 1, jitter: false, retryIf: false })
    ).rejects.toThrow('still bad');
    expect(calls).toBe(1);
  });

  it('swallows onRetry callback errors and continues retrying', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    };

    const res = await PowerRetry.run(fn, {
      maxAttempts: 2,
      baseDelay: 1,
      jitter: false,
      onRetry() {
        throw new Error('observer failed');
      },
    });

    expect(res).toBe('ok');
    expect(calls).toBe(2);
  });
});
