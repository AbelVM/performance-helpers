/**
 * Producer-facing backpressure controller with adaptive refill.
 *
 * Use `PowerBackpressure` to gate producer throughput while allowing
 * consumers to release capacity and the helper to refill adaptively when
 * pressure is high.
 */
import { PowerPermitGate } from './powerPermitGate.js';
import { setSafeTimeout } from '../utils/timers.js';
import {
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_BACKPRESSURE_QUEUE_CAPACITY,
  DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS,
} from './constants.js';

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
 * @typedef {import('./jsdoc-types.js').BackpressureAdaptiveOptions} BackpressureAdaptiveOptions
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
  /**
   * @param {*} v
   * @param {number} fallback
   * @returns {number}
   */
  const num = (v, fallback) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    enabled: cfg.enabled !== false,
    // TCP additive increase is one segment per RTT. One permit per refill tick
    // is the same shape here, since a tick is the unit of observation.
    additiveIncrease: Math.max(1, Math.floor(num(cfg.additiveIncrease, 1))),
    beta: Math.min(0.99, Math.max(0.1, num(cfg.beta, 0.5))),
    min: Math.max(1, Math.floor(num(cfg.min, 1))),
    max: Math.max(1, Math.floor(num(cfg.max, 1_000_000))),
  };
}

export class PowerBackpressure extends PowerPermitGate {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=100] Maximum number of concurrent permits.
   * @param {number} [options.queueCapacity=1000] Maximum number of waiting producers.
   * @param {number} [options.lowWaterMark=Math.ceil(capacity * 0.25)] When available tokens drop below this threshold, adaptive refill begins.
   * @param {number} [options.refillAmount=Math.max(1, Math.ceil(capacity * 0.1))] Base refill amount when pressure is detected.
   * @param {number} [options.refillInterval=200] Refill interval in milliseconds.
   * @param {number} [options.initialTokens=capacity] Initial available permits.
   * @param {boolean|BackpressureAdaptiveOptions} [options.adaptive=false] AIMD
   *   tuning of `refillAmount`. Disabled by default, so the constant-behaviour
   *   path is unchanged unless asked for.
   */
  constructor(options = {}) {
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
    /** Permits currently held by consumers: granted and not yet returned. */
    this._inFlight = 0;
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
   * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
   */
  acquire() {
    if (this.available > 0) {
      return Promise.resolve(this._grant());
    }
    if (this.isFull) {
      return Promise.reject(new Error('PowerBackpressure queue is full'));
    }
    const promise = super.acquire();
    if (this.pending > 0 && !this._refillTimer) {
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
   */
  release(count = 1) {
    super.release(count);
    const returned = Math.min(Math.max(0, Math.floor(Number(count) || 0)), this._inFlight);
    this._inFlight -= returned;
    if ((this.available < this._lowWaterMark || this._adaptiveHeartbeat) && this.pending > 0) {
      this._scheduleRefill();
    }
  }

  /**
   * Reset the controller to its initial capacity and clear waiting producers.
   */
  reset() {
    super.reset({ available: this._capacity, reason: new Error('PowerBackpressure reset') });
    // A reset means "forget what you learned about the consumer". Carrying the
    // tuned window across would keep applying a conclusion drawn about a
    // workload that no longer exists.
    this._inFlight = 0;
    this._adaptiveHeartbeat = false;
    this._refillAmount = this._baseRefillAmount;
    if (this._refillTimer) {
      clearTimeout(this._refillTimer);
      this._refillTimer = null;
    }
  }

  _grant() {
    // The single point at which a permit reaches a consumer. Every grant path -
    // the fast path, the refill loop, and the base gate serving a waiter as a
    // permit is released - funnels through here, so this is the only place that
    // has to count. Counting in more than one place double-counted and reported
    // 12 permits in flight against a capacity of 4.
    this._inFlight += 1;
    return super._grant();
  }

  _scheduleRefill() {
    if (this._refillTimer || this.pending === 0) return;
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
    if (this.pending === 0) {
      this._adaptiveHeartbeat = false;
      return;
    }
    const missing = this._capacity - this._available;
    if (missing <= 0) {
      // Nothing to grant, but the queue is still there and the consumer is
      // still behaving: that is exactly the signal AIMD needs, so observe it
      // and come back. Without this the window could only ever shrink.
      this._aimdStep();
      this._scheduleRefill();
      return;
    }

    this._aimdStep();

    const adaptiveAmount = Math.min(
      this._capacity,
      this._refillAmount + Math.ceil(this.pending / 10)
    );
    const refill = Math.min(adaptiveAmount, missing);
    this._available += refill;

    while (this._available > 0 && this.pending > 0) {
      const next = this._waiters.shift();
      if (typeof next?.resolve === 'function') {
        this._available -= 1;
        next.resolve(this._makeRelease());
      }
    }

    if ((this._available < this._lowWaterMark || this._adaptiveHeartbeat) && this.pending > 0) {
      this._scheduleRefill();
    }
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
    this.reset = () => {};
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
