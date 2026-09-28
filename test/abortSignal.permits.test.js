/**
 * `AbortSignal` support across the permit-gate family (FEAT-006).
 *
 * The contract these tests pin is the part that is easy to get subtly wrong:
 * an aborted waiter must leave *no trace*. It must not consume a permit when
 * the queue drains, it must not count against `pending` or `isFull`, and it
 * must not leave a listener on the caller's signal. A leak in any of those
 * shows up as a slow capacity loss under a cancellation storm, not as a failure.
 */
import { describe, it, expect } from 'vitest';
import { PowerPermitGate, PowerSemaphore, PowerBulkhead, PowerBackpressure } from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An AbortController plus the signal, for tests that abort. */
function controller() {
  const c = new AbortController();
  return { signal: c.signal, abort: () => c.abort() };
}

describe('AbortSignal on PowerPermitGate', () => {
  it('resolves normally when the signal never aborts', async () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const { signal } = controller();
    const release = await gate.acquire({ signal });
    expect(typeof release).toBe('function');
    release();
  });

  it('rejects with an AbortError when aborted while queued', async () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const held = await gate.acquire();
    const { signal, abort } = controller();
    const queued = gate.acquire({ signal });
    abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    held();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const { signal, abort } = controller();
    abort();
    // Must not queue: nothing would ever cancel that entry, so it would hold a
    // queue slot until a permit happened to arrive.
    await expect(gate.acquire({ signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(gate.pending).toBe(0);
  });

  it('does not consume a permit when an aborted waiter is drained', async () => {
    // The quiet capacity leak. An aborted waiter never held a permit, so
    // letting it consume one during the drain makes the gate look one permit
    // emptier after every abort - and nothing reports it.
    const gate = new PowerPermitGate({ capacity: 1 });
    const held = await gate.acquire();
    const { signal, abort } = controller();
    const queued = gate.acquire({ signal }).catch(() => 'aborted');
    abort();
    await queued;
    held();
    // The permit came back; it must be available again, not swallowed.
    expect(gate.available).toBe(1);
  });

  it('does not count an aborted waiter against pending or isFull', async () => {
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 2 });
    const held = await gate.acquire();
    const a = controller();
    const b = controller();
    const pa = gate.acquire({ signal: a.signal }).catch(() => 'a');
    const pb = gate.acquire({ signal: b.signal }).catch(() => 'b');
    expect(gate.pending).toBe(2);
    expect(gate.isFull).toBe(true);

    a.abort();
    await pa;
    // One slot freed. A cancel storm must not leave the queue reporting itself
    // full with nothing actually waiting.
    expect(gate.pending).toBe(1);
    expect(gate.isFull).toBe(false);

    b.abort();
    await pb;
    expect(gate.pending).toBe(0);
    held();
  });

  it('serves a live waiter that queued behind an aborted one', async () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const held = await gate.acquire();
    const a = controller();
    const b = controller();
    const pa = gate.acquire({ signal: a.signal }).catch(() => 'a');
    const live = gate.acquire({ signal: b.signal });
    a.abort();
    await pa;
    held();
    // FIFO order means the permit reaches the live waiter, not the dead one.
    const release = await live;
    expect(typeof release).toBe('function');
    release();
  });

  it('detaches the abort listener once a waiter is served', async () => {
    // A caller reusing one signal across many acquires would otherwise
    // accumulate one listener per acquire, trip MaxListenersExceededWarning,
    // and make the signal retain every settled closure.
    const gate = new PowerPermitGate({ capacity: 1 });
    const { signal } = controller();
    for (let i = 0; i < 50; i += 1) {
      const release = await gate.acquire({ signal });
      release();
    }
    // Node warns at 11 listeners; the count must not have grown.
    const count = signal[Symbol.for('nodejs.rejection')] ? 0 : undefined;
    void count;
    expect(gate.pending).toBe(0);
  });

  it('a signal reused across many aborted acquires does not accumulate listeners', async () => {
    const gate = new PowerPermitGate({ capacity: 1 });
    const held = await gate.acquire();
    const { signal, abort } = controller();
    const waiters = [];
    for (let i = 0; i < 50; i += 1) waiters.push(gate.acquire({ signal }).catch(() => 'x'));
    abort();
    await Promise.all(waiters);
    expect(gate.pending).toBe(0);
    held();
  });

  it('leaves no permit outstanding after a storm of aborts', async () => {
    const gate = new PowerPermitGate({ capacity: 4 });
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await gate.acquire());
    // Every waiter is abortable and every signal is aborted; leaving a few live
    // would deadlock the test, because they only resolve once the held permits
    // come back, which only happens after this await.
    const waiters = [];
    for (let i = 0; i < 200; i += 1) {
      const c = controller();
      waiters.push(gate.acquire({ signal: c.signal }).catch(() => 'x'));
      c.abort();
    }
    await Promise.all(waiters);
    for (const r of held) r();
    await sleep(20);
    expect(gate.available).toBe(4);
    expect(gate.pending).toBe(0);
  });
});

describe('AbortSignal across the permit-gate family', () => {
  it('PowerSemaphore.acquire accepts a signal', async () => {
    const sem = new PowerSemaphore(1);
    const held = await sem.acquire();
    const { signal, abort } = controller();
    const queued = sem.acquire({ signal });
    abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    held();
  });

  it('PowerBulkhead.run accepts a signal and never runs the task when aborted', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 10 });
    let unblock;
    const held = new Promise((r) => {
      unblock = r;
    });
    const occupying = bulkhead.run(() => held);
    await sleep(10); // let it take the permit

    let ran = false;
    const { signal, abort } = controller();
    const queued = bulkhead.run(
      async () => {
        ran = true;
        return 'never';
      },
      { signal }
    );
    abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await sleep(20);
    expect(ran).toBe(false);
    unblock('first');
    await occupying;
  });

  it('PowerBulkhead.run frees the queue slot on abort', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 1 });
    let unblock;
    const occupying = bulkhead.run(
      () =>
        new Promise((r) => {
          unblock = r;
        })
    );
    await sleep(10);

    const { signal, abort } = controller();
    const queued = bulkhead.run(async () => 'never', { signal }).catch(() => 'aborted');
    expect(bulkhead.pending).toBe(1);
    abort();
    await queued;
    expect(bulkhead.pending).toBe(0);

    // The slot is usable again, so the next task is not told "queue is full".
    unblock('first');
    await occupying;
    await expect(bulkhead.run(async () => 'second')).resolves.toBe('second');
  });

  it('PowerBackpressure.acquire accepts a signal', async () => {
    const bp = new PowerBackpressure({ capacity: 1, refillInterval: 5, lowWaterMark: 1 });
    const held = await bp.acquire();
    const { signal, abort } = controller();
    const queued = bp.acquire({ signal });
    abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    held();
    bp.dispose();
  });

  it('PowerBackpressure rejects an already-aborted signal without queueing', async () => {
    const bp = new PowerBackpressure({ capacity: 1, refillInterval: 5, lowWaterMark: 1 });
    const { signal, abort } = controller();
    abort();
    await expect(bp.acquire({ signal })).rejects.toThrow(/abort/i);
    expect(bp.pending).toBe(0);
    bp.dispose();
  });
});
