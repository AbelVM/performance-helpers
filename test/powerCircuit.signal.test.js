import { describe, it, expect } from 'vitest';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';

describe('PowerCircuit AbortSignal (S2-08)', () => {
  it('rejects when already aborted', async () => {
    const cb = new PowerCircuit({ threshold: 5, timeout: 1000 });
    const ac = new AbortController();
    ac.abort();
    await expect(cb.call(() => 'ok', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects when aborted during execution', async () => {
    const cb = new PowerCircuit({ threshold: 5, timeout: 1000 });
    const ac = new AbortController();
    const p = cb.call(
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'ok';
      },
      { signal: ac.signal }
    );
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not count abort as a failure', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 1000 });
    const ac = new AbortController();
    ac.abort();
    try {
      await cb.call(() => 'ok', ac.signal);
    } catch (e) {
      // expected abort
    }
    expect(cb.failures).toBe(0);
    expect(cb.state).toBe('closed');
  });

  it('supports bare signal argument', async () => {
    const cb = new PowerCircuit({ threshold: 5, timeout: 1000 });
    const ac = new AbortController();
    ac.abort();
    await expect(cb.call(() => 'ok', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
