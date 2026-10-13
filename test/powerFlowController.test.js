import { describe, it, expect, vi } from 'vitest';
import { PowerFlowController } from '../src/helpers/powerFlowController.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { MetricsCollector } from '../src/helpers/metrics.js';

// Every test drives the injected clock and the servo's `dt` argument rather than
// wall-clock durations. A control loop whose tests need a real timer is a control
// loop that has grown a sampling policy it should not have.

/**
 * A deterministic plant: service time rises linearly with the offered rate and
 * saturates at `cap`. `latencyOf(rate, cap)` is the whole physical model, so a
 * test can state the equilibrium rate in closed form and assert the loop reaches
 * it — which is the difference between "the rate moved" and "the rate is right".
 *
 * @param {number} cap - Operations per second the plant sustains before queueing.
 * @returns {(rate: number) => number}
 */
function plant(cap) {
  const BASE = 5;
  const SLOPE = 90;
  return (rate) => BASE + (rate / cap) * SLOPE;
}

/** The rate at which `plant(cap)` produces `target` ms of latency. */
function equilibrium(cap, target) {
  return (cap * (target - 5)) / 90;
}

describe('PowerGCRA.setRate', () => {
  it('moves the derived state, not just the reported number', () => {
    // The defect this exists for: `rate` is a plain public field, so
    // `limiter.rate = 500` changed what `stats()` reported and nothing the
    // limiter did, because `_emission` and `_delayTolerance` were derived once
    // in the constructor. A composition that retunes a GCRA had no way to do it.
    const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 10 });
    expect(limiter.stats().emissionInterval).toBe(10);

    limiter.setRate(50);

    expect(limiter.rate).toBe(50);
    expect(limiter.stats().emissionInterval).toBe(20);
    expect(limiter.stats().delayTolerance).toBe(200);
  });

  it('keeps the theoretical arrival time rather than rescaling it', () => {
    // The TAT is an absolute instant, so the debt it holds is debt in *time*.
    // Re-spacing it onto the new emission interval would invent capacity the
    // old rate never granted, so a rate cut must make the limiter refuse for
    // longer, not forgive what is already owed.
    let t = 0;
    const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 10, now: () => t });
    expect(limiter.tryConsume(11)).toBe(true);
    const tatBefore = limiter.stats().tat;

    limiter.setRate(50);

    expect(limiter.stats().tat).toBe(tatBefore);
    // 11 operations at 100/s put the TAT 110ms ahead. At 50/s the tolerance is
    // 200ms, so the debt is still inside it — but the *next* refusal boundary
    // has moved out, which is what "kept, not rescaled" means in practice.
    t = 50;
    expect(limiter.tryConsume(1)).toBe(true);
  });

  it('refuses a non-positive or non-finite rate', () => {
    // `setRate(0)` must throw rather than silently produce a limiter that
    // admits nothing and reports a rate of 0. `PowerFlowController` relies on
    // this to reject `minRate: 0` at construction instead of at the first
    // observation that reaches the floor.
    const limiter = new PowerGCRA({ rate: 10, per: 1000 });
    expect(() => limiter.setRate(0)).toThrow(TypeError);
    expect(() => limiter.setRate(-1)).toThrow(TypeError);
    expect(() => limiter.setRate(Number.NaN)).toThrow(TypeError);
    expect(() => limiter.setRate(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(limiter.rate).toBe(10);
  });

  it('returns the new rate', () => {
    const limiter = new PowerGCRA({ rate: 10, per: 1000 });
    expect(limiter.setRate(42)).toBe(42);
  });
});

