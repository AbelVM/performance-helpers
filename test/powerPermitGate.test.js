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

  it('reset rejects queued waiters without freeing a permit that is still held', async () => {
    // RES-023. `reset()` used to set `_available` unconditionally, so resetting a
    // gate of 1 with one holder running produced a *second* concurrent holder
    // against a limit of 1 - permanently, because the first holder's release was
    // then swallowed by the capacity clamp. This is the shape that reached it:
    // `using` / `await using` disposes at scope exit, and a `run()` in flight at
    // that moment is not hypothetical.
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 2 });
    const firstRelease = await gate.acquire();
    const pending = gate.acquire();
    let rejected = false;
    pending.catch((err) => {
      rejected = err && err.message === 'PowerPermitGate reset';
    });

    gate.reset({ available: 1, reason: new Error('PowerPermitGate reset') });
    expect(gate.active).toBe(1);
    expect(gate.available).toBe(0);
    // The assertion that distinguishes this from the old behaviour: a second
    // holder is not admitted alongside the one still running.
    expect(gate.tryAcquire()).toBeNull();
    await Promise.resolve();
    expect(rejected).toBe(true);
    expect(gate.pending).toBe(0);

    // The permit comes back when the holder that owns it releases, not before.
    firstRelease();
    expect(gate.active).toBe(0);
    expect(gate.available).toBe(1);
  });

  it('rejects an acquire once the wait queue is full', async () => {
    // The counter `queueCapacity` admits against is *live* waiters, and a
    // cancelled-but-not-yet-compacted entry is not one. This asserts the pair,
    // because each half alone passes with the other broken: `pending` reading
    // one too low lets an extra caller in, and reading one too high turns a
    // cancel storm into a "queue is full" that nobody queued.
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 1 });
    const held = await gate.acquire();
    const controller = new AbortController();
    const cancelled = gate.acquire({ signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow(/abort/i);
    // Still exactly one live waiter, so the next caller is admitted and the one
    // after it is not.
    const live = gate.acquire();
    expect(gate.pending).toBe(1);
    await expect(gate.acquire()).rejects.toThrow('PowerPermitGate queue is full');

    held();
    const release = await live;
    expect(gate.pending).toBe(0);
    release();
  });

  it('serves a live waiter queued behind a cancelled one', async () => {
    // RES-001. The refill loop shifted queue entries itself, so it neither skipped
    // cancelled ones nor decremented `_cancelledWaiters`. One cancellation was
    // therefore enough to leave the counter permanently one too high: `pending`
    // reported 0 with a live waiter still queued, every refill tick short-circuited
    // on `pending === 0`, and the queue could not make progress at all. The only
    // way out was `reset()`.
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 4 });
    const held = await gate.acquire();
    const controller = new AbortController();
    const corpse = gate.acquire({ signal: controller.signal });
    const live = gate.acquire();
    controller.abort();
    await expect(corpse).rejects.toThrow(/abort/i);

    // The counter has to be honest while the corpse is still physically queued.
    expect(gate.pending).toBe(1);

    held();
    const release = await live;
    // The cancelled entry consumed no permit: it never held one.
    expect(gate.active).toBe(1);
    expect(gate.pending).toBe(0);
    release();
    expect(gate.active).toBe(0);
    expect(gate.available).toBe(1);
  });

  it('rejects a fractional capacity instead of over-issuing permits', () => {
    // RES-010. `capacity: 2.5` used to admit *three* concurrent holders - each
    // grant decremented the fractional counter and three decrements still leave
    // it above 0 - and then reported `available: -0.5`. A limit that counts things
    // has to be a whole number; options that are genuinely fractional, such as
    // `PowerRetryBudget.ratio`, deliberately are not.
    expect(() => new PowerPermitGate({ capacity: 2.5 })).toThrow(TypeError);
    expect(() => new PowerPermitGate({ capacity: 2.5 })).toThrow(/whole number/);
    // ...and a whole one still works, so this is not "reject everything with a
    // decimal point in it".
    expect(new PowerPermitGate({ capacity: 2 }).capacity).toBe(2);
  });
});
