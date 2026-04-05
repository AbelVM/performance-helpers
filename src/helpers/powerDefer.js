/**
 * Deferred promise primitive.
 * Separates a `Promise` from its `resolve`/`reject` functions.
 * Useful for barriers and manual promise coordination.
 *
 * @example
 * const d = new PowerDefer();
 * setTimeout(() => d.resolve(42), 10);
 * await d.promise; // 42
 */
const _deferInternals = new WeakMap();

export class PowerDefer {
  /**
   * @typedef {Object} PowerDeferOptions
   * @property {boolean} [autoReject]
   */
  constructor() {
    this._settled = false;
    this._status = 'pending';
    /** @type {Promise<any>} */
    this.promise = new Promise((resolve, reject) => {
      const resolveFn = (v) => {
        if (this._settled) return;
        this._settled = true;
        this._status = 'fulfilled';
        resolve(v);
      };
      const rejectFn = (err) => {
        if (this._settled) return;
        this._settled = true;
        this._status = 'rejected';
        reject(err);
      };
      // store resolver/rejector in WeakMap so they are not assignable from user code
      _deferInternals.set(this, { resolve: resolveFn, reject: rejectFn });
    });
  }

  /**
   * Resolve the deferred promise. No-op if already settled.
   * @param {any} value
   * @returns {void}
   */
  resolve(value) {
    const i = _deferInternals.get(this);
    if (i && typeof i.resolve === 'function') i.resolve(value);
  }

  /**
   * Reject the deferred promise. No-op if already settled.
   * @param {any} err
   * @returns {void}
   */
  reject(err) {
    const i = _deferInternals.get(this);
    if (i && typeof i.reject === 'function') i.reject(err);
  }

  /**
   * Whether the deferred has been settled.
   * @returns {boolean}
   */
  get settled() {
    return this._settled;
  }

  /**
   * Status of the deferred: 'pending' | 'fulfilled' | 'rejected'
   * @returns {'pending'|'fulfilled'|'rejected'}
   */
  get status() {
    return this._status;
  }

  /**
   * Convenience boolean: true if resolved successfully
   * @returns {boolean}
   */
  get fulfilled() {
    return this._status === 'fulfilled';
  }

  /**
   * Convenience boolean: true if rejected
   * @returns {boolean}
   */
  get rejected() {
    return this._status === 'rejected';
  }
}

export default PowerDefer;