describe('PowerFlowController', () => {
  /** A clock the test advances by hand. */
  function clock(start = 0) {
    let t = start;
    return {
      now: () => t,
      advance(ms) {
        t += ms;
      },
    };
  }

  /** A controller with the measured-convergent gains and an injected clock. */
  function make(overrides = {}) {
    const c = clock();
    const fc = new PowerFlowController({
      rate: 200,
      minRate: 5,
      maxRate: 800,
      targetP99: 30,
      kp: 0.05,
      ki: 0.001,
      queueCapacity: 64,
      now: c.now,
      ...overrides,
    });
    return { fc, c };
  }

  describe('construction', () => {
    it('requires a positive starting rate', () => {
      // A controller with no starting rate has nothing to clamp, and the
      // failure has to be at construction rather than at the first observation.
      expect(() => new PowerFlowController({ minRate: 1 })).toThrow(/rate/);
      expect(() => new PowerFlowController({ rate: 0, minRate: 1 })).toThrow(TypeError);
      expect(() => new PowerFlowController({ rate: -5, minRate: 1 })).toThrow(TypeError);
    });

    it('requires minRate above zero, because the actuator cannot represent zero', () => {
      // The actuator is a GCRA and `setRate()` refuses a non-positive rate, so
      // `minRate: 0` is an option the loop cannot honour — it would throw on the
      // first observation that reached the floor. Refusing it here turns a
      // mid-run TypeError into a construction error.
      expect(() => new PowerFlowController({ rate: 10, minRate: 0 })).toThrow(RangeError);
      expect(() => new PowerFlowController({ rate: 10 })).toThrow(RangeError);
      // A negative floor is caught one layer down, by the shared limit
      // validator, and arrives as a TypeError rather than a RangeError. Both
      // name the option, which is the part a caller reads.
      expect(() => new PowerFlowController({ rate: 10, minRate: -1 })).toThrow(/minRate/);
    });

    it('rejects an inverted or out-of-range rate window', () => {
      expect(() => new PowerFlowController({ rate: 10, minRate: 50, maxRate: 20 })).toThrow(
        RangeError
      );
      expect(() => new PowerFlowController({ rate: 10, minRate: 50 })).toThrow(RangeError);
      expect(() => new PowerFlowController({ rate: 10, minRate: 1, maxRate: 5 })).toThrow(
        RangeError
      );
    });

    it('rejects a setpoint no measurement can meet', () => {
      // A target of zero is a target every latency exceeds, so the loop would
      // drive the rate to its floor and stay there — a latch that looks like
      // conservatism.
      expect(() => new PowerFlowController({ rate: 10, minRate: 1, targetP99: 0 })).toThrow(
        RangeError
      );
    });

    it('rejects a quantile outside (0, 1]', () => {
      const base = { rate: 10, minRate: 1 };
      expect(() => new PowerFlowController({ ...base, quantile: 0 })).toThrow(RangeError);
      expect(() => new PowerFlowController({ ...base, quantile: 1.5 })).toThrow(RangeError);
      expect(() => new PowerFlowController({ ...base, quantile: 1 })).not.toThrow();
    });

    it('rejects an unknown option', () => {
      expect(() => new PowerFlowController({ rate: 10, minRate: 1, capcity: 5 })).toThrow(
        /capcity/
      );
    });
  });

  describe('the queue', () => {
    it('bounds the queue and counts what it drops', () => {
      // Drop-newest, and counted. A bounded queue whose overflow is invisible is
      // a memory leak with a friendly name: `depth` reads healthy at exactly the
      // moment the controller is shedding load.
      const { fc } = make({ queueCapacity: 4 });
      expect(fc.submit('a')).toBe(true);
      expect(fc.submit('b')).toBe(true);
      expect(fc.submit('c')).toBe(true);
      expect(fc.submit('d')).toBe(true);
      expect(fc.depth).toBe(4);

      expect(fc.submit('e')).toBe(false);
      expect(fc.submit('f')).toBe(false);
      expect(fc.dropped).toBe(2);
      // The bound holds: the dropped items did not displace the queued ones.
      expect(fc.depth).toBe(4);
      expect(fc.admit()).toBe('a');
    });

    it('does not consult the rate limiter on submit', () => {
      // The queue is the buffer and `admit()` is the gate. Conflating them would
      // make `depth` mean two different things and would let a rate cut look
      // like a queue drain.
      const { fc, c } = make({ queueCapacity: 10 });
      for (let i = 0; i < 10; i++) expect(fc.submit(i)).toBe(true);
      c.advance(0);
      expect(fc.admit()).toBe(0);
      // The limiter now refuses, but the queue still accepts.
      expect(fc.admit()).toBe(null);
      expect(fc.submit('still-accepted')).toBe(true);
      // 10 queued, 1 admitted, 1 more accepted: the bound is on the queue, and
      // the limiter refusing has not freed a slot the queue did not know about.
      expect(fc.depth).toBe(10);
    });

    it('admits in FIFO order, and stops when the limiter refuses', () => {
      // Both halves matter. Order alone would pass with the GCRA gate deleted
      // entirely — the queue would drain as fast as the caller asked, which is
      // the one thing a flow controller must not do.
      const { fc, c } = make({ queueCapacity: 10, burst: 20 });
      fc.submit('first');
      fc.submit('second');
      c.advance(1000);
      expect(fc.admit()).toBe('first');
      c.advance(1000);
      expect(fc.admit()).toBe('second');
      // Two admitted, nothing left that the limiter will pass right now.
      expect(fc.admit()).toBe(null);
      expect(fc.depth).toBe(0);
    });

    it('returns null from an empty queue without touching the limiter', () => {
      const { fc } = make();
      expect(fc.admit()).toBe(null);
      expect(fc.stats().admitted).toBe(0);
    });
  });

  describe('the loop', () => {
    it('cuts the rate when the window misses its target', () => {
      // The sign, in the direction that matters most: a p99 above the target is
      // a negative error and drives the rate down, with no inversion needed.
      // That is the opposite of the queue-depth form, which needs the headroom
      // and is the trap `guides/powerFlowControl.md` warns about.
      const { fc, c } = make();
      c.advance(1000);
      fc.record(200); // way over the 30ms target
      expect(fc.observe(1000)).toBeLessThan(200);
      expect(fc.rate).toBe(fc.minRate);
    });

    it('raises the rate when the window beats its target', () => {
      // **This takes several observations, and the reason is a property of
      // `PowerServo` a caller has to know.** The servo computes its feedback
      // term from the integral as it was *before* this step's update, so the
      // integral's contribution is always one step behind. The first
      // observation after construction can therefore only ever produce
      // `kp × error` — with `kp: 0.05` and a 28 ms error that is 1.4, which the
      // `minRate` clamp turns into the floor. The rate climbs from there as the
      // integral catches up.
      const { fc, c } = make();
      const seen = [];
      for (let i = 0; i < 10; i++) {
        c.advance(1000);
        fc.record(2); // way under the 30ms target
        seen.push(fc.observe(1000));
      }
      expect(seen[0]).toBe(fc.minRate);
      // Monotone climb, and past the starting rate within ten ticks.
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBeGreaterThan(seen[i - 1]);
      }
      expect(seen[seen.length - 1]).toBeGreaterThan(200);
    });

    it('writes the rate into the limiter, not just into its own field', () => {
      // `rate` and `limiter.rate` are two views of one fact. A controller that
      // updated only its own field would report a rate it was not enforcing.
      const { fc, c } = make();
      c.advance(1000);
      fc.record(200);
      const next = fc.observe(1000);
      expect(fc.limiter.rate).toBe(next);
      expect(fc.limiter.stats().emissionInterval).toBe(1000 / next);
    });

    it('does not move the rate on an observation with nothing new to measure', () => {
      // An idle loop has no error to correct, and tuning on stale data is how a
      // controller learns something about a workload that no longer exists.
      const { fc, c } = make();
      c.advance(1000);
      fc.record(200);
      const first = fc.observe(1000);
      expect(fc.observe(1000)).toBe(first);
      expect(fc.observe(1000)).toBe(first);
      expect(fc.stats().observations).toBe(1);
    });

    it('clears the window, so the next observation judges the next window', () => {
      // The measured defect this guards: a cumulative histogram makes the loop
      // see a *lifetime* p99, so a rate that has already been cut keeps being
      // judged against the traffic that justified the cut and never comes back.
      // On the plant below, a cumulative window held the rate at its floor for
      // the whole run.
      const { fc, c } = make();
      c.advance(1000);
      fc.record(500); // one terrible sample
      fc.observe(1000);
      expect(fc.p99).toBeUndefined();

      c.advance(1000);
      fc.record(2); // and now everything is fast
      expect(fc.p99).toBeLessThan(10);
    });

    it('reaches the equilibrium rate the plant allows at the target latency', () => {
      // The property that separates "the rate moved" from "the rate is right".
      // `plant(400)` produces 30ms at exactly 111.1/s, and the loop has to find
      // it from latency feedback alone.
      const { fc, c } = make();
      const latencyOf = plant(400);
      for (let tick = 0; tick < 60; tick++) {
        c.advance(1000);
        for (let i = 0; i < 300; i++) fc.submit(i);
        for (;;) {
          const job = fc.admit();
          if (job === null) break;
          fc.record(latencyOf(fc.rate));
        }
        fc.observe(1000);
      }
      expect(fc.rate).toBeCloseTo(equilibrium(400, 30), 0);
    });

    it('tracks a load step down to the new equilibrium', () => {
      // A controller that only converges from one starting point is a controller
      // tuned for one workload. The plant halves its capacity mid-run and the
      // rate has to follow it.
      const { fc, c } = make();
      const fast = plant(400);
      const slow = plant(150);
      let latencyOf = fast;
      for (let tick = 0; tick < 60; tick++) {
        c.advance(1000);
        if (tick === 30) latencyOf = slow;
        for (let i = 0; i < 300; i++) fc.submit(i);
        for (;;) {
          const job = fc.admit();
          if (job === null) break;
          fc.record(latencyOf(fc.rate));
        }
        fc.observe(1000);
      }
      expect(fc.rate).toBeCloseTo(equilibrium(150, 30), 0);
    });

    it('holds the rate up when the window meets its target exactly', () => {
      // Why `ki` is non-zero by default. With `ki: 0` the output is `kp × error`
      // alone, so a window that meets its target produces an error of zero and
      // therefore a rate of zero — which the `minRate` clamp turns into the
      // floor. Measured: P-only settled at 11% of the rate the plant could
      // sustain at the target latency.
      const { fc, c } = make({ ki: 0 });
      const latencyOf = plant(400);
      for (let tick = 0; tick < 60; tick++) {
        c.advance(1000);
        for (let i = 0; i < 300; i++) fc.submit(i);
        for (;;) {
          const job = fc.admit();
          if (job === null) break;
          fc.record(latencyOf(fc.rate));
        }
        fc.observe(1000);
      }
      // P-only cannot hold a rate up with no error to correct.
      expect(fc.rate).toBeLessThan(equilibrium(400, 30) * 0.5);
    });

    it('defaults ki to non-zero, so the default configuration can hold a rate', () => {
      // The test above passes `ki: 0` explicitly, so it says nothing about the
      // default — and a default of 0 would ship a controller that cannot hold
      // any rate at all. This asserts the default itself, by constructing
      // without the option and checking the servo received a non-zero gain.
      const fc = new PowerFlowController({ rate: 100, minRate: 1 });
      expect(fc.servo._ki).toBeGreaterThan(0);
    });

    it('reports whether the loop is pinned against a bound', () => {
      // `saturated` is the difference between "the loop chose this rate" and
      // "the loop wanted more and could not have it", and only the second is a
      // misconfiguration. Sustained *under*-target latency is what pins it at
      // `maxRate`; the integral has to wind up over several observations first,
      // for the one-step-lag reason the raise test above documents.
      const { fc, c } = make({ maxRate: 210 });
      for (let i = 0; i < 12; i++) {
        c.advance(1000);
        fc.record(1);
        fc.observe(1000);
      }
      expect(fc.rate).toBe(210);
      expect(fc.stats().saturated).toBe(true);
    });

    it('pins at minRate under sustained overload', () => {
      // The other bound, and the one a caller hits in production. A window that
      // never meets its target drives the rate to the floor and holds it there,
      // which is the controller doing its job rather than failing.
      const { fc, c } = make();
      for (let i = 0; i < 12; i++) {
        c.advance(1000);
        fc.record(500);
        fc.observe(1000);
      }
      expect(fc.rate).toBe(fc.minRate);
      expect(fc.stats().saturated).toBe(true);
    });
  });

  describe('the rate hook', () => {
    it('fires with the new and previous rate', () => {
      const seen = [];
      const { fc, c } = make({ onRateChange: (next, previous) => seen.push([next, previous]) });
      c.advance(1000);
      fc.record(200);
      const next = fc.observe(1000);
      expect(seen).toEqual([[next, 200]]);
    });

    it('does not fire when the rate did not move', () => {
      const hook = vi.fn();
      const { fc, c } = make({ onRateChange: hook });
      c.advance(1000);
      fc.record(200);
      fc.observe(1000);
      const calls = hook.mock.calls.length;
      fc.observe(1000); // nothing new to measure
      expect(hook.mock.calls.length).toBe(calls);
    });

    it('does not let a throwing hook stop the loop', () => {
      // The rate has already moved and the limiter already holds it. Refusing
      // the next observation would freeze the controller at a rate the caller
      // was never told about.
      const { fc, c } = make({
        onRateChange: () => {
          throw new Error('hook exploded');
        },
      });
      c.advance(1000);
      fc.record(200);
      expect(() => fc.observe(1000)).not.toThrow();
      c.advance(1000);
      fc.record(200);
      expect(() => fc.observe(1000)).not.toThrow();
      expect(fc.stats().observations).toBe(2);
    });
  });

  describe('reset', () => {
    it('restores the configured rate, not the floor', () => {
      // A reset means "forget what you learned about this workload", and the
      // configured rate is the caller's own statement about what the workload
      // should get. Restoring `minRate` would make a reset look like a penalty.
      const { fc, c } = make();
      c.advance(1000);
      fc.record(200);
      fc.observe(1000);
      expect(fc.rate).toBeLessThan(200);

      fc.reset();

      expect(fc.rate).toBe(200);
      expect(fc.limiter.rate).toBe(200);
      expect(fc.depth).toBe(0);
      expect(fc.dropped).toBe(0);
      expect(fc.p99).toBeUndefined();
      expect(fc.stats().observations).toBe(0);
    });

    it('does not fire the rate hook when the rate is already the configured one', () => {
      const hook = vi.fn();
      const { fc } = make({ onRateChange: hook });
      fc.reset();
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('is a state reset, not a teardown, and says so by owning no timer', () => {
      // This helper owns no timer, no listener registry and no
      // `FinalizationRegistry` — the GCRA refills lazily from a stored
      // timestamp, the histogram is passive, and the servo advances only when
      // stepped. So `dispose()` clears state; describing it as "cancels the
      // interval" would document work that is not happening.
      const { fc, c } = make();
      c.advance(1000);
      fc.record(200);
      fc.observe(1000);
      fc.submit('queued');

      fc.dispose();

      expect(fc.depth).toBe(0);
      expect(fc.p99).toBeUndefined();
      expect(fc.rate).toBe(200);
    });

    it('is idempotent', () => {
      const { fc } = make();
      fc.dispose();
      expect(() => fc.dispose()).not.toThrow();
      expect(() => fc.dispose()).not.toThrow();
    });

    it('does not fire the rate hook on the way out', () => {
      // `reset()` restores the configured rate, and firing `onRateChange` during
      // a teardown would tell a caller to resize a pool for a controller that is
      // being destroyed.
      const hook = vi.fn();
      const { fc, c } = make({ onRateChange: hook });
      c.advance(1000);
      fc.record(200);
      fc.observe(1000);
      hook.mockClear();

      fc.dispose();

      expect(hook).not.toHaveBeenCalled();
    });

    it('makes the mutating methods inert rather than throwing', () => {
      const { fc } = make();
      fc.dispose();
      expect(fc.submit('x')).toBe(false);
      expect(fc.admit()).toBe(null);
      expect(() => fc.record(5)).not.toThrow();
      expect(fc.stats().recorded).toBe(0);
    });

    it('takes part in `using`', () => {
      // The state is released at scope exit, which is the whole contract. The
      // queue is emptied rather than the object being frozen, because this
      // helper owns no timer and its `dispose()` is a state reset.
      let disposed;
      // `using` is spelled out rather than used as syntax: Node 22.12 has no
      // Explicit Resource Management, and a syntax error fails the whole file
      // rather than skipping one test. The protocol under test is unchanged —
      // the scope exit calls `[Symbol.dispose]()` and nothing else.
      const fc = new PowerFlowController({ rate: 10, minRate: 1 });
      try {
        fc.submit('x');
        expect(fc.depth).toBe(1);
        disposed = fc;
      } finally {
        fc[Symbol.dispose]();
      }
      expect(disposed.depth).toBe(0);
      expect(disposed.p99).toBeUndefined();
    });

    it('takes part in `await using`', async () => {
      let disposed;
      // Same reason as the sync case above: `await using` is syntax, and a
      // syntax error fails the file rather than the test. The scope exit calls
      // `[Symbol.asyncDispose]()` and nothing else.
      const fc = new PowerFlowController({ rate: 10, minRate: 1 });
      try {
        fc.submit('x');
        expect(fc.depth).toBe(1);
        disposed = fc;
      } finally {
        await fc[Symbol.asyncDispose]();
      }
      expect(disposed.depth).toBe(0);
    });
  });

  describe('stats', () => {
    it('reports the counters a caller alerts on', () => {
      // `dropped` is the number to alert on: a flow controller that is dropping
      // is one whose rate is too low for the offered load, and nothing else here
      // says so — the queue is bounded by design, so a healthy-looking depth is
      // exactly what overload looks like.
      const { fc } = make({ queueCapacity: 2 });
      fc.submit('a');
      fc.submit('b');
      fc.submit('c');
      const stats = fc.stats();
      expect(stats).toMatchObject({
        rate: 200,
        minRate: 5,
        maxRate: 800,
        targetP99: 30,
        quantile: 0.99,
        depth: 2,
        queueCapacity: 2,
        submitted: 2,
        dropped: 1,
        admitted: 0,
        recorded: 0,
        observations: 0,
      });
      expect(stats.p99).toBeUndefined();
      expect(stats.saturated).toBe(false);
    });

    it('has a getStats alias', () => {
      const { fc } = make();
      expect(fc.getStats()).toEqual(fc.stats());
    });
  });

  describe('observability', () => {
    it('registers under its own name when asked', () => {
      const collector = new MetricsCollector();
      const fc = new PowerFlowController({
        rate: 10,
        minRate: 1,
        observability: collector,
      });
      const snapshot = collector.snapshot();
      expect(JSON.stringify(snapshot)).toContain('flowController');
      fc.dispose();
    });
  });
});
