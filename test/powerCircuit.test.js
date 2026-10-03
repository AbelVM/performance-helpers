import { describe, it, expect } from 'vitest';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';

describe('PowerCircuit', () => {
  it('throws when fn is not a function', async () => {
    const cb = new PowerCircuit();
    await expect(cb.call(null)).rejects.toThrow('fn must be a function');
  });

  it('opens after threshold failures and short-circuits', async () => {
    const cb = new PowerCircuit({ threshold: 2, timeout: 50 });
    const fail = true;
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

    await expect(cb.call(() => Promise.reject(new Error('first fail')))).rejects.toThrow(
      'first fail'
    );
    expect(cb.state).toBe('open');

    await new Promise((r) => setTimeout(r, 15));
    expect(cb.state).toBe('half-open');

    await expect(cb.call(() => Promise.reject(new Error('trial fail')))).rejects.toThrow(
      'trial fail'
    );
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

  // RES-026. `dispose()` replaced only `reset`, while its own comment claimed "a
  // late call is a no-op" — so a late `call()` ran `fn` and put the circuit back
  // to work. A `dispose()` that released nothing, on a class holding no resource.
  it('a disposed circuit stays disposed: call() refuses and does not run fn', async () => {
    let ran = 0;
    const cb = new PowerCircuit({ threshold: 1, timeout: 50 });
    cb.dispose();

    // The counter is the assertion that matters. A thrown error alone would be
    // satisfied by a `call()` that ran `fn` and *then* failed, which is close to
    // the old behaviour and would still have performed the work.
    await expect(
      cb.call(() => {
        ran += 1;
        return 'work';
      })
    ).rejects.toMatchObject({ code: 'ECIRCUITDISPOSED' });
    expect(ran, 'the circuit must not run fn after disposal').toBe(0);
  });

  it('dispose is idempotent, and a live circuit is unaffected by any of it', async () => {
    const live = new PowerCircuit({ threshold: 1, timeout: 50 });
    expect(await live.call(() => 'work')).toBe('work');

    const cb = new PowerCircuit({ threshold: 1, timeout: 50 });
    cb.dispose();
    expect(() => cb.dispose(), 'a second dispose is a no-op').not.toThrow();
    expect(() => cb.reset(), 'and so is a late reset').not.toThrow();
  });
});
