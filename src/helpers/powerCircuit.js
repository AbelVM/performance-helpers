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
 */
export class PowerCircuit {
  /**
   * Create a PowerCircuit.
   * @param {PowerCircuitOptions} [options]
   */
  constructor(options = {}) {
    const { threshold = 5, timeout = 30000 } = options;
    this._threshold = Number(threshold) || 5;
    this._timeout = Number(timeout) || 30000;
    this._state = 'closed';
    this._failures = 0; // consecutive failures
    this.lastError = null;
    this._openedAt = null;
    this._trialInFlight = false;
  }

  get state() {
    // If open and timeout elapsed, expose as 'half-open' logically
    if (this._state === 'open' && this._openedAt != null) {
      if (Date.now() - this._openedAt >= this._timeout) return 'half-open';
    }
    return this._state;
  }

  get failures() {
    return this._failures;
  }

  async call(fn) {
    /**
     * Execute the provided function under circuit protection.
     * If the circuit is open the call will be rejected with an error
     * whose `code` property is `ECIRCUITOPEN`.
     *
     * @param {Function} fn - Async function to execute.
     * @returns {Promise<any>}
     */
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');

    // short-circuit when open and timeout not elapsed
    if (this._state === 'open') {
      if (Date.now() - this._openedAt < this._timeout) {
        const err = new Error('CircuitOpen');
        err.code = 'ECIRCUITOPEN';
        throw err;
      }
      // else allow half-open trial
      this._state = 'half-open';
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
      this._state = 'closed';
      this._openedAt = null;
      this._trialInFlight = false;
      return res;
    } catch (err) {
      this.lastError = err;
      // on failure, if half-open -> open again
      if (this._state === 'half-open') {
        this._state = 'open';
        this._openedAt = Date.now();
        this._failures = 0;
        this._trialInFlight = false;
        throw err;
      }
      // closed state: increment failures and maybe open
      this._failures++;
      if (this._failures >= this._threshold) {
        this._state = 'open';
        this._openedAt = Date.now();
        this._failures = 0;
      }
      throw err;
    }
  }

  // force reset to closed
  reset() {
    /**
     * Reset the circuit to `closed` and clear counters.
     * @returns {void}
     */
    this._state = 'closed';
    this._failures = 0;
    this.lastError = null;
    this._openedAt = null;
    this._trialInFlight = false;
  }
}

export default PowerCircuit;
