import { describe, it, expect } from 'vitest';
import { PowerRetry } from '../src/helpers/powerRetry.js';

describe('PowerRetry', () => {
  it('retries failed attempts up to maxAttempts and succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    };

    const res = await PowerRetry(fn, { maxAttempts: 4, baseDelay: 1, jitter: false });
    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rejects after exhausting attempts', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error('bad');
    };

    await expect(PowerRetry(fn, { maxAttempts: 2, baseDelay: 1, jitter: false })).rejects.toThrow(
      'bad'
    );
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
      PowerRetry(fn, {
        maxAttempts: 3,
        baseDelay: 1,
        jitter: false,
        retryIf: (err) => err.status >= 500,
      })
    ).rejects.toThrow('oops');
    expect(calls).toBe(1);
  });
});
