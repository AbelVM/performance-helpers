import { describe, it, expect } from 'vitest';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';

describe('PowerCircuit', () => {
  it('opens after threshold failures and short-circuits', async () => {
    const cb = new PowerCircuit({ threshold: 2, timeout: 50 });
    let fail = true;
    const f = async () => {
      if (fail) throw new Error('boom');
      return 'ok';
    };

    await expect(cb.call(f)).rejects.toThrow('boom');
    // second failure triggers open
    await expect(cb.call(f)).rejects.toThrow('boom');
    expect(cb.state).toBe('open');
    // subsequent calls short-circuit
    await expect(cb.call(f)).rejects.toHaveProperty('code', 'ECIRCUITOPEN');
  });

  it('allows trial after timeout and recovers on success', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 50 });
    // cause one failure to open
    await expect(cb.call(() => Promise.reject(new Error('e1')))).rejects.toThrow();
    expect(cb.state).toBe('open');
    // wait for timeout to allow half-open
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.state).toBe('half-open');
    // now succeed
    const res = await cb.call(() => Promise.resolve('ok'));
    expect(res).toBe('ok');
    expect(cb.state).toBe('closed');
  });
});
