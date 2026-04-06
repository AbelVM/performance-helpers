import { describe, it, expect } from 'vitest';
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';

describe('PowerPermitGate', () => {
  it('acquires permits immediately when available', async () => {
    const gate = new PowerPermitGate({ capacity: 2 });
    const release = await gate.acquire();
    expect(typeof release).toBe('function');
    expect(gate.available).toBe(1);
    expect(gate.pending).toBe(0);
    release();
    expect(gate.available).toBe(2);
  });

  it('queues callers when permits are exhausted', async () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const firstRelease = await gate.acquire();
    const pending = gate.acquire();
    expect(gate.pending).toBe(1);
    let resolved = false;

    const promise = pending.then((release) => {
      resolved = true;
      release();
    });

    expect(resolved).toBe(false);
    firstRelease();
    await promise;
    expect(gate.pending).toBe(0);
    expect(resolved).toBe(true);
    expect(gate.available).toBe(1);
  });

  it('rejects acquire when the wait queue is full', async () => {
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 1 });
    await gate.acquire();
    gate.acquire();
    await expect(gate.acquire()).rejects.toThrow('PowerPermitGate queue is full');
  });

  it('tryAcquire returns null when no permit is available', () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const release = gate.tryAcquire();
    expect(typeof release).toBe('function');
    expect(gate.tryAcquire()).toBeNull();
    release();
    expect(gate.tryAcquire()).not.toBeNull();
  });

  it('reset clears waiters and restores available permits', async () => {
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 2 });
    const firstRelease = await gate.acquire();
    const pending = gate.acquire();
    let rejected = false;
    pending.catch((err) => {
      rejected = err && err.message === 'PowerPermitGate reset';
    });

    gate.reset({ available: 1, reason: new Error('PowerPermitGate reset') });
    expect(gate.available).toBe(1);
    await Promise.resolve();
    expect(rejected).toBe(true);
    firstRelease();
  });
});
