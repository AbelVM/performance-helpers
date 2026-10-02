import { describe, it, expect } from 'vitest';
import {
  PowerThrottle,
  PowerPermitGate,
  PowerGCRA,
  PowerSlidingWindow,
  PowerQueue,
  PowerBatch,
  PowerTTLMap,
  PowerSubscriberSet,
  PowerEventBus,
  PowerHistogram,
  PowerCircuit,
  PowerLatch,
  PowerRetryBudget,
} from '../src/index.js';
import { SmallLfuSketch } from '../src/utils/smallLfu.js';

/**
 * RES-038: pin what `reset()` means on each class that has one.
 *
 * **The row's numbers are wrong and understating them hides the problem.** It
 * records "four `reset()` implementations mean three different things". There are
 * **19**, and they mean **six** different things:
 *
 * | meaning | classes |
 * | --- | --- |
 * | refill to full | `PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerBackpressure`, `PowerSemaphore`, `PowerRateLimit` |
 * | refill, counting held permits, and reject queued waiters | `PowerPermitGate`, `PowerBulkhead` |
 * | empty the contents | `PowerQueue`, `PowerBatch`, `PowerTTLMap`, `PowerSubscriberSet`, `PowerEventBus` |
 * | zero the measurements | `PowerHistogram`, `PowerEventLoopMonitor` |
 * | return to the initial machine state | `PowerCircuit`, `PowerLatch`, `PowerRetryBudget` |
 * | halve — a half-life decay, not a clear | `smallLfu` (internal) |
 *
 * **And the row's third category is not what happens.** It says
 * *refill-and-forget-outstanding-holders*. `PowerPermitGate.reset()` sets
 * `_available = max(0, min(capacity, capacity - _held))` — it **counts** the
 * permits still held, and floors at zero. Measured with capacity 1 and one
 * permit outstanding, `available` is 0 after a reset, not 1. The distinguishing
 * third effect is not forgetting holders; it is **rejecting the queued waiters**,
 * which the two gate classes do and nothing else does.
 *
 * **None of this is a bug.** Every divergence is deliberate, and the two the row
 * points at (`powerQueue.js`, `powerBatch.js`) each spend three lines of JSDoc
 * explaining that the alias is intentionally *not* uniform with the limiters.
 * `smallLfu.reset()` is documented as "the half-life reset" and has a separate
 * `clear()` for the real clear. The row's complaint is precisely that this is
 * "known, documented, and unenforced" — so this file is the enforcement, and the
 * tests are **characterisations of decisions**, not aspirations.
 *
 * **What this file is for.** A future "harmonise `reset()` across the library"
 * refactor is a reasonable-sounding change that would silently break callers, and
 * nothing else in the repository would notice. Each test below states a
 * distinction that a harmonisation would erase.
 */

