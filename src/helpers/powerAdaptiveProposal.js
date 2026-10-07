/**
 * Bounded, explainable adaptation proposals.
 *
 * This class proposes a value; it never applies policy or mutates another
 * helper. Callers remain responsible for deciding whether to accept it.
 *
 * @module powerAdaptiveProposal
 * @public
 */

import { assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {import('./jsdoc-types.js').PowerAdaptiveProposalOptions} PowerAdaptiveProposalOptions
 * @typedef {import('./jsdoc-types.js').PowerAdaptiveProposalResult} PowerAdaptiveProposalResult
 */

/**
 * A bounded controller for opt-in adaptive settings.
 *
 * `signal > 0` requests a decrease, `signal < 0` requests an increase, and
 * values near zero are held by hysteresis. The caller supplies the signal so
 * this primitive stays independent of transport, queue, and latency policy.
 *
 * @class PowerAdaptiveProposal
 * @public
 */
export class PowerAdaptiveProposal {
  /**
   * @param {PowerAdaptiveProposalOptions} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      ['initial', 'min', 'max', 'maxStep', 'hysteresis', 'cooldown'],
      'PowerAdaptiveProposal'
    );
    const {
      initial = 1,
      min = 1,
      max = 100,
      maxStep = Number.MAX_SAFE_INTEGER,
      hysteresis = 0,
      cooldown = 0,
    } = options;
    if (![initial, min, max, maxStep, hysteresis, cooldown].every(Number.isFinite)) {
      throw new TypeError('PowerAdaptiveProposal options must be finite numbers');
    }
    if (
      min > max ||
      initial < min ||
      initial > max ||
      maxStep < 0 ||
      hysteresis < 0 ||
      cooldown < 0
    ) {
      throw new RangeError('PowerAdaptiveProposal options are out of range');
    }
    this._value = initial;
    this._min = min;
    this._max = max;
    this._maxStep = maxStep;
    this._hysteresis = hysteresis;
    this._cooldown = cooldown;
    this._remaining = 0;
    this._last = 'initial';
    this._adjustments = 0;
    this._reversals = 0;
    this._peakSignal = 0;
    this._lastDirection = 0;
  }

  /** Current proposed value. */
  get value() {
    return this._value;
  }

  /** Return the bounded controller state for persistence across restarts. */
  snapshot() {
    return { version: 1, value: this._value, remaining: this._remaining, reason: this._last };
  }

  /** Restore a previously captured state without bypassing the controller bounds. */
  restore(snapshot) {
    if (!snapshot || snapshot.version !== 1) throw new TypeError('invalid proposal snapshot');
    if (
      !Number.isFinite(snapshot.value) ||
      snapshot.value < this._min ||
      snapshot.value > this._max ||
      !Number.isInteger(snapshot.remaining) ||
      snapshot.remaining < 0 ||
      snapshot.remaining > this._cooldown ||
      typeof snapshot.reason !== 'string'
    ) {
      throw new RangeError('proposal snapshot is outside the controller bounds');
    }
    this._value = snapshot.value;
    this._remaining = snapshot.remaining;
    this._last = snapshot.reason;
    return this.snapshot();
  }

  /**
   * Propose a bounded adjustment.
   * @param {number} signal Positive means congestion; negative means recovery.
   * @returns {PowerAdaptiveProposalResult}
   */
  propose(signal) {
    if (!Number.isFinite(signal)) throw new TypeError('signal must be finite');
    if (this._remaining > 0) {
      this._remaining -= 1;
      this._last = 'cooldown';
      return this._result(false, signal);
    }
    if (Math.abs(signal) <= this._hysteresis) {
      this._last = 'hysteresis';
      return this._result(false, signal);
    }
    const direction = signal > 0 ? -1 : 1;
    const delta = Math.min(this._maxStep, Math.abs(signal));
    const next = Math.min(this._max, Math.max(this._min, this._value + direction * delta));
    const changed = next !== this._value;
    this._value = next;
    this._remaining = changed ? this._cooldown : 0;
    this._last = changed ? (direction < 0 ? 'congestion' : 'recovery') : 'bound';
    return this._result(changed, signal);
  }

  /** Roll back one proposal to a prior value. */
  rollback(value = this._value) {
    if (!Number.isFinite(value) || value < this._min || value > this._max) {
      throw new RangeError('rollback value is outside the proposal bounds');
    }
    this._value = value;
    this._remaining = this._cooldown;
    this._last = 'rollback';
    return this._result(true, 0);
  }

  /** Stability counters for tuning the controller against real workloads. */
  stats() {
    return {
      value: this._value,
      min: this._min,
      max: this._max,
      adjustments: this._adjustments,
      reversals: this._reversals,
      peakSignal: this._peakSignal,
      atMin: this._value === this._min,
      atMax: this._value === this._max,
      reason: this._last,
    };
  }

  /** Alias for {@link stats}. */
  getStats() {
    return this.stats();
  }

  _result(changed, signal) {
    this._peakSignal = Math.max(this._peakSignal, Math.abs(signal));
    if (changed) {
      const direction = signal > 0 ? -1 : 1;
      if (this._lastDirection !== 0 && direction !== this._lastDirection) {
        this._reversals += 1;
      }
      this._lastDirection = direction;
      this._adjustments += 1;
    }
    return {
      value: this._value,
      changed,
      signal,
      reason: this._last,
      confidence: Math.min(1, Math.abs(signal)),
      cooldownRemaining: this._remaining,
    };
  }
}
