/**
 * Producer-facing backpressure controller with adaptive refill.
 *
 * Use `PowerBackpressure` to gate producer throughput while allowing
 * consumers to release capacity and the helper to refill adaptively when
 * pressure is high.
 */
import { PowerPermitGate } from './powerPermitGate.js';
import { setSafeTimeout } from '../utils/timers.js';
import { assertKnownOptions, assertLimitRequired } from '../utils/options.js';
import { neutralise } from '../utils/neutralise.js';
import {
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_BACKPRESSURE_QUEUE_CAPACITY,
  DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS,
} from './constants.js';

/**
 * @typedef {import('./jsdoc-types.js').BackpressureAdaptiveOptions} BackpressureAdaptiveOptions
 * @typedef {import('./jsdoc-types.js').PowerBackpressureOptions} PowerBackpressureOptions
 */

/**
 * PowerBackpressure
 *
 * Producer-facing backpressure controller built on top of `PowerPermitGate`.
 * Provides adaptive refill behavior and FIFO queuing for producers.
 *
 * @class PowerBackpressure
 * @public
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerReleaseFn} PowerReleaseFn
 */
/**
 * Normalize the `adaptive` option into a settings object.
 *
 * `false`/absent disables AIMD and leaves `refillAmount` at whatever the caller
 * configured - the pre-2.0 behaviour, unchanged. `true` takes the defaults.
 *
 * @param {boolean|BackpressureAdaptiveOptions} option
 * @param {number} baseRefill - The configured `refillAmount`, used as the floor.
 * @returns {{enabled: boolean, additiveIncrease: number, beta: number, min: number, max: number}}
 * @private
 */
function normalizeAdaptive(option, baseRefill) {
  const off = { enabled: false, additiveIncrease: 1, beta: 0.5, min: 1, max: baseRefill };
  if (!option) return off;
  const cfg = option === true ? {} : option;
  if (typeof cfg !== 'object') return off;
  return {
    enabled: cfg.enabled !== false,
    // TCP additive increase is one segment per RTT. One permit per refill tick
    // is the same shape here, since a tick is the unit of observation.
    additiveIncrease: Math.max(
      1,
      Math.floor(
        assertLimitRequired(cfg.additiveIncrease, {
          min: 1,
          integer: true,
          fallback: 1,
          className: 'PowerBackpressure',
          name: 'additiveIncrease',
        })
      )
    ),
    beta: Math.min(
      0.99,
      Math.max(0.1, typeof cfg.beta === 'number' && Number.isFinite(cfg.beta) ? cfg.beta : 0.5)
    ),
    min: Math.max(
      1,
      Math.floor(
        assertLimitRequired(cfg.min, {
          min: 1,
          integer: true,
          fallback: 1,
          className: 'PowerBackpressure',
          name: 'adaptive.min',
        })
      )
    ),
    max: Math.max(
      1,
      Math.floor(
        assertLimitRequired(cfg.max, {
          min: 1,
          integer: true,
          fallback: 1_000_000,
          className: 'PowerBackpressure',
          name: 'adaptive.max',
        })
      )
    ),
  };
}

