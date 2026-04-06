import { describe, it, expect } from 'vitest';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';

describe('PowerBackpressure', () => {
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
    await expect(bp.acquire()).rejects.toThrow('PowerBackpressure queue is full');
    release();
    const callback = await queued;
    callback();
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
});
