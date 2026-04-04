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
export class PowerDefer {
  constructor() {
    this._settled = false;
    /** @type {Promise<any>} */
    this.promise = new Promise((resolve, reject) => {
      this._resolve = (v) => {
        if (this._settled) return;
        this._settled = true;
        resolve(v);
      };
      this._reject = (err) => {
        if (this._settled) return;
        this._settled = true;
        reject(err);
      };
    });
  }

  /**
   * Resolve the deferred promise. No-op if already settled.
   * @param {any} value
   * @returns {void}
   */
  resolve(value) {
    this._resolve(value);
  }

  /**
   * Reject the deferred promise. No-op if already settled.
   * @param {any} err
   * @returns {void}
   */
  reject(err) {
    this._reject(err);
  }

  /**
   * Whether the deferred has been settled.
   * @returns {boolean}
   */
  get settled() {
    return this._settled;
  }
}

export default PowerDefer;