export class PowerBackpressure extends PowerPermitGate {
  /**
   * @param {PowerBackpressureOptions} [options] `capacity` and `queueCapacity`
   *   are inherited from `PowerPermitGate`; the rest tune the refill schedule.
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      [
        'capacity',
        'queueCapacity',
        'initialTokens',
        'lowWaterMark',
        'refillAmount',
        'refillInterval',
        'adaptive',
      ],
      'PowerBackpressure'
    );
    const {
      capacity = DEFAULT_QUEUE_CAPACITY,
      queueCapacity = DEFAULT_BACKPRESSURE_QUEUE_CAPACITY,
      lowWaterMark = null,
      refillAmount = null,
      refillInterval = DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS,
      adaptive = false,
      initialTokens = undefined,
    } = options || {};

    const normalizedCapacity = Math.max(1, Math.floor(Number(capacity) || DEFAULT_QUEUE_CAPACITY));
    // `typeof` rather than `Number.isFinite` alone: `isFinite` is typed
    // `(number: unknown)`, so it does not narrow, and the `null` "not supplied"
    // sentinel would stay in the union at every use below.
    const normalizedLowWaterMark =
      typeof lowWaterMark === 'number' && Number.isFinite(lowWaterMark)
        ? Math.min(Math.max(1, Math.floor(lowWaterMark)), normalizedCapacity - 1)
        : Math.max(1, Math.ceil(normalizedCapacity * 0.25));
    const normalizedRefillAmount =
      typeof refillAmount === 'number' && Number.isFinite(refillAmount)
        ? Math.max(1, Math.min(Math.floor(refillAmount), normalizedCapacity))
        : Math.max(1, Math.ceil(normalizedCapacity * 0.1));
    const normalizedRefillInterval = Math.max(
      1,
      Math.floor(Number(refillInterval) || DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS)
    );

    super({
      capacity: normalizedCapacity,
      queueCapacity,
      initialTokens,
    });

    this._capacity = normalizedCapacity;
    this._lowWaterMark = normalizedLowWaterMark;
    this._refillAmount = normalizedRefillAmount;
    this._refillInterval = normalizedRefillInterval;
    this._refillTimer = null;

    // --- AIMD state -------------------------------------------------------
    this._baseRefillAmount = normalizedRefillAmount;
    this._adaptive = normalizeAdaptive(adaptive, normalizedRefillAmount);
    this._adaptiveHeartbeat = false;
  }

  /**
   * The refill amount the controller is currently probing with.
   *
   * With `adaptive` enabled this moves: up by `additiveIncrease` on every
   * refill that finds consumers draining, and down by a factor of `beta` on
   * every refill that finds them not. With it disabled it is constant, and
   * equal to the `refillAmount` option.
   *
   * @returns {number}
   */
  get refillAmount() {
    return this._refillAmount;
  }

  /** Maximum concurrent permits. */
  get capacity() {
    return this._capacity;
  }

  /** Available permits for producers. */
  get available() {
    return super.available;
  }

  /** Number of producers currently waiting for permits. */
  get pending() {
    return super.pending;
  }

  /** Maximum number of waiting producers. */
  get queueCapacity() {
    return super.queueCapacity;
  }