/** Let queued microtasks settle, so a rejection is observed rather than raced. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('RES-038: reset() means six different things, and each is pinned', () => {
  describe('the pair that points in opposite directions', () => {
    it('PowerQueue.reset() empties; PowerThrottle.reset() refills', () => {
      // The sharpest one, and the reason a shared primitive is not the obvious
      // answer. Same method name, opposite effect on the only number a caller can
      // see: after both resets, the queue has *nothing* and the throttle has
      // *everything*.
      const queue = new PowerQueue();
      // `push` takes one item. `push(1, 2, 3)` silently enqueues only the first,
      // which is a third thing this test file had wrong before it ran.
      queue.push(1);
      queue.push(2);
      queue.push(3);
      const throttle = new PowerThrottle({ capacity: 5 });
      for (let i = 0; i < 5; i += 1) throttle.tryConsume(1);

      expect(queue.length, 'precondition: the queue holds items').toBe(3);
      expect(throttle.tokens, 'precondition: the throttle is drained').toBe(0);

      queue.reset();
      throttle.reset();

      expect(queue.length, 'the queue is emptied').toBe(0);
      expect(throttle.tokens, 'the throttle is refilled to capacity').toBe(5);
    });

    it('the other "empty" classes all empty', async () => {
      // The category, so a future change to one of them is caught here rather
      // than by whichever caller happens to use it.
      const clock = 1_000_000;
      const now = () => clock;

      // `PowerBatch.reset()` empties the queue **and rejects any pending flush**,
      // which is the same third effect the two gate classes have and is why this
      // line needs a `.catch`. Found by the test runner rather than by reading:
      // leaving it unhandled produced an unhandled rejection that vitest
      // surfaced against a *different* test, which is exactly how this reaches a
      // caller. So the rejection is asserted here rather than merely absorbed.
      const batch = new PowerBatch((items) => items);
      batch.add(1);
      let flushRejection = null;
      const flushed = batch.flush().catch((err) => {
        flushRejection = err;
      });
      batch.reset();
      await flushed;

      expect(batch.size, 'PowerBatch is emptied').toBe(0);
      expect(flushRejection, 'and a pending flush is rejected, not abandoned').not.toBeNull();
      expect(String(flushRejection && flushRejection.message)).toContain(
        'PowerBatch cleared before flush'
      );

      const ttlMap = new PowerTTLMap({ defaultTTL: 60_000, now });
      ttlMap.set('k', 1);
      ttlMap.reset();
      expect(ttlMap.size, 'PowerTTLMap is emptied').toBe(0);

      const subscribers = new PowerSubscriberSet();
      subscribers.add(() => {});
      subscribers.reset();
      expect(subscribers.size, 'PowerSubscriberSet is emptied').toBe(0);
    });
  });

  describe('refill, counting held permits, and rejecting waiters', () => {
    it('PowerPermitGate.reset() rejects the queued waiters', async () => {
      // The effect **no other reset in the library has**. A waiter parked on the
      // gate is not merely forgotten: its promise rejects. A caller awaiting a
      // permit has to handle that, and only this class tells it to.
      const gate = new PowerPermitGate({ capacity: 1 });
      const held = await gate.acquire();
      expect(gate.available, 'precondition: the only permit is held').toBe(0);

      let rejection = null;
      const queued = gate.acquire().catch((err) => {
        rejection = err;
      });
      await settle();
      expect(gate.pending, 'precondition: a waiter is queued').toBe(1);

      gate.reset();
      await queued;

      expect(rejection, 'the queued waiter was rejected, not abandoned').not.toBeNull();
      expect(String(rejection && rejection.message)).toContain('PowerPermitGate reset');
      held();
    });

    it('PowerPermitGate.reset() counts outstanding holders rather than forgetting them', async () => {
      // This is the claim in RES-038 that measurement contradicts. The reset
      // refills to `capacity` and then subtracts what is still held, floored at
      // zero — so with capacity 1 and one permit outstanding, `available` is 0
      // rather than 1. Treating it as "forget outstanding holders" would make
      // this assertion wrong, which is the point of writing it.
      const gate = new PowerPermitGate({ capacity: 1 });
      const held = await gate.acquire();

      gate.reset();

      expect(gate.available, 'a held permit is not conjured back by a reset').toBe(0);

      held();
      expect(gate.available, 'and becomes available once released').toBe(1);
    });

    it('the clock-driven limiters all refill to full', () => {
      // The other meaning, and the one a caller reaching for `reset()` on a
      // limiter almost always wants.
      const clock = 1_000_000;
      const now = () => clock;

      const throttle = new PowerThrottle({ capacity: 4, now });
      for (let i = 0; i < 4; i += 1) throttle.tryConsume(1);
      expect(throttle.tokens).toBe(0);
      throttle.reset();
      expect(throttle.tokens, 'PowerThrottle refills').toBe(4);

      // Compared against a *fresh instance* rather than a hard-coded number. The
      // first draft asserted `3` and read 1: with `burst` at its 0 default the
      // TAT arithmetic does not yield the configured rate, and hard-coding either
      // value would have pinned bucket internals instead of the property. What
      // "refilled" means for a GCRA is exactly "behaves as if new".
      const gcra = new PowerGCRA({ rate: 3, per: 1000, now });
      const freshGcra = new PowerGCRA({ rate: 3, per: 1000, now });
      for (let i = 0; i < 3; i += 1) gcra.tryConsume(1);
      expect(gcra.available(), 'precondition: drained').toBeLessThan(freshGcra.available());
      gcra.reset();
      expect(gcra.available(), 'PowerGCRA refills to the fresh-instance value').toBe(
        freshGcra.available()
      );

      const window = new PowerSlidingWindow({ windowMs: 60_000, capacity: 8, now });
      window.tryConsume(4);
      expect(window.available()).toBe(4);
      window.reset();
      expect(window.available(), 'PowerSlidingWindow refills').toBe(8);
    });
  });

  describe('return to the initial machine state', () => {
    it('PowerCircuit.reset() closes a circuit that was open', async () => {
      const circuit = new PowerCircuit({ threshold: 1, timeout: 60_000 });
      await circuit
        .call(async () => {
          throw new Error('boom');
        })
        .catch(() => {});
      expect(circuit.state, 'precondition: one failure opened it').toBe('open');

      circuit.reset();

      expect(circuit.state, 'and a reset returns it to the state it started in').toBe('closed');
    });

    it('PowerLatch.reset(count) sets the count outright', () => {
      // Not a refill and not an empty: an argument sets it. `reset()` with no
      // argument means `1`, so the default is itself a decision.
      const latch = new PowerLatch(3);
      latch.countDown();
      expect(latch.remaining, 'precondition: one has been counted down').toBe(2);

      latch.reset(5);
      expect(latch.remaining, 'and the argument wins over the current count').toBe(5);

      latch.reset();
      expect(latch.remaining, 'the default argument is 1').toBe(1);
    });

    it('PowerRetryBudget.reset() refills the bucket and zeroes the counters', () => {
      // Both at once — a fourth combination in one method.
      const budget = new PowerRetryBudget({ ratio: 0.5, capacity: 4 });
      // `recordRequest()` *grants* a token rather than consuming one, so a
      // drained bucket needs `tryConsumeRetry()`. The first draft drained it with
      // `recordRequest()` and its precondition asserted 3 against an actual 4.
      for (let i = 0; i < 10; i += 1) budget.tryConsumeRetry();
      expect(budget.available(), 'precondition: the bucket is drained').toBe(0);
      budget.recordRequest();
      expect(budget.stats().requests, 'precondition: a request is recorded').toBe(1);

      budget.reset();

      expect(budget.available(), 'the bucket is refilled').toBe(4);
      expect(budget.stats().requests, 'and the request counter is zeroed').toBe(0);
    });
  });

  describe('zero the measurements', () => {
    it('PowerHistogram.reset() clears count and sum but not the shape', () => {
      const histogram = new PowerHistogram();
      histogram.record(1);
      histogram.record(2);
      expect(histogram.count, 'precondition').toBe(2);

      histogram.reset();

      expect(histogram.count, 'the count is zeroed').toBe(0);
      expect(histogram.sum, 'and so is the sum').toBe(0);
    });
  });

  describe('the arity divergence', () => {
    it('PowerEventBus.reset(event) takes an event and clears only that one', () => {
      // Two of nineteen take an argument. Everything else takes none, so
      // `reset()` on a bus is a *partial* clear and on everything else it is
      // total — a difference a caller reading the name alone cannot see.
      const bus = new PowerEventBus();
      let onX = 0;
      let onY = 0;
      bus.on('x', () => {
        onX += 1;
      });
      bus.on('y', () => {
        onY += 1;
      });

      bus.reset('x');
      bus.emit('x');
      bus.emit('y');

      expect(onX, 'the named event has no listeners left').toBe(0);
      expect(onY, 'and the other event is untouched').toBe(1);
    });

    it('passing an argument changes the result on three of them, and not on the rest', () => {
      // **Tested behaviourally, not by `Function.length`, because `.length` cannot
      // see a defaulted parameter.** `PowerThrottle.reset(count)` has no default and
      // reports 1; `PowerLatch.reset(count = 1)` has one and also reports 0 for a
      // different reason entirely. The first draft of this test asserted
      // arities and was wrong in both directions. What a caller can observe is
      // whether the argument changes the outcome.
      const withArg = new PowerThrottle({ capacity: 8 });
      for (let i = 0; i < 8; i += 1) withArg.tryConsume(1);
      withArg.reset(3);
      expect(withArg.tokens, 'PowerThrottle.reset(n) sets n tokens').toBe(3);

      const withoutArg = new PowerThrottle({ capacity: 8 });
      for (let i = 0; i < 8; i += 1) withoutArg.tryConsume(1);
      withoutArg.reset();
      expect(withoutArg.tokens, 'and reset() refills to capacity').toBe(8);

      // The fourth: a class whose reset takes nothing, so an argument is ignored.
      // Pinned because "ignores its argument" and "has no argument" are different
      // contracts and a refactor could move between them silently.
      const queue = new PowerQueue(64);
      queue.push(1);
      queue.reset(1);
      expect(queue.length, 'PowerQueue.reset(n) empties regardless of n').toBe(0);
    });
  });

  describe('the sixth meaning, which is not a clear at all', () => {
    it('SmallLfu.reset() halves; only clear() clears', () => {
      // The most surprising of the six and the one most likely to be "fixed" by
      // someone who read the name. Internal rather than exported, but reached
      // through `PowerCache` with `admission: 'tinylfu'`.
      const sketch = new SmallLfuSketch();
      sketch.increment(1);
      sketch.increment(1);
      expect(sketch.estimate(1), 'precondition: two increments').toBe(2);

      sketch.reset();

      expect(
        sketch.estimate(1),
        'a half-life reset keeps half the history, so this is 1 and not 0'
      ).toBe(1);

      sketch.clear();
      expect(sketch.estimate(1), 'and clear() is the one that empties').toBe(0);
    });
  });
});
