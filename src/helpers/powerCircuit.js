/**
 * PowerCircuit — a simple circuit breaker primitive.
 *
 * States:
 * - `closed` — normal operation
 * - `open` — short-circuit calls until timeout elapses
 * - `half-open` — allow a single trial call; success -> `closed`, failure -> `open`
 *
 * @class PowerCircuit
 * @param {Object} [options]
 * @param {number} [options.threshold=5] - Consecutive failure threshold to open the circuit.
 * @param {number} [options.timeout=30000] - **Base** milliseconds to keep the circuit open before allowing a trial call. Consecutive trips grow this exponentially (2x, 4x, … capped at `options.maxTimeout`) and jitter the result, so a fleet of clients does not probe the same dependency in lockstep. The first trip uses this value unchanged.
 * @param {number} [options.maxTimeout] - Ceiling for the grown open window. Defaults to `timeout * 16`.
 * @example
 * const cb = new PowerCircuit({ threshold: 3, timeout: 1000 });
 * await cb.call(() => fetch('/api'));
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerCircuitOptions} PowerCircuitOptions
 * @typedef {import('./jsdoc-types.js').CircuitState} CircuitState
 * @typedef {import('./jsdoc-types.js').CircuitOpenError} CircuitOpenError
 */
import { PowerEventBus } from './powerEventBus.js';
import { nowMs } from '../utils/now.js';
import {
  DEFAULT_CIRCUIT_MAX_OPEN_FACTOR,
  DEFAULT_CIRCUIT_MIN_JITTER_RATIO,
  DEFAULT_TIMEOUT_MS,
} from './constants.js';

/**
 * The rejection `PowerCircuit.call()` throws when it refuses to run `fn`.
 *
 * Built in one place so the `code` that callers branch on is set the same way
 * on both paths, and so its type can be stated once.
 *
 * @returns {CircuitOpenError}
 */
function circuitOpenError() {
  const err = new Error('CircuitOpen');
  /** @type {CircuitOpenError} */
  const typed = Object.assign(err, { code: /** @type {const} */ ('ECIRCUITOPEN') });
  return typed;
}

/**
 * PowerCircuit
 *
 * Circuit-breaker primitive that short-circuits calls after repeated failures.
 * Use for isolating flaky downstream dependencies and to avoid cascading failures.
 *
 * @class PowerCircuit
 * @public
 */
export class PowerCircuit {
  /**
   * @param {PowerCircuitOptions} [options] - `threshold` and `timeout` default
   *   to 5 and 30s; `onStateChange` and `eventBus` are optional sinks. `timeout`
   *   is the *base* open window: consecutive trips grow it exponentially up to
   *   `maxTimeout` and jitter the result.
   */
  constructor(options = {}) {
    const {
      threshold = 5,
      timeout = DEFAULT_TIMEOUT_MS,
      maxTimeout,
      onStateChange = null,
      eventBus = null,
    } = options;
    this._threshold = Number(threshold) || 5;
    // `timeout` is the **base** open window, not the only one. It stays the
    // first window so a circuit that trips once behaves exactly as 1.x did.
    this._timeout = Number(timeout) || DEFAULT_TIMEOUT_MS;
    this._maxTimeout =
      Number.isFinite(Number(maxTimeout)) && Number(maxTimeout) > 0
        ? Number(maxTimeout)
        : this._timeout * DEFAULT_CIRCUIT_MAX_OPEN_FACTOR;
    /**
     * Consecutive entries into `open`, which drive the exponential growth.
     * Reset to 0 whenever the circuit proves the dependency is healthy again.
     * @type {number}
     */
    this._consecutiveOpens = 0;
    /**
     * The jittered window for the *current* `open` period, drawn once when the
     * circuit opened. It must be stored rather than re-drawn: the open check
     * runs on every `call()` and every `state` read, and a per-call draw would
     * make the window fluctuate, so the breaker would flap instead of holding.
     * @type {number}
     */
    this._openWindowMs = this._timeout;
    /** @type {CircuitState} */
    this._state = 'closed';
    this._failures = 0; // consecutive failures
    /** @type {any} */
    this.lastError = null;
    /** @type {?number} */
    this._openedAt = null;
    this._trialInFlight = false;

    // optional callback invoked on state transitions: (state, reason)
    /** @type {?((state: CircuitState, reason?: string) => void)} */
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    // optional external event bus to emit `stateChange` events
    this._bus = eventBus instanceof PowerEventBus ? eventBus : null;
  }

  /**
   * Draw the open window for a trip: exponential backoff on the base timeout,
   * capped, then equal jitter.
   *
   * The exponential part is what stops a genuinely-down dependency from being
   * probed at a fixed rate forever; the jitter is what stops a *fleet* of
   * clients from probing it in lockstep. With a fixed window, every circuit
   * guarding the same dependency opened on the same tick and retried on the
   * same tick, so the first post-timeout request arrived as an N-wide burst
   * that re-tripped the breaker before it had recovered — a self-inflicted
   * thundering herd, and the exact failure the breaker exists to prevent.
   *
   * @returns {number} The window in ms, always at least half the computed
   *   backoff. See `DEFAULT_CIRCUIT_MIN_JITTER_RATIO` for why this is not full
   *   jitter.
   */
  _drawOpenWindow() {
    const capped =
      this._consecutiveOpens >= 30 ? this._maxTimeout : this._timeout * 2 ** this._consecutiveOpens;
    const delay = Math.min(this._maxTimeout, Math.max(this._timeout, capped));
    const floor = delay * DEFAULT_CIRCUIT_MIN_JITTER_RATIO;
    return floor + Math.random() * (delay - floor);
  }

