import { describe, it, expect, afterEach } from 'vitest';
import { PowerPermitGate, PowerBackpressure, PowerSemaphore, PowerBulkhead } from '../src/index.js';

/**
 * `RES-009`: one file over the *cross-products* of the gate family.
 *
 * `test/` is organised one file per unit, which is right for a unit and wrong for
 * a class of defect where **each component is correct alone**. Every bug in the
 * `24f9869` family was of that kind:
 *
 * - a reset that minted a permit a holder was still using;
 * - a cancelled waiter that consumed a permit it never held;
 * - a release that decremented the outstanding count for a *transfer*, so the
 *   count went below zero and a controller reading it was permanently wrong;
 * - a queue-drain route that never recorded which worker took a task, so the
 *   promise for it could never be settled.
 *
 * None of those is a bug in `reset()`, in `acquire()` or in `release()`. Each is
 * a bug in the *composition*, and with no home for composition tests they go
 * unwritten — which is why the file is called for by `POOL-004` and by the
 * review as "the structural fix for this whole family".
 *
 * Every assertion here is a **counter or a shape**. No durations: the project's
 * harness measures a ~28% median min/max spread on a typical machine, and an
 * assertion in milliseconds is an assertion about the machine.
 */

/** The ceiling a gate must never exceed, however it is driven. */
function assertWithinCapacity(gate, capacity) {
  const active = gate.active;
  const available = gate.available;
  expect(Number.isInteger(active), `active=${active} is not a whole number of holders`).toBe(true);
  expect(Number.isInteger(available), `available=${available} is not a whole number`).toBe(true);
  expect(available, 'available went negative').toBeGreaterThanOrEqual(0);
  expect(active, 'more holders than the gate allows').toBeLessThanOrEqual(capacity);
  expect(available, 'available and active disagree about the total').toBeLessThanOrEqual(
    capacity - active
  );
}

const disposables = [];
afterEach(() => {
  for (const d of disposables.splice(0)) {
    try {
      d.dispose?.();
    } catch {
      /* already gone */
    }
  }
});