  /** True when the waiting queue is full. */
  get isFull() {
    return super.isFull;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when a permit is available.
   * Otherwise queues the producer until capacity frees.
   * @param {Object} [options] - `signal` aborts the wait: the returned promise
   *   rejects with an `AbortError` and the producer leaves the queue instead of
   *   holding a slot until a permit is refilled.
   * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
   */
  acquire(options = {}) {
    // The admission decision is the parent's: an override that re-implements
    // its parent's `acquire` is two implementations of the same question, and
    // this one had already drifted - it rejected an already-aborted signal with
    // a bare `Error` where the gate gives an `AbortError`, so the
    // `err.name === 'AbortError'` check the gate's own docs tell callers to make
    // failed for exactly the class that documents it. The only thing added here
    // is the refill safety net, which is this class's whole reason to exist.
    const promise = super.acquire(options);
    if (this._hasWaiters() && !this._refillTimer) {
      this._scheduleRefill();
    }
    return promise;
  }

  /**
   * Try to acquire a permit immediately.
   * @returns {PowerReleaseFn|null} Release callback, or `null` if no permit is available.
   */
  tryAcquire() {
    return super.tryAcquire();
  }

  /**
   * Release one or more permits back to the controller.
   * @param {number} [count=1]
   * @returns {number} Permits returned to the gate rather than transferred.
   */
  release(count = 1) {
    // Only the permits that actually came *back* stop being in flight. A
    // release that serves a queued producer is a transfer - the permit is
    // handed straight over and the producer is a holder from that instant - and
    // the base gate's `_grantTo` has already counted it. Subtracting the
    // requested count instead used to walk the counter down by one for every
    // transfer, so after the first transfer cycle the AIMD signal read 0 while
    // permits were still outstanding, and the controller stayed pinned in
    // additive increase forever after.
    const returned = super.release(count);
    // Re-armed on the heartbeat alone as well as on a low pool, and the reason
    // is the same as in `_scheduleRefill`: a `release()` is the *last* thing that
    // happens once the queue has drained, and gating the re-arm on waiters meant
    // the controller stopped being consulted at exactly the moment a slow
    // consumer became visible.
    if (this.available < this._lowWaterMark || this._adaptiveHeartbeat) {
      this._scheduleRefill();
    }
    // Passed through rather than dropped: the count is the same fact this class
    // reads to decide whether a refill is needed, so swallowing it here would
    // make the override's return type differ from its base's for no reason.
    return returned;
  }

  /**
   * Reset the controller to its initial capacity and clear waiting producers.
   */
  reset() {
    super.reset({ available: this._capacity, reason: new Error('PowerBackpressure reset') });
    // A reset means "forget what you learned about the consumer". Carrying the
    // tuned window across would keep applying a conclusion drawn about a
    // workload that no longer exists. The in-flight count is *not* cleared: the
    // consumers it counts are still running, and the base gate's `reset()`
    // refuses to hand their permits to anyone else until they return.
    this._adaptiveHeartbeat = false;
    this._refillAmount = this._baseRefillAmount;
    if (this._refillTimer) {
      clearTimeout(this._refillTimer);
      this._refillTimer = null;
    }
  }

  /**
   * Whether the wait queue physically holds anything.
   *
   * Deliberately the raw length rather than {@link PowerPermitGate#pending}:
   * the refill machinery is a safety net for a queue nothing else will drain,
   * so gating it on a *derived* count means one cancelled-but-not-yet-compacted
   * entry can turn the net off while a live waiter is still queued. `pending`
   * stays the user-facing answer ("how many producers are actually waiting");
   * this is the mechanism's own question.
   *
   * @returns {boolean}
   * @private
   */
  _hasWaiters() {
    return this._waiters.length > 0;
  }

  _scheduleRefill() {
    // The heartbeat arms the timer on its own, and **this is the whole fix for a
    // controller that had stopped learning.**
    //
    // The flag means "keep probing", but the only thing that used to arm a timer
    // was a producer arriving to find an empty pool — and the refill *drains* the
    // queue. So by the time a consumer was demonstrably slow enough for the
    // window to need cutting, the queue was empty, the flag was `true`, and
    // nothing acted on it. Measured: 16 producers against a capacity of 8, each
    // holding its permit, produced **2** `_aimdStep` calls in 400 ms and then
    // froze — window 8 → 4 → 2 with a floor of 1, 16 permits outstanding, and
    // `_refillTimer` null. The first two cuts were real; there was no mechanism
    // for a third, so the window held at 2 for the rest of the object's life
    // while the gate stayed 2x oversubscribed.
    //
    // Cheap, because `adaptive` defaults to `false`: the heartbeat only exists
    // for a caller who explicitly asked for adaptation, and that caller's
    // expectation is precisely that the option does something.
    if (this._refillTimer || !(this._hasWaiters() || this._adaptiveHeartbeat)) return;
    // A heartbeat exists so AIMD can observe *good* behaviour. Without it the
    // window only ever moves on a refill, and a refill only happens below the
    // low-water mark - so a consumer that recovered would never be rewarded
    // with a larger probe, and one bad patch would be permanent.
    if (this._adaptive.enabled) this._adaptiveHeartbeat = true;
    this._refillTimer = setSafeTimeout(() => {
      this._refillTimer = null;
      this._performRefill();
    }, this._refillInterval);
  }

  _performRefill() {
    // Idle: no waiters and nothing in flight. Stop the heartbeat, or it ticks
    // for the object's whole life learning nothing — and the only thing it could
    // learn on an empty gate is that the window should grow.
    //
    // This is the termination condition that makes honouring the heartbeat
    // affordable. It runs while there is something to observe — something in
    // flight, or a producer waiting — and stops when the gate goes quiet, so the
    // controller is not a permanent timer.
    if (!this._hasWaiters() && this._held === 0) {
      this._adaptiveHeartbeat = false;
      return;
    }
    if (!this._hasWaiters()) {
      // Nothing waiting, but permits are out with consumers: something to
      // observe, and the window still has business. This is the branch that
      // actually runs under sustained congestion, because the refill has just
      // drained the queue.
      this._aimdStep();
      this._scheduleRefill();
      return;
    }
    // `capacity - available`: the *pool*, not the concurrency in flight. The
    // refill is a pressure-triggered token source - it mints back up to the pool
    // size only while a queue is waiting - and under congestion it will hand out
    // more than `capacity` is worth, because a consumer that is not returning
    // its permits is exactly the case where more producers have to be let in.
    // That is the AIMD idea; a gate that could not exceed its own ceiling would
    // have no reason to tune a window.
    //
    // It is also why `active` is `_held` and not `capacity - available`: under
    // this model more holders can be outstanding than `capacity`, and
    // `capacity - available` cannot represent that - it saturates at
    // `capacity` and reports a healthy gate while the work is piling up. See
    // ADR 0004 for the model and the two readings of `capacity` it separates.
    const missing = this._capacity - this._available;
    if (missing <= 0) {
      // The pool is already full and a waiter is queued, which cannot normally
      // happen - a caller only queues when the pool is empty. Transiently it can,
      // during a grant, so the branch exists: there is nothing to mint and
      // nothing to learn, so it observes the signal and comes back. Without
      // `adaptive` there is no window to tune, and rescheduling would be a timer
      // that can neither grant nor learn - a live handle held open forever behind
      // a queue it cannot relieve.
      this._aimdStep();
      if (this._adaptive.enabled) this._scheduleRefill();
      return;
    }

    this._aimdStep();

    const adaptiveAmount = Math.min(
      this._capacity,
      this._refillAmount + Math.ceil(this.pending / 10)
    );
    const refill = Math.min(adaptiveAmount, missing);
    this._available += refill;

    // `_serveWaiters`, not a local shift loop: this path used to hand permits
    // to aborted waiters - their `resolve` is a no-op, so the permit was taken
    // and nothing came of it - and never decremented `_cancelledWaiters`, which
    // is what deadlocked the queue behind a corpse. `fromAvailable = true`
    // because the refill above already counted these permits into `_available`;
    // this is the one route that draws them back out again.
    this._serveWaiters(Math.min(refill, this._available), true);

    if (this.available < this._lowWaterMark || this._adaptiveHeartbeat) {
      this._scheduleRefill();
    }
  }

  /**
   * Permits currently held by consumers: granted and not yet returned.
   *
   * A named view of the base gate's `_held`, not a second counter. The
   * controller used to keep its own, incremented from the fast-path grant only,
   * and the two of them disagreed whenever a permit reached a *queued* producer
   * - which is most of them, and all of the ones a refill tick hands out.
   *
   * @returns {number}
   * @private
   */
  get _inFlight() {
    return this._held;
  }

  /**
   * One AIMD round.
   *
   * The signal is whether the consumers we handed permits to gave them back. A
   * refill tick with `_inFlight === capacity` means every permit this pool
   * granted is still out there and nothing has come back, however long the
   * consumer takes: that is congestion, and the window is cut
   * multiplicatively. Anything else means at least part of the outstanding work
   * completed, so the window grows additively.
   *
   * This is the TCP congestion-control shape with `refillAmount` as the
   * congestion window. It is not CoDel's delay-based variant: that measures a
   * round-trip time, and here the honest analogue of "did my probe come back"
   * is "did a permit come back", which needs no clock and cannot be fooled by a
   * fast consumer that keeps everything forever.
   *
   * It is also deliberately *loss-based*, which is the only one of Netflix's
   * three controllers whose signal transfers. `vegas` and `gradient2` are both
   * RTT-shaped, and a permit gate is a producer/consumer queue rather than an
   * RPC: there is no request/response round trip here for them to measure. A
   * delay-shaped controller for this class would need a queue-drain *rate*, not
   * a latency - see `ALGO-010` in `review.md`.
   *
   * @returns {void}
   * @private
   */
  _aimdStep() {
    if (!this._adaptive.enabled) return;
    const { additiveIncrease, beta, min, max } = this._adaptive;
    if (this._inFlight >= this._capacity) {
      this._refillAmount = Math.max(min, Math.floor(this._refillAmount * beta));
    } else {
      this._refillAmount = Math.min(max, this._refillAmount + additiveIncrease);
    }
  }

  /**
   * Release every resource this instance holds.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using` and gives callers an explicit
   * name to call.
   *
   * @returns {void}
   */
  dispose() {
    this.reset();
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    neutralise(this, 'reset');
  }

  /**
   * Alias for {@link dispose}, so `using x = new X()` releases the instance
   * deterministically at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}

export default PowerBackpressure;
