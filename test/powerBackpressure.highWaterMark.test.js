import { describe, it, expect } from 'vitest';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';

describe('PowerBackpressure highWaterMark', () => {
  it('rejects acquire when queued waiters reach the high-water mark', async () => {
    const bp = new PowerBackpressure({ capacity: 1, queueCapacity: 100, highWaterMark: 1 });
    // exhaust capacity
    const release = await bp.acquire();
    // first waiter queues (pending becomes 1, equals highWaterMark)
    const p1 = bp.acquire();
    // second acquire should reject because pending (1) >= highWaterMark (1)
    await expect(bp.acquire()).rejects.toMatchObject({ code: 'ERR_QUEUE_FULL' });
    release();
    await p1;
    bp.dispose();
  });

  it('Infinity (default) disables the check', async () => {
    const bp = new PowerBackpressure({ capacity: 1, queueCapacity: 100 });
    const release = await bp.acquire();
    const p1 = bp.acquire();
    const p2 = bp.acquire();
    release();
    await Promise.all([p1, p2]);
    bp.dispose();
  });

  it('reports highWaterMark in stats', () => {
    const bp = new PowerBackpressure({ capacity: 2, highWaterMark: 3 });
    expect(bp.stats().highWaterMark).toBe(3);
    bp.dispose();
  });

  it('rejects unknown option', () => {
    expect(() => new PowerBackpressure({ foo: 1 })).toThrow();
  });
});
