---
'performance-helpers': minor
---

### Added

- `PowerFlowController` — admission, queueing and latency feedback in one closed
  loop. It composes `PowerGCRA` (admission), `PowerQueue` (a bounded FIFO that
  counts what it drops), `PowerHistogram` (per-window tail latency) and
  `PowerServo` (the loop), with no new arithmetic of its own beyond deciding when
  the loop has something to learn.

  The producer side is `submit()`, which bounds the queue and increments
  `dropped`. The consumer side is `admit()`, which is the GCRA gate. The
  measurement side is `record()`, and the loop is `observe()`, which reads the
  p99 of the window, steps the servo, and writes the result into the limiter.

  Three decisions in it were settled by measurement rather than preference, and
  all three are recorded in the guide:

  - **The latency window resets on every observation that acts on it.** A
    cumulative histogram was measured first and is wrong for this plant: the loop
    then sees a _lifetime_ p99, so a rate that has already been cut keeps being
    judged against the traffic that justified the cut, and it never comes back.
    The consequence a caller has to know is that `p99` is the current, partial
    window rather than a lifetime figure.
  - **`minRate` must be greater than 0, and that is a hard requirement.** The
    actuator is a GCRA, whose rate must be positive, so `minRate: 0` is an option
    the loop cannot honour — it would throw on the first observation that reached
    the floor. Refused at construction, with a message that says to stop calling
    `admit()` instead.
  - **`ki` defaults to non-zero.** With `ki: 0` the output is `kp × error` alone,
    so a window that meets its target exactly produces an error of zero and
    therefore a rate of zero, which the `minRate` clamp turns into the floor.
    Measured: P-only settled at 11 % of the rate the plant could sustain at the
    target latency.

  The default gains (`kp: 0.05, ki: 0.001`) were measured on a plant stated in
  closed form — `latency = 5 ms + (rate / cap) × 90 ms` at a 30 ms target — where
  they reach both equilibria (111.1/s at `cap: 400`, 41.7/s at `cap: 150`) with
  **zero** overshoot on a load step, and hold that equilibrium across sample
  intervals from 100 ms to 2000 ms. The gain band is narrow and the guide says so:
  doubling the gains overshoots by 62 ms, and doubling again limit-cycles across
  the whole range. `saturated` is what distinguishes "the loop chose this rate"
  from "the loop wanted more and could not have it".

  Queue depth is deliberately **not** a control input, and the guide records why:
  a deep queue with healthy latency is a backlog to drain and a deep queue with
  unhealthy latency is overload to shed, and the same number means both. Depth is
  the bound, it is `stats().depth`, and it is the number to alert on — it is just
  not the process variable. This is also why the helper needs no sign inversion,
  unlike `PowerFlowControl`, whose guide devotes a section to the headroom trap.

- `PowerGCRA.setRate(rate)` — change the sustained rate at runtime, keeping the
  accumulated state. This exists because a closed loop needs a rate it can move,
  and the alternative was a trap: `rate` is a plain public field, but `_emission`
  and `_delayTolerance` are derived from it once in the constructor, so
  `limiter.rate = 500` changed the number `stats()` reported and nothing the
  limiter did. A composition that retunes a GCRA had no way to do it.

  The theoretical arrival time is **kept, not rescaled**, which is the
  conservative direction: the TAT is an absolute instant, so the debt it
  represents is debt in _time_, and re-spacing it onto the new emission interval
  would invent capacity the old rate never granted. Lowering the rate therefore
  makes the limiter refuse for longer, and raising it admits up to the new burst
  at once.

### Fixed

- `PowerGCRA` carried an orphaned docblock. A `tryConsume` comment ("Try to
  consume one operation", `@param {number} [n=1]`) sat above `_notifyClock`'s own
  docblock, separated from the real `tryConsume` docblock twenty lines below by
  the insertion of `_notifyClock` between them. Typedoc attaches the first block
  it finds, so `_notifyClock` was documented as consuming operations. Both
  members are private, so the published types and API reference do not move.
