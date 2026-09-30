import { describe, it, expect } from 'vitest';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';

describe('PowerBackpressure', () => {
  it('exposes queue-related getters', () => {
    const bp = new PowerBackpressure({ capacity: 2, queueCapacity: 3 });
    expect(bp.capacity).toBe(2);
    expect(bp.queueCapacity).toBe(3);
    expect(bp.isFull).toBe(false);
  });

  it('acquires and releases permits immediately when available', async () => {
    const bp = new PowerBackpressure({ capacity: 2 });
    const release1 = await bp.acquire();
    const release2 = await bp.acquire();

    expect(bp.available).toBe(0);
    expect(bp.pending).toBe(0);

    release1();
    expect(bp.available).toBe(1);

    release2();
    expect(bp.available).toBe(2);
  });

  it('queues producers when permits are exhausted', async () => {
    const bp = new PowerBackpressure({ capacity: 1, queueCapacity: 2, refillInterval: 10 });
    const release = await bp.acquire();
    const waiter = bp.acquire();

    expect(bp.available).toBe(0);
    expect(bp.pending).toBe(1);

    release();
    const callback = await waiter;
    expect(typeof callback).toBe('function');
    expect(bp.pending).toBe(0);
    callback();
  });

  it('rejects when wait queue is full', async () => {
    const bp = new PowerBackpressure({ capacity: 1, queueCapacity: 1 });
    const release = await bp.acquire();
    const queued = bp.acquire();
    expect(bp.isFull).toBe(true);
    // The message names the *base* class. `acquire()` used to re-implement the
    // admission decision rather than delegating to `PowerPermitGate`, and that
    // override had already drifted: it also rejected an already-aborted signal
    // with a bare `Error` where the gate gives an `AbortError`, so the
    // `err.name === 'AbortError'` check this class's own docs tell callers to
    // make failed for exactly the class that documents it. One admission
    // decision, one set of words.
    await expect(bp.acquire()).rejects.toThrow('PowerPermitGate queue is full');
    release();
    const callback = await queued;
    callback();
  });

  it('aborts with an AbortError, not a bare Error', async () => {
    // The counterpart to the queue-full message, and the reason the override was
    // deleted rather than kept in sync: a caller following the documented
    // `err.name === 'AbortError'` check got `false` from a plain `Error`, and
    // the only way to tell "cancelled" from "failed" was the message text.
    const bp = new PowerBackpressure({ capacity: 1 });
    const release = await bp.acquire();
    const controller = new AbortController();
    controller.abort();
    await expect(bp.acquire({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    release();
    bp.dispose();
  });

  it('reset clears queued producers without minting a permit that is still held', async () => {
    // RES-023, the same defect the semaphore test covers and the reason the gate
    // is where it is fixed: `available` is capped at `capacity - held`, so a
    // consumer that is still running keeps its permit across a reset. Reset also
    // deliberately does *not* clear the in-flight count - see the AIMD test,
    // which pins that side - so these two have to agree.
    const bp = new PowerBackpressure({ capacity: 1, queueCapacity: 2, refillInterval: 50 });
    const release = await bp.acquire();
    const queued = bp.acquire();

    bp.reset();

    await expect(queued).rejects.toThrow('PowerBackpressure reset');
    expect(bp.available).toBe(0);
    expect(bp.active).toBe(1);
    expect(bp.pending).toBe(0);
    expect(bp.tryAcquire()).toBeNull();

    release();
    expect(bp.available).toBe(1);
  });

  it('supports tryAcquire for immediate grant or null when unavailable', () => {
    const bp = new PowerBackpressure({ capacity: 1 });
    const release = bp.tryAcquire();
    expect(typeof release).toBe('function');
    expect(bp.tryAcquire()).toBeNull();
    release();
    expect(bp.tryAcquire()).not.toBeNull();
  });

  it('performs adaptive refill when backpressure is high', async () => {
    const bp = new PowerBackpressure({
      capacity: 1,
      queueCapacity: 2,
      lowWaterMark: 1,
      refillAmount: 1,
      refillInterval: 10,
    });
    const release = await bp.acquire();
    const waiter = bp.acquire();

    expect(bp.pending).toBe(1);
    release();

    const callback = await waiter;
    expect(typeof callback).toBe('function');
    callback();
  });

  it('preserves leftover permits after adaptive refill grants a waiter', async () => {
    const bp = new PowerBackpressure({
      capacity: 3,
      initialTokens: 0,
      queueCapacity: 2,
      lowWaterMark: 3,
      refillAmount: 2,
      refillInterval: 10,
    });

    const release = await bp.acquire();

    expect(typeof release).toBe('function');
    expect(bp.pending).toBe(0);
    expect(bp.available).toBe(2);

    release();
    expect(bp.available).toBe(3);
  });
});
