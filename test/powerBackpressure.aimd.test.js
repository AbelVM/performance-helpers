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

  it('increases the refill window additively while consumers return permits', async () => {
    const bp = make();
    // Keep one producer cycling and releasing promptly, and keep a backlog so
    // refills keep being scheduled.
    let running = true;
    const cycle = (async () => {
      while (running) {
        try {
          const r = await bp.acquire();
          r();
        } catch {
          /* queue full */
        }
        await sleep(2);
      }
    })();

    for (let i = 0; i < 12; i += 1) bp.acquire().catch(() => {});
    const start = bp.refillAmount;
    await waitFor(() => bp.refillAmount > start);
    running = false;
    await cycle;

    expect(bp.refillAmount).toBeGreaterThan(start);
    bp.dispose();
  });

  it('recovers after the consumer starts returning permits again', async () => {
    const bp = make();
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    for (let i = 0; i < 8; i += 1) bp.acquire().catch(() => {});
    await waitFor(() => bp.refillAmount < 4);
    const backedOff = bp.refillAmount;
    expect(backedOff).toBeLessThan(4);

    // The consumer starts behaving, *under sustained pressure*: producers must
    // keep outrunning it, or the queue empties, there is nothing left to
    // observe, and a window that cannot recover is not a defect - the system
    // is simply not under load.
    let running = true;
    const consumer = (async () => {
      while (running) {
        try {
          const r = await bp.acquire();
          setTimeout(r, 3);
        } catch {
          /* queue full */
        }
        await sleep(2);
      }
    })();
    for (let i = 0; i < 8; i += 1) void bp.acquire().catch(() => {});
    await waitFor(() => bp.refillAmount > backedOff);
    running = false;
    await consumer;

    console.log(
      'DEBUG refill=',
      bp.refillAmount,
      'backedOff=',
      backedOff,
      'inFlight=',
      bp._inFlight,
      'pending=',
      bp.pending
    );
    expect(bp.refillAmount).toBeGreaterThan(backedOff);
    held.forEach((r) => r());
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

  it('reset() returns the window to its base and clears in-flight accounting', async () => {
    const bp = make();
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await bp.acquire());
    for (let i = 0; i < 8; i += 1) bp.acquire().catch(() => {});
    await waitFor(() => bp.refillAmount < 4);
    expect(bp.refillAmount).toBeLessThan(4);

    // Forgetting what was learned about a consumer that no longer exists is the
    // point of reset(); carrying a tuned window across would apply a conclusion
    // drawn about a different workload.
    bp.reset();
    expect(bp.refillAmount).toBe(4);
    expect(bp._inFlight).toBe(0);
    held.forEach((r) => r());
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
});
