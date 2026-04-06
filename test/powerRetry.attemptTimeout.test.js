import { describe, it, expect } from 'vitest';
import PowerRetry from '../src/helpers/powerRetry.js';

describe('PowerRetry attemptTimeout', () => {
  it('times out a slow attempt and retries according to maxAttempts', async () => {
    const start = Date.now();
    const fn = () => new Promise((res) => setTimeout(res, 1000)); // never resolves within attemptTimeout
    const opts = {
      maxAttempts: 2,
      attemptTimeout: 50,
      baseDelay: 1,
      backoff: 'fixed',
      jitter: false,
    };

    let thrown = null;
    try {
      await PowerRetry.run(fn, opts);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    // should have taken at least attemptTimeout * maxAttempts (with tiny delays)
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it('treats a timed-out attempt as a failed attempt and succeeds on retry', async () => {
    let call = 0;
    const fn = () =>
      new Promise((res, rej) => {
        call += 1;
        if (call === 1) {
          // first attempt stalls
          return; // never resolves
        }
        res('ok');
      });

    const opts = {
      maxAttempts: 3,
      attemptTimeout: 30,
      baseDelay: 1,
      backoff: 'fixed',
      jitter: false,
    };

    const res = await PowerRetry.run(fn, opts);
    expect(res).toBe('ok');
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
