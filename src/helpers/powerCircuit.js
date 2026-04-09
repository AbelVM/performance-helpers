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
 * @param {number} [options.timeout=30000] - Milliseconds to keep the circuit open before allowing a trial call.
 * @example
 * const cb = new PowerCircuit({ threshold: 3, timeout: 1000 });
 * await cb.call(() => fetch('/api'));
 */
/**
 * @typedef {Object} PowerCircuitOptions
 * @property {number} [threshold]
 * @property {number} [timeout]
 * @property {(state:string,reason?:string)=>void} [onStateChange]
 * @property {import("./powerEventBus.js").PowerEventBus} [eventBus]
 */
import { PowerEventBus } from './powerEventBus.js';
import { nowMs } from '../utils/now.js';

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
  constructor(options = {}) {
    const { threshold = 5, timeout = 30000, onStateChange = null, eventBus = null } = options;
    this._threshold = Number(threshold) || 5;
    this._timeout = Number(timeout) || 30000;
    this._state = 'closed';
    this._failures = 0; // consecutive failures
    this.lastError = null;
    this._openedAt = null;
    this._trialInFlight = false;

    // optional callback invoked on state transitions: (state, reason)
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    // optional external event bus to emit `stateChange` events
    this._bus = eventBus instanceof PowerEventBus ? eventBus : null;
  }

  _setState(newState, reason) {
    const prev = this._state;
    if (prev === newState) return;
    this._state = newState;
    if (newState === 'open') this._openedAt = nowMs();
    else this._openedAt = null;
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

  get state() {
    // If open and timeout elapsed, expose as 'half-open' logically
    if (this._state === 'open' && this._openedAt != null) {
      if (nowMs() - this._openedAt >= this._timeout) return 'half-open';
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
   * @param {Function} fn Async function to execute.
   * @returns {Promise<any>} Resolves with the function's result.
   * @throws {Error} If the circuit is open or if `fn` throws/rejects.
   */
  async call(fn) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');

    // short-circuit when open and timeout not elapsed
    if (this._state === 'open') {
      if (nowMs() - this._openedAt < this._timeout) {
        const err = new Error('CircuitOpen');
        err.code = 'ECIRCUITOPEN';
        throw err;
      }
      // else allow half-open trial
      this._setState('half-open', 'timeoutElapsed');
    }

    if (this._state === 'half-open') {
      if (this._trialInFlight) {
        const err = new Error('CircuitOpen');
        err.code = 'ECIRCUITOPEN';
        throw err;
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
  }
}

export default PowerCircuit;
