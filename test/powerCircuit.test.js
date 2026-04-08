import { describe, it, expect } from 'vitest';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';

describe('PowerCircuit', () => {
  it('throws when fn is not a function', async () => {
    const cb = new PowerCircuit();
    await expect(cb.call(null)).rejects.toThrow('fn must be a function');
  });

  it('opens after threshold failures and short-circuits', async () => {
    const cb = new PowerCircuit({ threshold: 2, timeout: 50 });
    let fail = true;
    const f = async () => {
      if (fail) throw new Error('boom');
      return 'ok';
    };

    await expect(cb.call(f)).rejects.toThrow('boom');
    expect(cb.failures).toBe(1);
    // second failure triggers open
    await expect(cb.call(f)).rejects.toThrow('boom');
    expect(cb.state).toBe('open');
    expect(cb.failures).toBe(0);
    expect(cb.lastError).toBeInstanceOf(Error);
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
    expect(cb.failures).toBe(0);
    expect(cb.lastError).toBe(null);
  });

  it('reopens when the half-open trial fails', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 10 });

    await expect(cb.call(() => Promise.reject(new Error('first fail')))).rejects.toThrow('first fail');
    expect(cb.state).toBe('open');

    await new Promise((r) => setTimeout(r, 15));
    expect(cb.state).toBe('half-open');

    await expect(cb.call(() => Promise.reject(new Error('trial fail')))).rejects.toThrow('trial fail');
    expect(cb.state).toBe('open');
    expect(cb.failures).toBe(0);
  });

  it('reset closes the circuit and clears failure state', async () => {
    const cb = new PowerCircuit({ threshold: 1, timeout: 50 });
    await expect(cb.call(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cb.state).toBe('open');

    cb.reset();

    expect(cb.state).toBe('closed');
    expect(cb.failures).toBe(0);
    expect(cb.lastError).toBe(null);
  });
});