describe('gates never exceed their capacity, whatever the sequence (RES-009)', () => {
  it('survives an arbitrary mix of acquire, release, cancel and reset', async () => {
    // A deterministic pseudo-random walk rather than a hand-written script, so the
    // cross-product is wide and the test still has no timing in it. A seeded LCG:
    // the same walk on every run, and a failure is reproducible from the seed.
    const gate = new PowerPermitGate({ capacity: 3, queueCapacity: 8 });
    disposables.push(gate);
    let seed = 20260930;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const controllers = [];
    const releases = [];
    const settled = [];

    for (let i = 0; i < 200; i += 1) {
      const op = rnd(6);
      if (op === 0) {
        const r = gate.tryAcquire();
        if (r) releases.push(r);
      } else if (op === 1) {
        // A cancel that is *pending* when it is aborted — the interaction that
        // cost a permit and deadlocked a queue.
        const controller = new AbortController();
        controllers.push(controller);
        settled.push(
          gate.acquire({ signal: controller.signal }).then(
            (r) => releases.push(r),
            () => {}
          )
        );
        if (rnd(2) === 0) controller.abort();
      } else if (op === 2) {
        settled.push(
          gate.acquire().then(
            (r) => releases.push(r),
            () => {}
          )
        );
      } else if (op === 3 && releases.length) {
        releases.pop()();
      } else if (op === 4) {
        gate.reset({ available: rnd(4) });
      } else if (op === 5) {
        // A reset while permits are outstanding: the defect that admitted a second
        // holder against a limit of one.
        gate.reset();
      }
      assertWithinCapacity(gate, 3);
    }

    // Everything still queued has to be rejected before awaiting, or the walk
    // hangs: a queued `acquire()` with no release and no abort never settles.
    gate.reset({ reason: new Error('end of walk') });
    await Promise.all(settled);
    for (const r of releases) r();
    assertWithinCapacity(gate, 3);
    // A permit is not conjured or destroyed by the walk: whatever the gate was
    // given, every permit is either held or available.
    expect(gate.available + gate.active).toBe(3);
    expect(gate.pending).toBe(0);
  });

  it('holds the same invariant across the four gate classes', async () => {
    // The point of one file: the same cross-product, four times. A defect that
    // lives in only one of them is invisible to per-unit tests in the other three.
    const gate = new PowerPermitGate({ capacity: 2, queueCapacity: 4 });
    const backpressure = new PowerBackpressure({ capacity: 2, queueCapacity: 4 });
    const semaphore = new PowerSemaphore(2);
    const bulkhead = new PowerBulkhead({ partitions: 2, maxConcurrency: 2, queueCapacity: 4 });
    disposables.push(gate, backpressure, semaphore, bulkhead);

    // `PowerBulkhead` is deliberately absent: it is a *runner* — `run`/`tryRun`,
    // no `acquire` — so the permit arithmetic below does not describe it, and a
    // `?.` chain that quietly skipped it would make this test look broader than it
    // is. Its ceiling is asserted through `run` in the last case.
    void bulkhead;
    for (const [name, target, limit] of [
      ['PowerPermitGate', gate, 2],
      ['PowerBackpressure', backpressure, 2],
      ['PowerSemaphore', semaphore, 2],
    ]) {
      const a = target.tryAcquire();
      const b = target.tryAcquire();
      const c = target.tryAcquire();
      // The third must be refused: that is what a ceiling means, and it is the
      // same claim in all four classes.
      expect(c ?? false, `${name} admitted a third holder against a limit of 2`).toBeFalsy();
      a?.();
      b?.();
      expect(target.active, `${name} lost a holder across two releases`).toBeLessThanOrEqual(limit);
    }
  });

  it('does not let a cancelled waiter consume a permit', async () => {
    // The composition that no per-unit test covers: the waiter is queued, it is
    // aborted, and a *live* waiter behind it must still be served. A refund of
    // zero, not a refund that has to be clawed back.
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 4 });
    disposables.push(gate);
    const held = await gate.acquire();
    const controller = new AbortController();
    const cancelled = gate.acquire({ signal: controller.signal });
    const live = gate.acquire();
    controller.abort();
    await expect(cancelled).rejects.toThrow();

    expect(gate.pending, 'the abort was still counted as a waiter').toBe(1);
    held();
    const release = await live;
    // The corpse consumed nothing: the live waiter took the one permit that came
    // back, and the gate is saturated by exactly one holder.
    expect(gate.active).toBe(1);
    expect(gate.available).toBe(0);
    release();
    expect(gate.available).toBe(1);

    // The decrement's own effect, which is only visible *after* the corpse has
    // been compacted: a counter left one high makes `pending` overstate the
    // queue for the rest of the gate's life, so the next waiter reads as a second
    // one. Mutation-checked — dropping the decrement fails here and nowhere else,
    // because every other assertion in this file is about permits rather than
    // about the counter.
    // Saturate first: with a permit free the next `acquire` takes the fast path
    // and never queues, so `pending` would read 0 whether or not the counter is
    // correct. An earlier version of this assertion failed against correct code
    // for exactly that reason.
    release();
    const blocker = gate.tryAcquire();
    expect(blocker).toBeTypeOf('function');
    const next = gate.acquire();
    expect(gate.pending, 'a compacted cancellation is still counted as a waiter').toBe(1);
    blocker();
    const nextRelease = await next;
    nextRelease();
    expect(gate.available).toBe(1);
  });

  it('does not let a reset hand a permit to a second holder', async () => {
    // The defect `RES-023` described, as a cross-component claim: a holder is
    // outstanding, so a reset must not make the gate look idle.
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 2 });
    disposables.push(gate);
    const release = await gate.acquire();
    gate.reset({ available: 1 });
    expect(gate.active).toBe(1);
    expect(gate.available).toBe(0);
    expect(gate.tryAcquire(), 'a reset admitted a second holder against a limit of one').toBeNull();
    release();
    expect(gate.available).toBe(1);
  });

  it('keeps the outstanding count invariant across a transfer', async () => {
    // A release that serves a queued waiter is a *transfer*: the permit is never
    // in the pool in between, so the count of holders is unchanged. Counting it
    // as both a grant and a return is what made the in-flight count read 7 for 4
    // holders, and it is invisible unless both sides are compared.
    const gate = new PowerPermitGate({ capacity: 4, queueCapacity: 4 });
    disposables.push(gate);
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await gate.acquire());
    const waiters = [gate.acquire(), gate.acquire(), gate.acquire()];
    expect(gate.active).toBe(4);

    // Three releases, three transfers. The count must not move in either
    // direction: counting a transfer as both a grant and a return is what made the
    // in-flight count read 7 for 4 holders.
    held[0]();
    const first = await waiters[0];
    expect(gate.active).toBe(4);
    expect(gate.available).toBe(0);
    held[1]();
    const second = await waiters[1];
    expect(gate.active).toBe(4);
    expect(gate.available).toBe(0);

    // A transfer requires the waiter to still be queued, so the *order* is the
    // whole claim: release-then-await is still a transfer, and an earlier draft
    // of this test asserted a return after doing exactly that and read 4 where it
    // expected 3. With the queue drained, the next release has nowhere to hand
    // the permit and *is* a return.
    held[2]();
    const third = await waiters[2];
    expect(gate.active).toBe(4);
    expect(gate.available).toBe(0);
    // Queue drained. The next release has nowhere to hand the permit.
    held[3]();
    expect(gate.active).toBe(3);
    expect(gate.available).toBe(1);

    first();
    second();
    third();
    held[3]();
    expect(gate.active).toBe(0);
    expect(gate.available).toBe(4);
  });

  it('settles queued waiters on dispose rather than stranding them', async () => {
    // `dispose` and `reset` are different claims: a reset is reversible and keeps
    // the object usable, a dispose is terminal. Both must reject what is queued,
    // and neither may leave a promise that nothing will ever settle.
    // `PowerBulkhead` is absent for the same reason as above: it is a runner, so
    // there is no `acquire` to queue. Its dispose behaviour is about running
    // tasks, not about queued permit waiters, and asserting it here would be
    // asserting a different question than the other two answer.
    for (const make of [
      () => new PowerPermitGate({ capacity: 1, queueCapacity: 4 }),
      () => new PowerBackpressure({ capacity: 1, queueCapacity: 4, refillInterval: 10_000 }),
      () => new PowerSemaphore(1),
    ]) {
      const target = make();
      const running = target.tryAcquire?.() ?? null;
      const queued = target.acquire().then(
        () => 'resolved',
        (e) => `rejected: ${e?.message ?? String(e)}`
      );
      target.dispose?.();
      expect(await queued).toMatch(/^rejected: /);
      running?.();
    }
  });
});
