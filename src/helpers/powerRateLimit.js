/**
 * PowerRateLimit — compose multiple limiters (tryConsume succeeds only when all
 * underlying limiters allow consumption).
 *
 * Example:
 * const limit = new PowerRateLimit([
 *   new PowerThrottle({ capacity: 100, refillRate: 10 }),
 *   new PowerSlidingWindow({ capacity: 1000, windowMs: 60000 }),
 * ]);
 * if (limit.tryConsume()) { /* perform work * / }
 */

export class PowerRateLimit {
  /**
   * @param {Array<Object>} limiters - Array of limiter instances implementing
   *   `tryConsume(n)` and preferably `available()`.
   * @param {Object} [options]
   * @param {boolean} [options.atomic=false] - When `true` attempt to provide
   *   atomic semantics: either all limiters allow consumption or none will be
   *   left mutated. This requires underlying limiters to expose `available()`
   *   or an undo primitive (e.g. `reserve`/`release` or `addTokens`). If a
   *   safe rollback cannot be guaranteed the call will return `false`.
   */
  constructor(limiters = [], options = {}) {
    if (!Array.isArray(limiters)) throw new TypeError('limiters must be an array');
    this.limiters = limiters.slice();
    this.atomicDefault = Boolean(options.atomic);
  }

  /**
   * Try to consume `n` tokens across all limiters. Returns true only when
   * every underlying limiter allows consumption. This method first performs
   * a non-mutating availability check when `available()` is present; if all
   * checks pass it then performs the actual `tryConsume` calls to commit.
   *
   * Note: when a limiter does not implement `available()` this method falls
   * back to calling `tryConsume` directly which may partially mutate state
   * if other limiters subsequently fail. Prefer limiters that implement
   * `available()` for atomic semantics.
   *
   * @param {number} [n=1]
   * @returns {boolean}
   */
  tryConsume(n = 1, options = {}) {
    const want = Math.max(0, Math.floor(+n) || 0);
    if (want === 0) return true;
    const atomic = options.atomic == null ? this.atomicDefault : Boolean(options.atomic);

    // Fast non-mutating check when available() exists on all limiters
    let allHaveAvailable = true;
    for (const l of this.limiters) {
      if (typeof l.available === 'function') {
        try {
          if (l.available() < want) return false;
        } catch (e) {
          return false;
        }
      } else {
        allHaveAvailable = false;
      }
    }

    if (!atomic || allHaveAvailable) {
      // Non-atomic or safe fast-path: commit directly
      for (const l of this.limiters) {
        if (typeof l.tryConsume !== 'function')
          throw new TypeError('limiter must implement tryConsume');
        const ok = l.tryConsume(want);
        if (!ok) return false;
      }
      return true;
    }

    // Atomic required but some limiters lack available(): attempt two-phase
    // approach using reserve/tryConsume and best-effort rollbacks.
    const committed = [];
    // Pre-check: if any limiter without available() also lacks any undo
    // capability (reserve/release or addTokens), we cannot guarantee atomicity.
    for (const l of this.limiters) {
      if (typeof l.available !== 'function') {
        const supportsUndo =
          typeof l.reserve === 'function' ||
          typeof l.release === 'function' ||
          typeof l.addTokens === 'function' ||
          typeof l.rollback === 'function';
        if (!supportsUndo) {
          // cannot safely perform atomic consume
          return false;
        }
      }
    }

    // Commit attempts
    for (const l of this.limiters) {
      if (typeof l.reserve === 'function') {
        // reserve returns a token or truthy marker
        try {
          const token = l.reserve(want);
          if (!token) {
            // reservation failed -> rollback
            for (let i = committed.length - 1; i >= 0; i--) {
              this._undoCommit(committed[i], want).catch(() => {});
            }
            return false;
          }
          committed.push({ l, method: 'reserve', token });
          continue;
        } catch (e) {
          for (let i = committed.length - 1; i >= 0; i--) {
            this._undoCommit(committed[i], want).catch(() => {});
          }
          return false;
        }
      }

      // fallback: call tryConsume (we checked undo capability earlier)
      if (typeof l.tryConsume !== 'function') {
        for (let i = committed.length - 1; i >= 0; i--) {
          this._undoCommit(committed[i], want).catch(() => {});
        }
        throw new TypeError('limiter must implement tryConsume or reserve');
      }
      try {
        const ok = l.tryConsume(want);
        if (!ok) {
          for (let i = committed.length - 1; i >= 0; i--) {
            this._undoCommit(committed[i], want).catch(() => {});
          }
          return false;
        }
        committed.push({ l, method: 'tryConsume' });
      } catch (e) {
        for (let i = committed.length - 1; i >= 0; i--) {
          this._undoCommit(committed[i], want).catch(() => {});
        }
        return false;
      }
    }

    return true;
  }

  /**
   * Return the minimum available tokens across all limiters.
   * If any limiter does not expose `available()`, this returns `0`.
   * @returns {number}
   */
  available() {
    if (this.limiters.length === 0) return Infinity;
    let min = Infinity;
    for (const l of this.limiters) {
      if (typeof l.available !== 'function') return 0;
      try {
        const value = l.available();
        min = Math.min(min, Number(value) || 0);
      } catch (e) {
        return 0;
      }
    }
    return min === Infinity ? 0 : min;
  }

  /**
   * Reserve `n` tokens across all limiters and return a token to undo later.
   * Returns `null` when reservation fails.
   * @param {number} [n=1]
   * @returns {object|null}
   */
  reserve(n = 1) {
    const want = Math.max(0, Math.floor(+n) || 0);
    if (want === 0) return { n: 0 };
    if (!this.tryConsume(want, { atomic: true })) return null;
    return { n: want };
  }

  /**
   * Release a prior reservation token or numeric count back to the limiters.
   * @param {object|number} tokenOrN
   */
  release(tokenOrN) {
    const n =
      tokenOrN == null
        ? 0
        : typeof tokenOrN === 'object'
          ? Number(tokenOrN.n) || 0
          : Math.max(0, Math.floor(+tokenOrN) || 0);
    if (n === 0) return;

    for (const l of this.limiters) {
      if (typeof l.release === 'function') {
        try {
          l.release(tokenOrN);
          continue;
        } catch (e) {
          // fallback to other undo paths
        }
      }
      if (typeof l.rollback === 'function') {
        try {
          l.rollback(n);
          continue;
        } catch (e) {
          /* swallow */
        }
      }
      if (typeof l.addTokens === 'function') {
        try {
          l.addTokens(n);
          continue;
        } catch (e) {
          /* swallow */
        }
      }
    }
  }

  rollback(nOrToken) {
    return this.release(nOrToken);
  }

  async _undoCommit(entry, want) {
    const { l, method, token } = entry;
    try {
      if (method === 'reserve' && typeof l.release === 'function') {
        // release a reservation token
        return l.release(token);
      }
      if (typeof l.rollback === 'function') return l.rollback(want);
      if (typeof l.addTokens === 'function') return l.addTokens(want);
      // best-effort: if limiter exposes reset, call it (may be heavy)
      if (typeof l.reset === 'function') return l.reset();
    } catch (e) {
      // swallow undo errors — nothing more we can do
    }
  }

  /**
   * Reset all underlying limiters where supported.
   */
  reset() {
    for (const l of this.limiters) {
      if (typeof l.reset === 'function') {
        try {
          l.reset();
        } catch (e) {
          /* swallow */
        }
      }
    }
  }
}

export default PowerRateLimit;
