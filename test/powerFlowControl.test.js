import { describe, it, expect, vi } from 'vitest';
import { PowerFlowControl } from '../src/helpers/powerFlowControl.js';

// Every test drives the injected clock and the servo's `dt` argument rather than
// wall-clock durations. A control loop whose tests need a real timer is a control
// loop that has grown a sampling policy it should not have.

describe('PowerFlowControl', () => {
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

  describe('the bucket', () => {
    it('starts full and admits up to capacity', () => {
      const flow = new PowerFlowControl({ capacity: 3, initialRate: 0 });
      expect(flow.tokens).toBe(3);
      expect(flow.tryConsume(1)).toBe(true);
      expect(flow.tryConsume(2)).toBe(true);
      expect(flow.tryConsume(1)).toBe(false);
    });

    it('refills at the adaptive rate', () => {
      // The rate is tokens per second, so 10/s over 500ms is 5 tokens. Getting
      // the unit wrong here would make every rate a factor of 1000 out.
      const c = clock();
      const flow = new PowerFlowControl({ capacity: 100, initialRate: 10, now: c.now });
      flow.tryConsume(100);
      expect(flow.tokens).toBe(0);

      c.advance(500);
      expect(flow.tryConsume(5)).toBe(true);
      expect(flow.tryConsume(1)).toBe(false);
    });

    it('carries the fractional remainder rather than dropping it', () => {
      // 3/s over 100ms is 0.3 tokens. Dropping the fraction would make a slow
      // rate admit nothing at all until a whole token accumulated by luck.
      const c = clock();
      const flow = new PowerFlowControl({ capacity: 100, initialRate: 3, now: c.now });
      flow.tryConsume(100);
      for (let i = 0; i < 3; i++) {
        c.advance(100);
        flow.tryConsume(0);
      }
      c.advance(100);
      expect(flow.tryConsume(1)).toBe(true);
    });

    it('admits nothing while the rate is closed', () => {
      const c = clock();
      const flow = new PowerFlowControl({ capacity: 10, initialRate: 0, now: c.now });
      flow.tryConsume(10);
      c.advance(10000);
      expect(flow.tryConsume(1)).toBe(false);
    });

    it('does not release a burst covering a closed interval', () => {
      // A closed bucket still advances its refill timestamp. If it did not,
      // reopening the rate would release every token the closed interval had
      // earned, which is the burst the limit exists to prevent.
      const c = clock();
      const flow = new PowerFlowControl({ capacity: 1000, initialRate: 0, now: c.now });
      flow.tryConsume(1000);
      c.advance(60000); // closed for a minute at 0/s
      flow.observe(0, 1000); // controller opens the rate
      c.advance(1000);
      // One second at whatever rate the controller chose, not a minute's worth.
      expect(flow.tokens).toBeLessThanOrEqual(flow.rate);
    });

    it('caps the bucket at capacity', () => {
      const c = clock();
      const flow = new PowerFlowControl({ capacity: 5, initialRate: 1000, now: c.now });
      c.advance(10000);
      flow.tryConsume(0);
      expect(flow.tokens).toBe(5);
    });

    it('rejects a non-finite or negative count', () => {
      const flow = new PowerFlowControl({ capacity: 5 });
      expect(() => flow.tryConsume(-1)).toThrow(/non-negative finite/);
      expect(() => flow.tryConsume(Number.NaN)).toThrow(/non-negative finite/);
    });

    it('treats a zero count as admitted without touching the bucket', () => {
      const flow = new PowerFlowControl({ capacity: 5, initialRate: 0 });
      expect(flow.tryConsume(0)).toBe(true);
      expect(flow.tokens).toBe(5);
    });
  });

  describe('the controller moves the rate', () => {
    it('raises the rate when the measurement is below the setpoint', () => {
      // The direction the whole feature rests on: a queue deeper than the
      // setpoint must produce a higher rate, or the helper is not a controller.
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 10,
        minRate: 0,
        maxRate: 1000,
        setpoint: 100,
        kp: 1,
      });
      flow.observe(0, 1);
      expect(flow.rate).toBeGreaterThan(10);
    });

    it('lowers the rate when the measurement is above the setpoint', () => {
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 100,
        minRate: 0,
        maxRate: 1000,
        setpoint: 0,
        kp: 1,
      });
      flow.observe(100, 1);
      expect(flow.rate).toBeLessThan(100);
    });

    it('raises the rate as the queue deepens, observing headroom', () => {
      // The flow-control recipe, end to end. A deeper queue is a smaller
      // headroom, and a smaller headroom is a larger error, so the rate rises.
      // This is the test that would catch the sign being flipped.
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 1,
        minRate: 0,
        maxRate: 1000,
        setpoint: 50,
        kp: 1,
      });
      const shallow = flow.rate;
      flow.observe(50 - 10, 1); // depth 10, headroom 40
      const atTen = flow.rate;
      flow.observe(50 - 90, 1); // depth 90, headroom -40
      expect(atTen).toBeGreaterThan(shallow);
      expect(flow.rate).toBeGreaterThan(atTen);
    });

    it('clamps the rate to [minRate, maxRate]', () => {
      // The integration the row names: the servo's bounds ARE the rate bounds,
      // so the controller cannot ask for a rate the bucket would refuse.
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 10,
        minRate: 5,
        maxRate: 20,
        setpoint: 0,
        kp: 10,
      });
      // A measurement far ABOVE the setpoint is a large negative error, so the
      // output clamps to the floor; far BELOW clamps to the ceiling. My first
      // draft had these the wrong way round.
      flow.observe(1000, 1);
      expect(flow.rate).toBe(5);
      flow.observe(-1000, 1);
      expect(flow.rate).toBe(20);
    });

    it('reports the new rate through onRateChange', () => {
      const seen = [];
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 10,
        maxRate: 1000,
        setpoint: 100,
        kp: 1,
        onRateChange: (rate, previous) => seen.push([rate, previous]),
      });
      flow.observe(0, 1);
      expect(seen).toHaveLength(1);
      expect(seen[0][1]).toBe(10);
      expect(seen[0][0]).toBeGreaterThan(10);
    });

    it('does not fire onRateChange when the rate has not moved', () => {
      // A hook that fires per observation rather than per change would make a
      // caller push the rate into a pool on every tick, which is the churn the
      // hook exists to avoid.
      const hook = vi.fn();
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 0,
        maxRate: 1000,
        setpoint: 4,
        kp: 0,
        onRateChange: hook,
      });
      flow.observe(4, 1);
      flow.observe(4, 1);
      expect(hook).not.toHaveBeenCalled();
    });

    it('keeps observing when onRateChange throws', () => {
      // The rate has already moved. Refusing the next observation would freeze
      // the loop at a stale rate, which is the failure the controller exists to
      // prevent.
      const flow = new PowerFlowControl({
        capacity: 100,
        initialRate: 10,
        maxRate: 1000,
        setpoint: 100,
        kp: 1,
        onRateChange: () => {
          throw new Error('boom');
        },
      });
      expect(() => flow.observe(0, 1)).not.toThrow();
      expect(flow.rate).toBeGreaterThan(10);
      expect(() => flow.observe(20, 1)).not.toThrow();
    });

    it('refuses a non-finite measurement', () => {
      // A NaN measurement would poison the integrator permanently, and the
      // bucket would then admit at a rate no comparison can catch.
      const flow = new PowerFlowControl({ capacity: 10, setpoint: 4, kp: 1 });
      expect(() => flow.observe(Number.NaN, 1)).toThrow(/finite number/);
    });

    it('exposes the servo for runtime retuning', () => {
      // The gains are the caller's to set. A second set of accessors here would
      // be a second place for them to drift.
      const flow = new PowerFlowControl({ capacity: 10, setpoint: 4, kp: 1 });
      flow.servo.setpoint = 8;
      expect(flow.servo.setpoint).toBe(8);
    });
  });

  describe('validation', () => {
    it('accepts a bare number as the capacity', () => {
      const flow = new PowerFlowControl(8);
      expect(flow.capacity).toBe(8);
    });

    it('rejects a capacity below 1', () => {
      // A bucket of 0 admits nothing, so the helper would be inert rather than
      // merely strict.
      expect(() => new PowerFlowControl({ capacity: 0 })).toThrow(/>= 1/);
    });

    it('rejects an inverted rate range', () => {
      expect(() => new PowerFlowControl({ minRate: 10, maxRate: 5 })).toThrow(
        /maxRate .* must be >= minRate/
      );
    });

    it('rejects an initial rate outside the range', () => {
      expect(() => new PowerFlowControl({ initialRate: 100, maxRate: 10 })).toThrow(
        /initialRate .* must be within/
      );
    });

    it('rejects an unknown option', () => {
      expect(() => new PowerFlowControl({ capcity: 5 })).toThrow(/unknown option/);
    });

    it('accepts an unbounded maxRate', () => {
      // `Infinity` is a legitimate "no ceiling" for a rate, exactly as it is for
      // `maxWeight` elsewhere.
      const flow = new PowerFlowControl({ maxRate: Number.POSITIVE_INFINITY });
      expect(flow.stats().maxRate).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('reset and clear', () => {
    it('resumes from the configured initial rate', () => {
      // Restarting from 0 on a bucket whose minRate is above 0 would admit
      // nothing until the controller moved it back.
      const flow = new PowerFlowControl({
        capacity: 10,
        initialRate: 25,
        minRate: 5,
        maxRate: 100,
        setpoint: 0,
        kp: 10,
      });
      flow.observe(100, 1);
      expect(flow.rate).not.toBe(25);
      flow.reset();
      expect(flow.rate).toBe(25);
      expect(flow.tokens).toBe(10);
      expect(flow.stats().observations).toBe(0);
    });

    it('clear is an alias of reset', () => {
      const flow = new PowerFlowControl({ capacity: 10, initialRate: 5 });
      flow.tryConsume(10);
      flow.clear();
      expect(flow.tokens).toBe(10);
      expect(flow.rate).toBe(5);
    });
  });

  describe('disposal', () => {
    it('clears state, because this helper owns no timer', () => {
      // The dispose rule's second half. `dt` is an argument, so there is no
      // clock to cancel — and describing `dispose()` as "cancels the interval"
      // would document work that is not happening. What it does do is drop the
      // bucket, as the sibling helpers do, so a caller that ignored the refusal
      // below cannot believe it still had capacity.
      const flow = new PowerFlowControl({ capacity: 10 });
      flow.tryConsume(5);
      flow.dispose();
      expect(flow.tokens).toBe(0);
    });

    it('refuses consumption after dispose', () => {
      const flow = new PowerFlowControl({ capacity: 10 });
      flow.dispose();
      expect(flow.tryConsume(1)).toBe(false);
    });

    it('stops moving the rate after dispose', () => {
      const flow = new PowerFlowControl({ capacity: 10, setpoint: 4, kp: 1 });
      const before = flow.rate;
      flow.dispose();
      flow.observe(100, 1);
      expect(flow.rate).toBe(before);
    });

    it('is idempotent', () => {
      const flow = new PowerFlowControl({ capacity: 10 });
      flow.dispose();
      expect(() => flow.dispose()).not.toThrow();
    });

    it('supports using and await using', () => {
      {
        using f = new PowerFlowControl({ capacity: 10 });
        expect(f.tokens).toBe(10);
      }
      expect(typeof PowerFlowControl.prototype[Symbol.dispose]).toBe('function');
      expect(typeof PowerFlowControl.prototype[Symbol.asyncDispose]).toBe('function');
    });
  });

  describe('stats', () => {
    it('reports the shape a caller would alert on', () => {
      const flow = new PowerFlowControl({
        capacity: 10,
        initialRate: 20,
        minRate: 1,
        maxRate: 100,
        setpoint: 4,
        kp: 1,
      });
      flow.observe(10, 1);
      flow.observe(10, 1);
      expect(flow.stats()).toEqual({
        rate: flow.rate,
        tokens: flow.tokens,
        capacity: 10,
        minRate: 1,
        maxRate: 100,
        observations: 2,
      });
    });

    it('getStats is an alias of stats', () => {
      const flow = new PowerFlowControl({ capacity: 10 });
      expect(flow.getStats()).toEqual(flow.stats());
    });
  });

  describe('metrics', () => {
    it('registers and detaches like every other helper', () => {
      // The attach/detach symmetry B2 audited family-wide. A helper added
      // without it would be the one the source-count guard catches.
      const flow = new PowerFlowControl({ capacity: 10, observability: true });
      expect(flow._metrics).not.toBeNull();
      flow.dispose();
      expect(flow._metrics).toBeNull();
    });

    it('attaches nothing by default', () => {
      const flow = new PowerFlowControl({ capacity: 10 });
      expect(flow._metrics).toBeNull();
    });
  });
});
