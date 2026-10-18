import { assertKnownOptions } from '../utils/options.js';

/**
 * Caller-controlled brownout policy for optional work.
 *
 * @class PowerBrownout
 * @public
 */

/**
 * Normalize the `adaptive` option.
 * @param {boolean|{alpha?:number, margin?:number, min?:number, max?:number, additiveIncrease?:number, beta?:number}} option
 * @returns {{enabled:boolean, alpha:number, margin:number, min:number, max:number, additiveIncrease:number, beta:number}}
 * @private
 */
function normalizeAdaptive(option) {
  const off = {
    enabled: false,
    alpha: 0.2,
    margin: 0.1,
    min: 0,
    max: 1,
    additiveIncrease: 0.05,
    beta: 0.8,
  };
  if (!option) return off;
  const cfg = option === true ? {} : option;
  if (typeof cfg !== 'object') return off;
  /** @param {any} v @param {number} lo @param {number} hi @param {number} d @returns {number} */
  const clamp = (v, lo, hi, d) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return d;
    return Math.min(hi, Math.max(lo, v));
  };
  return {
    enabled: cfg.enabled !== false,
    alpha: clamp(cfg.alpha, 0.001, 1, 0.2),
    margin: clamp(cfg.margin, -1, 1, 0.1),
    min: clamp(cfg.min, 0, 1, 0),
    max: clamp(cfg.max, 0, 1, 1),
    additiveIncrease: clamp(cfg.additiveIncrease, 0, 1, 0.05),
    beta: clamp(cfg.beta, 0.1, 0.99, 0.8),
  };
}

export class PowerBrownout {
  /**
   * @param {{threshold?:number, disabledKinds?:string[], adaptive?:boolean|{alpha?:number, margin?:number, min?:number, max?:number}}} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['threshold', 'disabledKinds', 'adaptive'], 'PowerBrownout');
    const { threshold = 0.8, disabledKinds = [], adaptive = false } = options || {};
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError('PowerBrownout threshold must be between 0 and 1');
    }
    if (!Array.isArray(disabledKinds) || disabledKinds.some((kind) => typeof kind !== 'string')) {
      throw new TypeError('PowerBrownout disabledKinds must be an array of strings');
    }
    this._baseThreshold = threshold;
    /** @type {{enabled:boolean, alpha:number, margin:number, min:number, max:number, additiveIncrease:number, beta:number}} */
    this._adaptive = normalizeAdaptive(adaptive);
    this._pressureEwma = null;
    this._threshold = threshold;
    this._disabledKinds = new Set(disabledKinds);
    this._pressure = 0;
    this._decisions = 0;
    this._shed = 0;
  }

  /** Update pressure from a normalized local signal. */
  /** @param {number} pressure */
  setPressure(pressure) {
    if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
      throw new RangeError('PowerBrownout pressure must be between 0 and 1');
    }
    this._pressure = pressure;
    if (this._adaptive.enabled) {
      const alpha = this._adaptive.alpha;
      this._pressureEwma =
        this._pressureEwma == null ? pressure : this._pressureEwma * (1 - alpha) + pressure * alpha;
      // Adaptive threshold (AIMD): when pressure is at/above the current
      // threshold we are shedding, so lower the threshold (multiplicative
      // decrease) to shed more aggressively next time. When pressure is below
      // the threshold we are allowing work, so raise it (additive increase) to
      // shed less. Clamped to [min, max].
      if (pressure >= this._threshold) {
        this._threshold = Math.max(this._adaptive.min, this._threshold * this._adaptive.beta);
      } else {
        this._threshold = Math.min(
          this._adaptive.max,
          this._threshold + this._adaptive.additiveIncrease
        );
      }
      this._threshold = Math.max(this._adaptive.min, Math.min(this._adaptive.max, this._threshold));
    }
    return this.stats();
  }

  /** Return whether optional work of `kind` may run. */
  /** @param {string} kind */
  allows(kind) {
    if (typeof kind !== 'string') throw new TypeError('PowerBrownout kind must be a string');
    this._decisions += 1;
    const allowed = this._pressure < this._threshold && !this._disabledKinds.has(kind);
    if (!allowed) this._shed += 1;
    return allowed;
  }

  /** Add or remove a kind from the explicit brownout set. */
  /** @param {string} kind @param {boolean} [disabled=true] */
  disable(kind, disabled = true) {
    if (typeof kind !== 'string') throw new TypeError('PowerBrownout kind must be a string');
    if (disabled) this._disabledKinds.add(kind);
    else this._disabledKinds.delete(kind);
    return this.stats();
  }

  /** Explain the current brownout state. */
  stats() {
    return {
      pressure: this._pressure,
      threshold: this._threshold,
      baseThreshold: this._baseThreshold,
      adaptive: this._adaptive.enabled,
      pressureEwma: this._pressureEwma,
      active: this._pressure >= this._threshold,
      disabledKinds: [...this._disabledKinds],
      decisions: this._decisions,
      shed: this._shed,
    };
  }

  getStats() {
    return this.stats();
  }

  get threshold() {
    return this._threshold;
  }
  set threshold(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('PowerBrownout threshold must be between 0 and 1');
    }
    this._threshold = value;
  }
}

/**
 * Read capability-based resource pressure without starting a sampler.
 * @param {{eventLoopPressure?:number}} [input]
 * @returns {number|null}
 */
export function getResourcePressure(input = {}) {
  const values = [];
  if (input.eventLoopPressure !== undefined) values.push(input.eventLoopPressure);
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const memory = process.memoryUsage();
    if (memory.heapTotal > 0) values.push(memory.heapUsed / memory.heapTotal);
  }
  return values.length > 0 ? Math.min(1, Math.max(...values)) : null;
}