  /**
   * Move to a new state, stamping `_openedAt`, notifying `onStateChange` and
   * emitting on the bus. A no-op when the state is unchanged.
   *
   * @param {CircuitState} newState
   * @param {string} [reason]
   * @returns {void}
   */
  _setState(newState, reason) {
    const prev = this._state;
    if (prev === newState) return;
    this._state = newState;
    if (newState === 'open') {
      this._openedAt = nowMs();
      // Draw from the *pre-increment* count, so the very first trip uses the
      // base `timeout` unchanged and the second consecutive one doubles it.
      // Incrementing first would silently make even the first trip 2x, which
      // both contradicts the documented base and breaks every caller that
      // sized `timeout` as "the first window".
      this._openWindowMs = this._drawOpenWindow();
      this._consecutiveOpens++;
    } else {
      this._openedAt = null;
      // Reaching `closed` means the dependency answered a trial, so the next
      // trip starts from the base window again. `half-open` deliberately does
      // not reset the counter: it is the same outage, and only a success proves
      // it ended.
      if (newState === 'closed') {
        this._consecutiveOpens = 0;
        // Put the window back to the base too, so no stale grown value sits in
        // the field between outages. It is only read while `open` (and is
        // redrawn on the next trip), but leaving a dead value behind is the
        // kind of thing that later gets read by the wrong path.
        this._openWindowMs = this._timeout;
      }
    }
    // only keep trial flag true when in half-open; otherwise clear it
    if (newState !== 'half-open') this._trialInFlight = false;

    // invoke callback if provided
    try {
      if (typeof this.onStateChange === 'function') this.onStateChange(newState, reason);
    } catch (e) {
      /* swallow user callback errors */
    }
    // emit on bus if provided
    if (typeof this._bus?.emit === 'function') {
      this._bus.emit('stateChange', { state: newState, reason });
    }
  }

  /** @returns {CircuitState} */
  get state() {
    // If open and the *drawn* window has elapsed, expose as 'half-open' logically
    if (this._state === 'open' && this._openedAt != null) {
      if (nowMs() - this._openedAt >= this._openWindowMs) return 'half-open';
    }
    return this._state;
  }

  get failures() {
    return this._failures;
  }

  /**
   * Execute a function under circuit-breaker protection.
   *
   * If the circuit is `open`, this will throw an error with `code === 'ECIRCUITOPEN'`.
   * When in `half-open` state a single trial call is allowed.
   *
   * @param {() => Promise<any>|any} fn Async or sync function to execute.
   * @returns {Promise<any>} Resolves with the function's result.
   * @throws {Error} If the circuit is open or if `fn` throws/rejects.
   */
  async call(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');

    // short-circuit when open and the drawn window has not elapsed. `_openedAt`
    // is stamped by `_setState` on every entry to `open`, so it is set whenever
    // `_state` is - the comparison reads it without a guard, and the guard would
    // only have hidden the invariant.
    //
    // `_openWindowMs` rather than `_timeout`: the window is the jittered,
    // exponentially-grown one for *this* trip, drawn once when the circuit
    // opened. Reading `_timeout` here would ignore the backoff entirely and
    // also disagree with the `state` getter above.
    if (this._state === 'open') {
      if (nowMs() - Number(this._openedAt) < this._openWindowMs) {
        throw circuitOpenError();
      }
      // else allow half-open trial
      this._setState('half-open', 'timeoutElapsed');
    }

    if (this._state === 'half-open') {
      if (this._trialInFlight) {
        throw circuitOpenError();
      }
      this._trialInFlight = true;
    }

    try {
      const res = await fn();
      // success: reset
      this._failures = 0;
      this.lastError = null;
      this._setState('closed', 'success');
      return res;
    } catch (err) {
      this.lastError = err;
      // on failure, if half-open -> open again
      if (this._state === 'half-open') {
        this._setState('open', 'trialFailed');
        this._failures = 0;
        throw err;
      }
      // closed state: increment failures and maybe open
      this._failures++;
      if (this._failures >= this._threshold) {
        this._setState('open', 'thresholdExceeded');
        this._failures = 0;
      }
      throw err;
    }
  }

  /**
   * Force the circuit back to the `closed` state and clear failures.
   * @returns {void}
   */
  // force reset to closed
  reset() {
    this._setState('closed', 'reset');
    this._failures = 0;
    this.lastError = null;
    this._openedAt = null;
    this._trialInFlight = false;
    this._consecutiveOpens = 0;
    this._openWindowMs = this._timeout;
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

export default PowerCircuit;
