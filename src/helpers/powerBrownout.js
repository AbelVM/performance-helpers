import { assertKnownOptions } from '../utils/options.js';

/**
 * Caller-controlled brownout policy for optional work.
 *
 * @class PowerBrownout
 * @public
 */
export class PowerBrownout {
  /**
   * @param {{threshold?:number, disabledKinds?:string[]}} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['threshold', 'disabledKinds'], 'PowerBrownout');
    const { threshold = 0.8, disabledKinds = [] } = options || {};
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError('PowerBrownout threshold must be between 0 and 1');
    }
    if (!Array.isArray(disabledKinds) || disabledKinds.some((kind) => typeof kind !== 'string')) {
      throw new TypeError('PowerBrownout disabledKinds must be an array of strings');
    }
    this.threshold = threshold;
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
    return this.stats();
  }

  /** Return whether optional work of `kind` may run. */
  /** @param {string} kind */
  allows(kind) {
    if (typeof kind !== 'string') throw new TypeError('PowerBrownout kind must be a string');
    this._decisions += 1;
    const allowed = this._pressure < this.threshold && !this._disabledKinds.has(kind);
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
      threshold: this.threshold,
      active: this._pressure >= this.threshold,
      disabledKinds: [...this._disabledKinds],
      decisions: this._decisions,
      shed: this._shed,
    };
  }

  getStats() {
    return this.stats();
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
