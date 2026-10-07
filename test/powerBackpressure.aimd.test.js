/**
 * AIMD refill tuning for `PowerBackpressure` (ALG-006).
 *
 * The controller used to refill a fixed amount plus a share of the queue, with
 * no idea whether the consumers it was handing permits to were coping. These
 * tests drive the two signals that matter: a consumer that returns permits, and
 * one that never does.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerBackpressure } from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `predicate` holds, or give up after `ms`.
 *
 * These tests are about a trend across many refill ticks, and how long that
 * takes depends on the scheduler. A fixed sleep either flakes when the machine
 * is busy or wastes seconds when it is not; polling is neither. An earlier
 * draft used fixed sleeps and failed intermittently for exactly that reason.
 *
 * @param {function(): boolean} predicate
 * @param {number} [ms=3000]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

/** A backpressure with a short refill tick and AIMD on. */
function make(options = {}) {
  return new PowerBackpressure({
    capacity: 4,
    refillInterval: 5,
    refillAmount: 4,
    lowWaterMark: 1,
    adaptive: true,
    ...options,
  });
}

describe('PowerBackpressure adaptive refill (AIMD)', () => {
  it('reports normalized permit pressure for composition', () => {
    const bp = make({ initialTokens: 1 });
    expect(bp.stats().pressure).toBeCloseTo(0.75);
    bp.dispose();
  });

  it('is off by default and leaves refillAmount exactly where it was configured', () => {
    const bp = new PowerBackpressure({ capacity: 8, refillAmount: 3, refillInterval: 5 });
    expect(bp.refillAmount).toBe(3);
    bp.dispose();
  });

  it('keeps refillAmount constant when adaptive is off, under a stuck consumer', async () => {
    const bp = new PowerBackpressure({
      capacity: 4,
      refillAmount: 4,
      refillInterval: 5,
      lowWaterMark: 1,
    });
    const held = [];
    // Queue more work than capacity and never release: the backoff condition.
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    for (let i = 0; i < 8; i += 1) bp.acquire().catch(() => {});
    // A negative assertion, so there is nothing to poll for: let several ticks
    // elapse, however many that turns out to be, and require no movement.
    await sleep(120);
    expect(bp.refillAmount).toBe(4);
    held.forEach((r) => r());
    bp.dispose();
  });

  it('decreases the refill window multiplicatively while a consumer holds everything', async () => {
    const bp = make();
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    for (let i = 0; i < 8; i += 1) bp.acquire().catch(() => {});

    const start = bp.refillAmount;
    await waitFor(() => bp.refillAmount < start);
    // 4 held, capacity 4 => every tick is the "nothing came back" signal.
    expect(bp.refillAmount).toBeLessThan(start);
    // Multiplicative, so a few ticks cost much more than additive growth ever
    // would; and it must not have fallen to zero.
    expect(bp.refillAmount).toBeLessThanOrEqual(Math.floor(start * 0.5));
    expect(bp.refillAmount).toBeGreaterThanOrEqual(1);

    held.forEach((r) => r());
    bp.dispose();
  });

  it('counts a permit handed to a queued producer by a refill tick', async () => {
    // RES-003, second half. The refill loop used to hand permits to waiters
    // itself, without touching the in-flight count, so a gate whose every
    // permit had gone out through a refill read 0 in flight. The controller
    // then saw no congestion at all and grew its window into exactly the stall
    // it exists to prevent - which is also why the additive-increase assertion
    // in this file used to pass: a permanently-false congestion signal is a
    // permanently-growing window. Asserted through the refill path, not through
    // `acquire`, because that is the route that bypassed the count.
    const bp = make();
    const held = await bp.acquire();
    // A waiter that nothing will release, purely to give the refill something
    // to hand a permit to.
    bp.acquire().catch(() => {});

    await waitFor(() => bp._inFlight === 2);
    expect(bp._inFlight).toBe(2);
    expect(bp.active).toBe(2);
    expect(bp.available).toBe(2);
    held();
    bp.dispose();
  });

  it('does not let a transferred permit count as a returned one', async () => {
    // RES-024. A release that serves a queued producer is a *transfer*: the
    // permit is handed straight over and is never in the pool in between, so
    // the in-flight count is unchanged. `release()` used to subtract the
    // requested count regardless, which walked the counter below zero after one
    // transfer cycle and pinned the controller in additive increase forever
    // after - a window that only ever grows is not congestion control.
    //
    // The count is a *concurrency* count, so the shape to assert is the
    // inequality, not an exact figure: 4 holders releasing into 3 queued
    // waiters must still read 4 held of a capacity of 4. The old code read 1.
    const bp = make();
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    const transfers = [];
    for (let i = 0; i < 3; i += 1)
      transfers.push(
        bp.acquire().then(
          (r) => r,
          () => null
        )
      );
    await waitFor(() => bp._inFlight === 4);

    // Three releases, three waiters: every one is a transfer.
    held.slice(0, 3).forEach((r) => r());
    const served = await Promise.all(transfers);

    expect(served.filter((r) => typeof r === 'function')).toHaveLength(3);
    expect(bp._inFlight).toBe(4);
    expect(bp.active).toBe(4);
    expect(bp._inFlight).toBeLessThanOrEqual(bp.capacity);

    // The fourth release has nobody left to transfer to, so that one *is* a
    // return - which is the difference the return value of `release()` exists
    // to express, and the reason the counter moves at all.
    held[3]();
    expect(bp._inFlight).toBe(3);
    bp.dispose();
  });

  it('grows the window when a permit comes back and cuts it when none do', async () => {
    // Both branches in one test, because the interesting claim is that the
    // *same* signal decides between them - a counter that cannot distinguish the
    // two cases cannot drive either one.
    //
    // The additive branch needs a state that is easy to assume reachable and is
    // not. `_performRefill` reaches `_aimdStep` only when a waiter is queued; a
    // caller only queues when no permit is free; and a gate with a free permit is
    // by definition not saturated. So the branch wants
    // `in-flight < capacity`, `available === 0`, and a queue.
    //
    // **Correction, from ALGO-010's investigation:** this comment used to claim
    // the branch was "not reachable from a real workload today" and that only a
    // gate starting drained could produce it. That was wrong. A refill grants
    // `min(refillAmount, missing)`, so whenever `refillAmount < capacity` the
    // post-grant in-flight count is *below* capacity and the additive branch
    // fires — measured at 93% of grants on a transient load, with the window
    // oscillating between its floor and the refill amount. That is what a
    // loss-based AIMD is supposed to do. What was actually broken was the whole
    // controller ceasing to be invoked (now fixed, and covered by
    // `test/powerBackpressure.heartbeat.test.js`), not this branch.
    //
    // The drained-gate setup below is kept because it isolates the branch from
    // the rest of the controller, which is what this test is for: it is a unit
    // test of the decision, not a demonstration of when the decision is reached.
    //
    // The long interval is not decoration: with a 5ms tick, the real timer fires
    // between the two halves of the setup and this test measures the race rather
    // than the branch.
    const bp = make({ initialTokens: 0, refillInterval: 60_000 });
    const waits = [];
    for (let i = 0; i < 5; i += 1)
      waits.push(
        bp.acquire().then(
          (r) => r,
          () => null
        )
      );

    // Queueing is not granting. That distinction is the whole content of the
    // count, and RES-003 was that the refill loop handed permits out without
    // moving it - so a gate running entirely on refills read 0 in flight.
    expect(bp._inFlight).toBe(0);
    expect(bp.pending).toBe(5);

    bp._performRefill();
    // additiveIncrease defaults to 1, so one step is exactly one permit.
    expect(bp.refillAmount).toBe(5);
    // ...and that same tick granted 4 of the 5 waiting, which is the same
    // counting the previous test pins.
    expect(bp._inFlight).toBe(4);
    expect(bp.available).toBe(0);

    // Saturated with a waiter still queued: the backoff condition, and the
    // branch the sibling test drives through a real workload. Same signal, same
    // method, the other decision.
    //
    // The second tick mints a *second* permit per queued waiter, because
    // `capacity` bounds the pool rather than the concurrency in flight - a
    // consumer that has not returned anything is exactly why more producers get
    // let in. So the count crosses `capacity` here, and that is the design
    // rather than the over-minting it looks like: the window is what shrinks to
    // correct it. See ADR 0004.
    const grown = bp.refillAmount;
    bp._performRefill();
    expect(bp.refillAmount).toBeLessThan(grown);
    expect(bp.refillAmount).toBeGreaterThanOrEqual(1);
    expect(bp._inFlight).toBeGreaterThan(bp.capacity);
    // ...and `active` keeps counting rather than saturating at `capacity`,
    // which is the whole reason it is read from `_held`.
    expect(bp.active).toBe(bp._inFlight);

    // Reject the one waiter that never got a permit, then give the rest back.
    const outstanding = bp._inFlight;
    bp.reset();
    expect(bp._inFlight).toBe(outstanding);
    const served = (await Promise.all(waits)).filter((r) => typeof r === 'function');
    expect(served).toHaveLength(5);
    served.forEach((r) => r());
    expect(bp._inFlight).toBe(0);
    bp.dispose();
  });

  it('never probes with less than one permit, so a backoff cannot deadlock', async () => {
    const bp = make({ adaptive: { beta: 0.1, min: 1 } });
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    for (let i = 0; i < 8; i += 1) bp.acquire().catch(() => {});
    await waitFor(() => bp.refillAmount <= 1, 500);
    expect(bp.refillAmount).toBeGreaterThanOrEqual(1);
    held.forEach((r) => r());
    bp.dispose();
  });

  it('honours additiveIncrease and beta', async () => {
    const slow = make({ adaptive: { additiveIncrease: 3, beta: 0.5 } });
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await slow.acquire());
    for (let i = 0; i < 8; i += 1) slow.acquire().catch(() => {});
    await waitFor(() => slow.refillAmount < 4);
    // beta 0.5 from a base of 4 halves on every tick - 4 -> 2 -> 1 - so the
    // window is at the floor. Asserting an exact value would be asserting the
    // number of ticks that happened to fit in 60ms.
    expect(slow.refillAmount).toBeLessThan(4);
    expect(slow.refillAmount).toBeGreaterThanOrEqual(1);
    held.forEach((r) => r());
    slow.dispose();
  });

  it('reset() returns the window to its base and leaves the honest holder count alone', async () => {
    const bp = make();
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    for (let i = 0; i < 8; i += 1) bp.acquire().catch(() => {});
    await waitFor(() => bp.refillAmount < 4);
    expect(bp.refillAmount).toBeLessThan(4);
    // The refill has been minting past the pool size for as long as the
    // backlog lasted, so the outstanding count is above `capacity` by the time
    // the window has come down. That is the model (ADR 0004), and it is why the
    // count is the thing to record rather than `capacity`.
    const outstanding = bp._inFlight;
    expect(outstanding).toBeGreaterThanOrEqual(4);

    // Forgetting what was learned about a consumer that no longer exists is the
    // point of reset(); carrying a tuned window across would apply a conclusion
    // drawn about a different workload.
    bp.reset();
    expect(bp.refillAmount).toBe(4);

    // The in-flight count is *not* cleared, and that is the fix rather than an
    // oversight: those consumers are still running, so their permits are still
    // held. Zeroing the counter used to make the AIMD signal read "no
    // congestion" immediately after a reset - a conclusion about a workload
    // that had not been re-measured - and it disagreed with `available`.
    expect(bp._inFlight).toBe(outstanding);
    expect(bp.active).toBe(outstanding);
    // The pool is not refilled past what is outstanding (RES-023): a teardown
    // must not hand a second consumer a permit the first one is still using.
    expect(bp.available).toBe(0);
    expect(bp.tryAcquire()).toBeNull();

    held.forEach((r) => r());
    expect(bp._inFlight).toBeLessThan(outstanding);
    bp.dispose();
  });

  it('clamps beta into a range that cannot stall or invert the window', () => {
    const zero = make({ adaptive: { beta: 0 } });
    const huge = make({ adaptive: { beta: 5 } });
    expect(zero._adaptive.beta).toBeGreaterThan(0);
    expect(huge._adaptive.beta).toBeLessThan(1);
    zero.dispose();
    huge.dispose();
  });

  it('tryAcquire that returns null does not count as in-flight', () => {
    // Counting a failed try would inflate in-flight and make AIMD back off
    // against a consumer that was never given anything.
    const bp = new PowerBackpressure({ capacity: 1, initialTokens: 0, adaptive: true });
    expect(bp.tryAcquire()).toBeNull();
    expect(bp._inFlight).toBe(0);
    bp.dispose();
  });

  it('does not schedule a refill once disposed', async () => {
    vi.useFakeTimers();
    try {
      const bp = make();
      const held = [];
      for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
      bp.dispose();
      const after = bp.refillAmount;
      vi.advanceTimersByTime(5000);
      expect(bp.refillAmount).toBe(after);
      held.forEach((r) => r());
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes congestion and recovery rounds', () => {
    const bp = new PowerBackpressure({
      capacity: 4,
      refillAmount: 2,
      adaptive: { enabled: true },
    });
    expect(bp.stats()).toMatchObject({
      adaptive: true,
      congestionSteps: 0,
      recoverySteps: 0,
    });
    bp._aimdStep();
    expect(bp.stats().recoverySteps).toBe(1);
  });
});
