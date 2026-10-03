import { describe, it, expect } from 'vitest';
import { PowerServo } from '../src/index.js';

/**
 * `PowerServo` — the closed-loop transfer function.
 *
 * The cases that are here rather than in a "does PI converge" test are the three
 * the helper exists to stop a caller getting wrong by hand: derivative kick on
 * a setpoint step, integrator windup while the output is saturated, and raw
 * numerical differentiation amplifying measurement noise. Each of those is a
 * counter, not a duration — this harness measures a ~28 % median spread, so a
 * timing assertion here would be decoration.
 */
describe('PowerServo', () => {
  describe('the derivative is taken on the measurement, not on the error', () => {
    it('a setpoint step produces no derivative term', () => {
      // **The reason the helper exists.** Differentiating `setpoint - measured`
      // spikes in proportion to how far the setpoint moved, which is why
      // hand-rolled PIDs overshoot hardest exactly when an operator retunes.
      // With the derivative on the measurement the setpoint does not appear in
      // the term at all, so this is a flat 0 rather than merely a small number.
      const servo = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
      servo.step(100, 1); // establishes the measurement history
      expect(servo.derivative).toBe(0);

      servo.setpoint = 5000; // a large, instant setpoint step
      servo.step(100, 1);
      expect(servo.derivative).toBe(0);
      expect(servo.output).toBe(0);
    });

    it('a falling measurement drives the output down, the way an error derivative would drive it up', () => {
      // The sign is the whole distinction. With `de/dt` a rising measurement
      // makes `de/dt` negative, so the derivative term would *raise* the output
      // as the plant got closer — fighting the proportional term. On the
      // measurement the two agree, and both push the same way.
      const servo = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
      servo.step(0, 1);
      servo.step(100, 1); // measured rises 0 -> 100 over 1 time unit
      expect(servo.derivative).toBe(-100);

      const up = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
      up.step(100, 1);
      up.step(0, 1); // measured falls 100 -> 0
      expect(up.derivative).toBe(100);
    });

    it('has no derivative on the first sample, and does not force the term to zero afterwards', () => {
      // There is no previous measurement on the first call, so there is no
      // slope. Zeroing the derivative term here would make the output step once
      // at the start of every run, which is a start-up transient the caller did
      // not ask for.
      const servo = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
      servo.step(50, 1);
      expect(servo.derivative).toBe(0);
      expect(servo.output).toBe(0);

      servo.step(40, 1);
      expect(servo.derivative).toBe(10);
    });

    it('kd: 0 disables the derivative path outright', () => {
      // Not just multiplied by zero: with `kd: 0` there is no filtering, no
      // division and no `previousMeasured` bookkeeping, so a caller who does not
      // want a derivative pays nothing for one.
      const servo = new PowerServo({ setpoint: 0, kp: 1, ki: 0, kd: 0, min: -1e9, max: 1e9 });
      servo.step(0, 1);
      servo.step(1000, 1);
      expect(servo.derivative).toBe(0);
      // The output is purely proportional: error -1000 at kp 1.
      expect(servo.output).toBe(-1000);
    });

    it('low-pass filters the derivative when asked, and passes it raw at 0', () => {
      const raw = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, derivativeFilter: 0 });
      const filtered = new PowerServo({
        setpoint: 0,
        kp: 0,
        ki: 0,
        kd: 1,
        derivativeFilter: 0.5,
        min: -1e9,
        max: 1e9,
      });
      raw.min = -1e9;
      raw.max = 1e9;
      raw.step(0, 1);
      filtered.step(0, 1);
      // A 100-unit slope in one sample. Raw tracks it immediately; a 0.5 filter
      // has only covered half of it.
      raw.step(100, 1);
      filtered.step(100, 1);
      expect(raw.derivative).toBe(-100);
      expect(filtered.derivative).toBe(-50);
    });
  });

  describe('the integrator cannot wind up', () => {
    // Every figure in this block was measured against a back-calculation
    // implementation first, and clamping is what replaced it. The numbers are
    // pinned exactly rather than as bounds, because the difference between the
    // two mechanisms *is* the reason this one is here — a loose bound would pass
    // under either.
    //
    //   kp 0.5, ki 2, setpoint 100, measured 0, min 0, max 8, dt 1
    //     error +100, proportional term 50, so ki*I has [-50, -42] to live in
    //     clamping pins I at  -21   back-calculation parked it at  +179
    //     on release: clamping 1 step to get off max, back-calculation 10
    //     with the tracking sign inverted: 3.96e+152 after 500 steps, no return
    //   The mirror case below pins +25, not +21: see that test for why.

    it('pins the integral at the largest value the output can actually use', () => {
      // The bug this prevents: plant pinned at `max`, error stays positive, so a
      // plain integrator grows without limit for as long as the condition lasts.
      // When the obstruction clears the loop then sits at `max` for just as
      // long, because it is still paying off a debt it can never spend.
      const servo = new PowerServo({ setpoint: 100, kp: 0.5, ki: 2, max: 8, min: 0 });
      for (let i = 0; i < 500; i++) {
        expect(servo.step(0, 1)).toBe(8);
      }
      // -42 / 2, and 42 is `8 - 0 - 50`: what is left of [0, 8] once the
      // proportional term has taken 50 of it.
      expect(servo.integral).toBeCloseTo(-21, 10);
      // The pinned integral is exactly the one that keeps the output on the
      // bound rather than past it, so there is no hidden debt at all.
      expect(0.5 * 100 + 2 * servo.integral).toBeCloseTo(8, 10);
    });

    it('holds the pin no matter how long the condition lasts', () => {
      // The property is that it *stopped*, not that it is small — a controller
      // still climbing at tick 500 is the same defect at a slower rate.
      const servo = new PowerServo({ setpoint: 100, kp: 0.5, ki: 2, max: 8, min: 0 });
      for (let i = 0; i < 500; i++) servo.step(0, 1);
      const pinned = servo.integral;
      for (let i = 0; i < 5000; i++) servo.step(0, 1);
      expect(servo.integral).toBeCloseTo(pinned, 10);
    });

    it('releases in one step when the obstruction clears', () => {
      // The consequence, which is what a user actually notices. Drive it into
      // saturation, then let the measurement reach the setpoint.
      const servo = new PowerServo({ setpoint: 100, kp: 0.5, ki: 2, max: 8, min: 0 });
      for (let i = 0; i < 400; i++) servo.step(0, 1);
      expect(servo.saturated).toBe(true);

      // The obstruction is gone and the plant is exactly on target, so the
      // correct output is `kp * 0 = 0`. Anything else is windup being paid off.
      expect(servo.step(100, 1)).toBe(0);
      expect(servo.integral).toBe(0);
      // Still `true`, resting against `min` rather than `max`. The flag answers
      // "is the loop against a limit", and a controller whose correct answer is
      // the floor is against one — the caller can read `output` to tell which.
      expect(servo.saturated).toBe(true);
    });

    it('does not overshoot the other way either', () => {
      // The clamp is two-sided. A controller pinned at `min` by a negative
      // error must not come off `min` and overshoot on release.
      const servo = new PowerServo({ setpoint: 0, kp: 0.5, ki: 2, max: 8, min: 0 });
      for (let i = 0; i < 400; i++) expect(servo.step(100, 1)).toBe(0);
      // 25, not -21's mirror. The two directions do not give mirror figures: the
      // window is `[min - ff - kp·e, max - ff - kp·e]`, and at error -100 the
      // proportional term is -50, so the integral must supply +50 just to reach
      // `min` — 50/2. The `+21` above is (8 - 50)/2, because there the
      // proportional term had already spent 50 of an 8-wide window.
      expect(servo.integral).toBeCloseTo(25, 10);
      expect(servo.step(0, 1)).toBe(8);
      // Re-clamped into the new window: with the error gone the proportional
      // term is 0, so ki*I may occupy all of [0, 8] and 50 came down to 8/2.
      expect(servo.integral).toBeCloseTo(4, 10);
    });

    it('leaves the feedforward and proportional terms inside the clamp window', () => {
      // The clamp window is `bounds - ff - kp·e`, not `bounds`. Ignoring `ff`
      // would let a large feedforward push the output out of bounds the moment
      // the loop is otherwise idle — the exact case feedforward exists for.
      const servo = new PowerServo({
        setpoint: 10,
        kp: 0,
        ki: 1,
        min: 0,
        max: 8,
        feedforwardGain: 100,
      });
      for (let i = 0; i < 100; i++) servo.step(0, 1, 1);
      // ff is 100, so the integral may not exceed -92; without the ff offset it
      // would have been allowed up to +8 and the loop would be 92 over budget.
      expect(servo.integral).toBeCloseTo(-92, 10);
      expect(servo.output).toBe(8);
    });

    it('still integrates normally when the output is not saturated', () => {
      // Anti-windup must not quietly become integral clamping-into-nothing. A PI
      // controller is *supposed* to keep integrating error while it is inside
      // its bounds — that is what removes a steady-state offset.
      const servo = new PowerServo({ setpoint: 10, kp: 1, ki: 1, min: -1e6, max: 1e6 });
      servo.step(0, 1);
      const afterOne = servo.integral;
      servo.step(0, 1);
      expect(afterOne).toBe(10);
      expect(servo.integral).toBe(20);
    });

    it('ki: 0 disables the integrator, so there is nothing to wind up', () => {
      // The clamp divides by `ki`; with `ki: 0` the whole block is skipped rather
      // than producing a division by zero.
      const servo = new PowerServo({ setpoint: 1000, kp: 1, ki: 0, min: 0, max: 8 });
      expect(servo.step(0, 1)).toBe(8);
      expect(servo.integral).toBe(0);
      expect(Number.isFinite(servo.integral)).toBe(true);
    });
  });

  describe('feedforward, the open-loop path', () => {
    it('a function contributes before the error moves', () => {
      // The point of the open-loop term: with no error at all — measured exactly
      // on the setpoint — the feedforward path can still command an output. That
      // is what lets it react to a disturbance before the measurement shows it.
      const servo = new PowerServo({
        setpoint: 10,
        kp: 1,
        ki: 0,
        kd: 0,
        min: -1e6,
        max: 1e6,
        feedforward: ({ disturbance }) => disturbance * 3,
      });
      expect(servo.step(10, 1, 4)).toBe(12);
      expect(servo.error).toBe(0);
    });

    it('is handed the measured value, the setpoint, the disturbance and the last output', () => {
      // A feedforward function that has to guess its inputs cannot be a transfer
      // function, it is a closure over whatever happened to be in scope.
      const seen = [];
      const servo = new PowerServo({
        setpoint: 10,
        kp: 1,
        ki: 0,
        kd: 0,
        min: -1e6,
        max: 1e6,
        feedforward: (ctx) => {
          seen.push({ ...ctx });
          return 0;
        },
      });
      servo.step(2, 1, 7);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ measured: 2, setpoint: 10, disturbance: 7, output: 0 });
      servo.step(3, 1, 8);
      // `output` is the *previous* step's, which is what makes a feedforward
      // function able to build on where the loop already is: `kp: 1` at
      // setpoint 10 against measured 2 left it at 8.
      expect(seen[1].output).toBe(8);
    });

    it('a gain is the static form of the same thing', () => {
      const servo = new PowerServo({
        setpoint: 0,
        kp: 0,
        ki: 0,
        kd: 0,
        min: -1e6,
        max: 1e6,
        feedforwardGain: 2,
      });
      expect(servo.step(0, 1, 5)).toBe(10);
    });

    it('is skipped entirely when neither is configured', () => {
      const servo = new PowerServo({ setpoint: 0, kp: 1, ki: 0, kd: 0, min: -1e6, max: 1e6 });
      expect(servo.step(0, 1, 999)).toBe(0);
    });

    it('a non-finite contribution throws rather than poisoning the integrator', () => {
      // A NaN passes every comparison a clamp performs — it is neither `<` nor
      // `>` anything — so it would survive the bounds and then be integrated
      // forever. Refusing is the only recovery that leaves the loop usable.
      const servo = new PowerServo({
        setpoint: 0,
        kp: 1,
        ki: 1,
        kd: 0,
        feedforward: () => NaN,
      });
      expect(() => servo.step(0, 1)).toThrow(/feedforward returned NaN/);
      expect(() => servo.step(0, 1)).toThrow(/finite number/);
    });

    it('a non-numeric feedforward option is rejected at construction', () => {
      expect(() => new PowerServo({ feedforward: 'nope' })).toThrow(/function or a number/);
    });
  });

  describe('bounds', () => {
    it('clamps the output, and reports that it did', () => {
      const servo = new PowerServo({ setpoint: 1000, kp: 1, ki: 0, kd: 0, min: 2, max: 6 });
      expect(servo.step(0, 1)).toBe(6);
      expect(servo.saturated).toBe(true);
      expect(servo.step(1000, 1)).toBe(2);
      expect(servo.saturated).toBe(true);
    });

    it('an unbounded servo is the default, in both directions', () => {
      const servo = new PowerServo({ setpoint: 0, kp: 1, ki: 0, kd: 0 });
      expect(servo.step(-1e12, 1)).toBe(1e12);
      expect(servo.saturated).toBe(false);
    });

    it('rejects an inverted range', () => {
      // An inverted range has no output inside it, so every step would clamp to
      // a value outside `[min, max]` and the loop would have no fixed point.
      expect(() => new PowerServo({ min: 10, max: 2 })).toThrow(RangeError);
      expect(() => new PowerServo({ min: 10, max: 2 })).toThrow(/must be >= min/);
    });

    it('accepts min === max, which is a fixed output rather than a broken one', () => {
      const servo = new PowerServo({ setpoint: 0, kp: 1, ki: 5, min: 4, max: 4 });
      expect(servo.step(1000, 1)).toBe(4);
      expect(servo.step(-1000, 1)).toBe(4);
    });
  });

  describe('time', () => {
    it('defaults dt to the constructor value, and 1 when none was given', () => {
      // A controller that silently assumed a tick rate it does not know would
      // integrate at the wrong scale, and the error would look like bad tuning
      // rather than a bad default.
      const defaulted = new PowerServo({ setpoint: 0, kp: 0, ki: 1, min: -1e9, max: 1e9 });
      defaulted.step(0);
      expect(defaulted.integral).toBe(0); // error 0, so nothing accumulated
      defaulted.setpoint = 10;
      defaulted.step(0);
      expect(defaulted.integral).toBe(10);

      const configured = new PowerServo({
        setpoint: 0,
        kp: 0,
        ki: 1,
        dt: 0.5,
        min: -1e9,
        max: 1e9,
      });
      configured.setpoint = 10;
      configured.step(0);
      expect(configured.integral).toBe(5);
    });

    it('an explicit dt overrides the default, and scales the integral by it', () => {
      const servo = new PowerServo({ setpoint: 10, kp: 0, ki: 1, dt: 1, min: -1e9, max: 1e9 });
      servo.step(0, 4);
      expect(servo.integral).toBe(40);
    });

    it('a negative dt is treated as zero rather than running the integrator backwards', () => {
      const servo = new PowerServo({ setpoint: 10, kp: 0, ki: 1, min: -1e9, max: 1e9 });
      servo.step(0, -5);
      expect(servo.integral).toBe(0);
    });
  });

  describe('measured, the process variable', () => {
    it('refuses a non-finite measurement', () => {
      const servo = new PowerServo({ setpoint: 1, kp: 1, ki: 1, kd: 1 });
      expect(() => servo.step(NaN, 1)).toThrow(TypeError);
      expect(() => servo.step(Infinity, 1)).toThrow(/finite number/);
    });

    it('is still usable after refusing one', () => {
      // The point of throwing rather than absorbing: a loop that swallowed a
      // NaN would be permanently wrong, and the caller would have no signal.
      const servo = new PowerServo({ setpoint: 10, kp: 1, ki: 1, kd: 0, min: -1e9, max: 1e9 });
      expect(() => servo.step(NaN, 1)).toThrow();
      expect(servo.step(0, 1)).toBe(10);
      expect(Number.isFinite(servo.integral)).toBe(true);
    });
  });

  describe('reset and dispose', () => {
    it('reset clears the state and keeps the configuration', () => {
      // A caller resetting between workloads wants the tuning they already
      // chose; only the conclusions drawn about the old workload are stale.
      const servo = new PowerServo({ setpoint: 10, kp: 0.5, ki: 2, min: 1, max: 99 });
      servo.step(0, 1);
      servo.step(0, 1);
      expect(servo.integral).not.toBe(0);

      servo.reset();
      expect(servo.integral).toBe(0);
      expect(servo.derivative).toBe(0);
      expect(servo.output).toBe(0);
      expect(servo.error).toBe(0);
      expect(servo.saturated).toBe(false);
      expect(servo.setpoint).toBe(10);
      expect(servo.min).toBe(1);
      expect(servo.max).toBe(99);
    });

    it('reset drops the remembered measurement, so the next step has no derivative', () => {
      const servo = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
      servo.step(0, 1);
      servo.step(100, 1);
      expect(servo.derivative).toBe(-100);
      servo.reset();
      servo.step(500, 1);
      // Carrying the slope across a reset would make the first step after every
      // reset depend on a measurement the caller has already discarded.
      expect(servo.derivative).toBe(0);
    });

    it('dispose is a state reset, and the instance stays usable', () => {
      // **A reset and not a teardown.** This class owns no timer and no
      // listener, so there is nothing to cancel. Documenting it as a teardown
      // and then throwing on the second call would describe work that does not
      // happen.
      const servo = new PowerServo({ setpoint: 10, kp: 1, ki: 1, min: -1e9, max: 1e9 });
      servo.step(0, 1);
      servo.dispose();
      expect(servo.integral).toBe(0);
      expect(servo.output).toBe(0);

      servo.step(0, 1);
      expect(servo.integral).toBe(10);
      expect(() => servo.dispose()).not.toThrow();
      expect(servo.integral).toBe(0);
    });

    it('has Symbol.dispose, so it works with `using`', () => {
      expect(typeof PowerServo.prototype[Symbol.dispose]).toBe('function');
      let captured;
      {
        using servo = new PowerServo({ setpoint: 10, kp: 1, ki: 1, min: -1e9, max: 1e9 });
        captured = servo;
        servo.step(0, 1);
        expect(captured.integral).toBe(10);
      }
      expect(captured.integral).toBe(0);
    });
  });

  describe('the loop cannot diverge', () => {
    // The headline claim, so it is a test rather than a comment: the output is
    // clamped to `[min, max]` every step, and the integral is clamped so it can
    // only push the output *within* those bounds. The clamp does not consult the
    // gains for its bounds — only for which part of the window the integral may
    // occupy — so no gain configuration escapes.
    //
    // Counters and shapes, no durations: the harness measures a ~28 % median
    // spread, so an assertion about how *fast* the loop settles would be noise.

    /**
     * A first-order lag with a pure transport delay — the plant shape that
     * actually makes a PI loop go unstable, rather than a bare gain.
     *
     * Split into `measure()` / `apply(u)` because the order matters: read the
     * plant, decide, then move the plant. A first draft passed the plant's own
     * past state instead of the controller output, which builds a self-feedback
     * loop with no external input — it never moves, and a section that measures
     * nothing is indistinguishable from one that measured stability.
     */
    const makePlant = (gain, tauMs, delayMs, dt) => {
      let y = 0;
      const queue = [];
      const stepsBack = Math.max(0, Math.round(delayMs / dt));
      return {
        apply(u) {
          queue.push(u);
          const delayed = queue.length > stepsBack ? queue[queue.length - 1 - stepsBack] : 0;
          y += ((gain * delayed - y) * dt) / tauMs;
        },
        measure: () => y,
      };
    };

    const runLoop = ({ kp, ki, kd, dt, steps = 4000 }) => {
      const plant = makePlant(1, 200, 300, dt);
      const servo = new PowerServo({ setpoint: 100, kp, ki, kd, min: 0, max: 100 });
      let worst = null;
      for (let i = 0; i < steps; i++) {
        const u = servo.step(plant.measure(), dt);
        if (!Number.isFinite(u) || u < -1e-9 || u > 100 + 1e-9) {
          worst = { i, u };
          break;
        }
        plant.apply(u);
      }
      return { servo, plant, worst };
    };

    it('keeps the output inside its bounds across a gain and sample-rate sweep', () => {
      // The sweep that established the property, as an assertion. Anything that
      // lets the output leave `[min, max]` fails here rather than in production.
      let checked = 0;
      for (const kp of [0.2, 0.6, 1.5, 3, 6]) {
        for (const ki of [0, 0.02, 0.5]) {
          for (const kd of [0, 0.5]) {
            for (const dt of [1, 10, 100]) {
              const { worst } = runLoop({ kp, ki, kd, dt });
              expect(worst, `kp:${kp} ki:${ki} kd:${kd} dt:${dt}`).toBeNull();
              checked += 1;
            }
          }
        }
      }
      expect(checked).toBe(90);
    });

    it('converges on a plant with transport delay', () => {
      // 200 ms lag, 300 ms dead time, sampled at 10 ms.
      const { servo, plant } = runLoop({ kp: 0.6, ki: 0.02, kd: 0, dt: 10 });
      expect(Math.abs(100 - plant.measure())).toBeLessThan(1);
      expect(Math.abs(100 - servo.output)).toBeLessThan(1);
    });

    it('converges when the gains are run 100x faster than they were tuned for', () => {
      // The case that *would* oscillate if the integral were not clamped: the
      // same gains acting 100x too quickly relative to the plant. A window, not
      // an exact figure, because this is a discrete loop.
      for (const dt of [100, 10, 1]) {
        const { servo, plant } = runLoop({ kp: 0.6, ki: 0.02, kd: 0, dt });
        expect(Math.abs(100 - plant.measure()), `dt:${dt}`).toBeLessThan(1);
        expect(Math.abs(100 - servo.output), `dt:${dt}`).toBeLessThan(1);
      }
    });

    it('bounds the integral contribution, not merely the output', () => {
      // The two clamps are separate properties and either alone is insufficient:
      // an unbounded output with a bounded integral is a loud controller, and a
      // bounded output with an unbounded integral is a loop about to be released
      // into a wall.
      const servo = new PowerServo({ setpoint: 100, kp: 0.6, ki: 0.5, min: 0, max: 100 });
      const plant = makePlant(1, 200, 300, 10);
      for (let i = 0; i < 3000; i++) {
        servo.step(plant.measure(), 10);
        plant.apply(servo.output);
        expect(Math.abs(0.5 * servo.integral)).toBeLessThanOrEqual(100 + 1e-9);
      }
    });

    it('keeps an unstable tuning bounded rather than divergent', () => {
      // The sweep above establishes bounds in all 90 combinations. It does
      // **not** establish convergence in all 90, and an earlier version of the
      // claim said it did: at `kp: 3` with `dt: 100` this plant limit-cycles the
      // full 0→100 every two seconds, indefinitely. Measured over 20 s, at
      // `kp: 6` and `dt: 10` as well.
      //
      // That is the plant's transport delay and not the arithmetic — 300 ms of
      // dead time caps the loop gain near `tau / delay`, so any PI oscillates
      // there. What the clamp buys is that the oscillation stays *bounded*, and
      // that `saturated` reports it. Without this test the property is only ever
      // stated in prose, and prose is what was wrong the first time.
      for (const [kp, ki, dt] of [
        [3, 0.02, 100],
        [6, 0.02, 10],
        [6, 0.02, 1],
      ]) {
        const plant = makePlant(1, 200, 300, dt);
        const servo = new PowerServo({ setpoint: 100, kp, ki, kd: 0, min: 0, max: 100 });
        let saturatedTicks = 0;
        for (let i = 0; i < Math.ceil(20000 / dt); i++) {
          const u = servo.step(plant.measure(), dt);
          expect(Number.isFinite(u), `kp:${kp} dt:${dt} step:${i}`).toBe(true);
          expect(u).toBeGreaterThanOrEqual(0);
          expect(u).toBeLessThanOrEqual(100);
          if (servo.saturated) saturatedTicks += 1;
          plant.apply(u);
        }
        // Bounded, and loud: a limit-cycling loop spends most of its time against
        // a bound, which is what makes this a diagnosable tuning problem rather
        // than a silent one. Not asserted as an exact fraction — the count is a
        // shape, not a constant, and this harness cannot pin timing.
        expect(saturatedTicks, `kp:${kp} dt:${dt}`).toBeGreaterThan(0);
        expect(Number.isFinite(servo.integral)).toBe(true);
        // The window the integral's contribution must lie in, which is the
        // property that actually delivers the bounded output:
        // `u = kp·e + ki·I`, so `ki·I` may occupy `[min − kp·e, max − kp·e]`.
        // It is *not* simply `[min, max]` — a large negative error makes `kp·e`
        // very negative and the integral has to supply a correspondingly large
        // positive contribution to pull the output back inside the bounds. That
        // offset is the anti-windup window, and it is why an assertion of
        // `|ki·I| <= max` passes on a converging loop and fails here.
        const contribution = ki * servo.integral;
        const lo = 0 - kp * servo.error;
        const hi = 100 - kp * servo.error;
        expect(contribution, `kp:${kp} dt:${dt}`).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(contribution, `kp:${kp} dt:${dt}`).toBeLessThanOrEqual(hi + 1e-9);
      }
    });
  });

  describe('every route to an unrecoverable state is refused', () => {
    // All four of these were found by a probe, not by reading the source, and
    // every one of them was **silent** — the loop kept returning a number. That
    // is what makes them dangerous, and it is why each case also asserts that
    // the loop still works afterwards rather than only that it threw.

    it('refuses a NaN or infinite setpoint, and stays healthy', () => {
      const servo = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
      for (let i = 0; i < 5; i++) servo.step(0, 100);
      expect(() => {
        servo.setpoint = NaN;
      }).toThrow(/setpoint must be a finite number/);
      // Infinite is refused too: `error` would be infinite, `clamp` cannot catch
      // it, and `integral += error * h` puts the infinity somewhere permanent.
      expect(() => {
        servo.setpoint = Infinity;
      }).toThrow(/finite/);
      expect(servo.setpoint).toBe(10);

      for (let i = 0; i < 5; i++) servo.step(0, 100);
      // Before the guard this was NaN for the rest of the object's life, even
      // with the setpoint restored.
      expect(Number.isFinite(servo.output)).toBe(true);
      expect(Number.isFinite(servo.integral)).toBe(true);
      expect(servo.output).toBe(100);
    });

    it('refuses a NaN bound, which would silently disable the clamp', () => {
      // The measured failure was the quietest of the four: with `max = NaN` every
      // `contribution < lo` comparison is false, the integral clamp never fires,
      // and the integral wound to 1978 with the output stuck at 0 — the windup
      // bug with the guard that prevents it quietly deleted.
      const servo = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
      expect(() => {
        servo.max = NaN;
      }).toThrow(/max must be a number/);
      expect(() => {
        servo.min = NaN;
      }).toThrow(/min must be a number/);
      expect(servo.min).toBe(0);
      expect(servo.max).toBe(100);

      // Saturate for a long time, then twice as long again: the integral must be
      // *pinned*, not creeping. Its value here is 1978 — the window at error -989
      // is [989, 1089] and `ki` is 0.5 — which is a *finite* pin. The defect was
      // not this number but that there was no pin at all.
      for (let i = 0; i < 200; i++) servo.step(999, 100);
      const pinned = servo.integral;
      expect(Number.isFinite(pinned)).toBe(true);
      for (let i = 0; i < 100000; i++) servo.step(999, 100);
      expect(servo.integral).toBeCloseTo(pinned, 6);
      expect(Math.abs(0.5 * pinned)).toBeLessThanOrEqual(100 + 989 + 1e-9);
    });

    it('refuses a range inverted from the outside', () => {
      // The constructor checks this. Nothing stopped it happening again later,
      // and the measured result was an output of -50 — outside both declared
      // bounds — with the integral free of any clamp at all.
      const servo = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
      expect(() => {
        servo.max = -50;
      }).toThrow(RangeError);
      expect(() => {
        servo.min = 500;
      }).toThrow(/must be <= max/);
      expect(servo.min).toBe(0);
      expect(servo.max).toBe(100);

      // And the legal versions still work, including widening the range: an
      // under-shooting measurement now clamps to the *new* max rather than 100.
      servo.min = -20;
      servo.max = 200;
      expect(servo.step(-999, 100)).toBe(200);
    });

    it('keeps the integral finite when ki is small enough to overflow the clamp', () => {
      // The clamp solves `ki·I = bound` for `I`, and a denormal `ki` makes that
      // quotient an infinity — after which `ki · ±Infinity` is `NaN`. Measured:
      // `integral` reached `-Infinity` within 50 steps at `ki: 1e-320`.
      for (const ki of [1e-320, Number.MIN_VALUE, -Number.MIN_VALUE]) {
        const servo = new PowerServo({ setpoint: 100, kp: 0.5, ki, min: 0, max: 8 });
        for (let i = 0; i < 200; i++) servo.step(0, 1);
        expect(Number.isFinite(servo.integral), `ki:${ki}`).toBe(true);
        expect(Number.isFinite(servo.output), `ki:${ki}`).toBe(true);
        expect(servo.output).toBeGreaterThanOrEqual(0);
        expect(servo.output).toBeLessThanOrEqual(8);
      }
    });

    it('holds a reverse-acting controller inside its bounds', () => {
      // Negative `ki` is correct here *because* the clamp bounds the
      // contribution rather than the stored integral: a reverse-acting
      // controller's window is inverted in integral space, and clamping the
      // integral itself would have needed a second branch to get that right.
      const servo = new PowerServo({ setpoint: 100, kp: 0.5, ki: -2, min: 0, max: 8 });
      for (let i = 0; i < 200; i++) {
        expect(servo.step(0, 1)).toBeGreaterThanOrEqual(0);
        expect(servo.step(0, 1)).toBeLessThanOrEqual(8);
      }
      expect(Number.isFinite(servo.integral)).toBe(true);
      expect(servo.integral).toBeCloseTo(25, 6);
    });

    it('does not divide the slope by a zero-length span', () => {
      // The fifth route, and the only one of the five that was *loud*: the other
      // four all kept returning a plausible number. `dt: 0` is an accepted
      // option, so `_defaultDt` is 0, and the span fell back to it — making the
      // slope divide by zero. Measured before the fix: `-Infinity` on the second
      // sample, `NaN` on the third, and still `NaN` 1000 steps later, because
      // `clamp` cannot catch a NaN and nothing else in the loop could recover it.
      const servo = new PowerServo({ kd: 1, derivativeFilter: 0.5, dt: 0 });
      servo.step(0, 0);
      servo.step(1, 0);
      expect(Number.isFinite(servo.derivative)).toBe(true);
      // The same route with `dt` omitted, so the *default* is the zero divisor.
      const omitted = new PowerServo({ kd: 1, derivativeFilter: 0.5, dt: 0 });
      omitted.step(0);
      omitted.step(1);
      expect(Number.isFinite(omitted.derivative)).toBe(true);
      // And it must still recover: a NaN derivative poisons the output on every
      // later step, so "finite now" alone would not be the defect being pinned.
      for (let i = 0; i < 1000; i++) servo.step(i, 0);
      expect(Number.isFinite(servo.derivative)).toBe(true);
      expect(Number.isFinite(servo.output)).toBe(true);
    });

    it('agrees with the integrator about whether time passed', () => {
      // The quieter half of the same defect, and the one a sweep of sample
      // intervals would not catch. At `h === 0` the integral correctly
      // accumulates nothing, because no time elapsed. The derivative instead
      // fabricated a tick length from the default and divided by it: a 50-unit
      // move over a 0.001 default reported a slope of -50000, which then went
      // straight into the output. Before the fix this was exactly -50000.
      const servo = new PowerServo({ kd: 1, ki: 1, dt: 0.001 });
      servo.step(0, 0.001);
      servo.step(50, 0); // zero time elapsed; the measurement moved 50
      expect(servo.integral).toBe(0);
      expect(servo.derivative).toBe(0);
      // A real interval still differentiates, so this is not "the derivative is
      // permanently disabled". The measurement fell 50 -> 0 over 0.001.
      servo.step(0, 0.001);
      expect(servo.derivative).toBe(50000);
    });
  });

  describe('options validation', () => {
    it('rejects an unknown option', () => {
      expect(() => new PowerServo({ kp: 1, nonsense: true })).toThrow(/nonsense/);
    });

    it('ignores non-finite gains rather than letting them into the loop', () => {
      // `Infinity` as a gain is a typo, and every product downstream becomes
      // `Infinity` or `NaN` with nothing to say which term did it.
      const servo = new PowerServo({ setpoint: 0, kp: Number.NaN, ki: 7, kd: Infinity });
      expect(Number.isFinite(servo.step(1, 1))).toBe(true);
    });
  });

  describe('it holds a setpoint, which is the case the other three loops do not', () => {
    it('converges to a setpoint a fixed gain cannot', () => {
      // The reason this helper exists as a *distinct* shape: proportional action
      // alone leaves a steady-state offset, because the only way to cancel a
      // constant disturbance is a term that accumulates. Both controllers see
      // the same disturbance; only the one with an integrator reaches zero.
      const plantGain = 0.8;
      const disturbance = 4; // a constant push the loop cannot measure directly
      const run = (servo) => {
        for (let i = 0; i < 200; i++) {
          // Plant: output * gain, plus a constant disturbance that never settles.
          const measured = servo.output * plantGain + disturbance;
          servo.step(measured, 1);
        }
        return servo.output;
      };
      const proportional = new PowerServo({ setpoint: 20, kp: 0.5, ki: 0, min: -1e6, max: 1e6 });
      const integral = new PowerServo({ setpoint: 20, kp: 0.5, ki: 0.4, min: -1e6, max: 1e6 });

      const pOut = run(proportional);
      const iOut = run(integral);
      expect(iOut).toBeGreaterThan(pOut);
      // The proportional loop settles at disturbance / kp, which is 8 - short
      // of the setpoint no matter how long it runs.
      expect(pOut).toBeLessThan(20);
      // The integral loop cancels it. A window, not an exact figure: this is a
      // discrete loop and the fixed point is not exactly the setpoint.
      expect(iOut).toBeGreaterThan(18);
      expect(iOut).toBeLessThanOrEqual(20);
    });
  });
});
