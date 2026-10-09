/**
 * PowerLatch — a simple counting barrier.
 * Resolves waiters when the internal count reaches zero.
 *
 * @class PowerLatch
 * @public
 *
 * @example
 * const latch = new PowerLatch(3);
 * // from three independent async paths:
 * latch.countDown();
 * latch.countDown();
 * latch.countDown();
 * await latch.wait(); // resolves when count reaches 0
 */
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { PowerDefer } from './powerDefer.js';
import { setSafeTimeout } from '../utils/timers.js';
import { neutralise } from '../utils/neutralise.js';

export class PowerLatch {
  /**
   * @typedef {import('./jsdoc-types.js').PowerLatchOptions} PowerLatchOptions
   * @typedef {import('./jsdoc-types.js').PowerLatchWaiter} PowerLatchWaiter
   * @typedef {import('./jsdoc-types.js').PowerLatchWaitOptions} PowerLatchWaitOptions
   */
  /**
   * @param {number} [count=1] - initial count required to release the latch
   * @param {PowerLatchOptions} [options] - `onAbort` is invoked with the
   *   rejection reason by {@link PowerLatch#abort}.
   */
  constructor(count = 1, options = {}) {
    // An options object as the sole argument means the caller reached for the
    // obvious shape, and it used to be rejected outright with a message naming a
    // number they had just passed an object for. `PowerTTLMap` already normalises
    // both forms; so now do these.
    // An options object is recognised only when it carries at least one known
    // option key. A bare `{}` still falls through to the numeric path and is
    // rejected as before — which `test/powerLatch.reset.test.js` pins as a
    // property: whatever the constructor rejects, `reset()` must reject too.
    if (count && typeof count === 'object' && 'count' in count) {
      const carried = /** @type {*} */ (count);
      options = /** @type {PowerLatchOptions} */ (carried);
      count = /** @type {{count?: number}} */ (carried).count;
    }
    // `options` now carries the whole object, so `assertKnownOptions` below
    // validates every key in it — not just the `count` this branch read.
    assertKnownOptions(options, ['count', 'onAbort'], 'PowerLatch');
    // `0` is a real state - a latch that is already complete - and is kept. A
    // negative count, or a `NaN` that `|| 0` turned into zero, is not a latch
    // that finishes early; it is one nobody can reason about, because `wait()`
    // returns immediately and nothing is ever actually waited for.
    this._count = assertLimitRequired(count, {
      name: 'count',
      className: 'PowerLatch',
      integer: true,
      min: 0,
      fallback: 0,
    });
    /** @type {Map<number, PowerLatchWaiter>} */
    this._waiters = new Map();
    this._nextWaiterToken = 1;
    this._aborted = false;
    /** @type {any} */
    this._abortReason = null;
    // Terminal, unlike `_aborted`: `dispose()` is documented as releasing
    // every resource, and a teardown that can be undone by `reset()` is not
    // one. `reset()` re-arms by design, so a disposed latch needs a flag
    // `reset()` does not clear.
    this._disposed = false;
    /** @type {?((reason:any)=>void)} */
    this._onAbort = typeof options.onAbort === 'function' ? options.onAbort : null;
  }

  /**
   * Optional callback invoked when `abort()` is called: `(reason) => void`.
   */
  get onAbort() {
    return this._onAbort;
  }

  set onAbort(fn) {
    this._onAbort = typeof fn === 'function' ? fn : null;
  }

  /**
   * Decrement the latch by one (or by `n` if provided). When the count
   * reaches zero all pending waiters are resolved.
   * @param {number} [n=1]
   * @returns {number} remaining count
   */
  countDown(n = 1) {
    const dec = Math.max(0, Math.floor(Number(n) || 0));
    if (dec === 0) return this._count;
    this._count = Math.max(0, this._count - dec);
    if (this._count === 0) this._resolveAll();
    return this._count;
  }

  /**
   * Decrement the latch only if it's greater than zero.
   * Returns remaining count.
   * @returns {number}
   */
  decrementUnlessZero() {
    if (this._count === 0) return 0;
    return this.countDown(1);
  }

  /**
   * Wait until the latch reaches zero. If already zero returns a resolved Promise.
   * @returns {Promise<void>}
   */
  /**
   * Wait until the latch reaches zero.
   * Options: `wait(timeoutMs)` or `wait({ timeout, signal })`.
   * If aborted via `abort()` pending waiters are rejected. A disposed latch
   * rejects too, with `code: 'EDISPOSED'` — see {@link PowerLatch#dispose}.
   * @param {number|PowerLatchWaitOptions} [opts]
   * @returns {Promise<void>}
   */
  wait(opts) {
    if (this._disposed)
      return Promise.reject(Object.assign(new Error('Disposed'), { code: 'EDISPOSED' }));
    if (this._aborted)
      return Promise.reject(
        this._abortReason || Object.assign(new Error('Aborted'), { code: 'EABORT' })
      );
    if (this._count === 0) return Promise.resolve();

    /** @type {?number} */
    let timeout = null;
    /** @type {?AbortSignal} */
    let signal = null;
    if (typeof opts === 'number') timeout = opts;
    else if (opts && typeof opts === 'object') {
      timeout = opts.timeout || null;
      signal = opts.signal || null;
    }

    if (signal?.aborted) {
      return Promise.reject(
        signal.reason || Object.assign(new Error('Aborted'), { code: 'EABORT' })
      );
    }

    const defer = new PowerDefer();
    const token = this._nextWaiterToken++;
    /** @type {PowerLatchWaiter} */
    const waiter = { token, defer, timer: null, signalHandler: null, signal };

    // register timeout
    if (typeof timeout === 'number' && timeout > 0) {
      // RES-015. `setSafeTimeout`, not `setTimeout`: a plain timer is *ref'd*, so it
      // keeps the Node event loop alive. One pending waiter with a timeout therefore
      // held a process open for the whole timeout after the latch had been disposed or
      // opened - measured in a subprocess: exit 124 (killed at 4s) for a single
      // `wait({ timeout: 5000 })` on a closed latch, against exit 0 for a bare control,
      // and exit 124 for a bare `setTimeout(fn, 5000)` proving the harness could detect
      // a hold. A latch is the shape most likely to be abandoned mid-wait - a request
      // handler that gave up, a test that finished - so this is the case where the
      // process should be free to leave.
      //
      // `setSafeTimeout` also `unref`s rather than allocating to ask, which is what
      // stopped 200 000 calls producing 400 000 live `Timeout` objects when it was
      // written; see `src/utils/timers.js`.
      waiter.timer = setSafeTimeout(() => {
        this._removeWaiter(token);
        defer.reject(Object.assign(new Error('Timeout'), { code: 'ETIMEOUT' }));
      }, timeout);
    }

    // register abort signal
    if (typeof signal?.addEventListener === 'function') {
      const onAbort = () => {
        this._removeWaiter(token);
        defer.reject(signal.reason || Object.assign(new Error('Aborted'), { code: 'EABORT' }));
      };
      waiter.signalHandler = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    this._waiters.set(token, waiter);
    return defer.promise;
  }

  /**
   * Reset the latch to a new count. Any existing waiters will be resolved
   * immediately if the new count is zero.
   * @param {number} [count=1]
   */
  reset(count = 1) {
    // Through the same validator the constructor uses, because this used to run
    // `Math.max(0, Number(count) || 0)` and accepted everything the constructor
    // rejected. A fractional count is not a smaller latch, it is a latch that
    // can never reach zero: `reset(2.5)` then one `countDown()` leaves
    // `remaining` at 1.5, and `wait()` never settles. Verified. `reset(NaN)`
    // and `reset(-5)` both landed on 0 and so *resolved* every waiter — a bad
    // argument fabricating completion is worse than the hang.
    this._count = assertLimitRequired(count, {
      name: 'count',
      className: 'PowerLatch',
      integer: true,
      min: 0,
      fallback: 1,
    });
    if (this._count === 0) this._resolveAll();
    // resetting clears aborted state
    this._aborted = false;
    this._abortReason = null;
  }

  /**
   * Number of remaining counts.
   * @returns {number}
   */
  get remaining() {
    return this._count;
  }

  /**
   * True when the latch is already released.
   * @returns {boolean}
   */
  get done() {
    return this._count === 0;
  }

  /**
   * Detach a single waiter, either by token or by the waiter object itself.
   *
   * The object form exists because `_settleAll` and `wait`'s timeout path
   * already hold the waiter; the token form is what the abort listener has.
   *
   * @param {number|PowerLatchWaiter} waiterOrToken
   * @returns {?PowerLatchWaiter} The removed waiter, or `null` if it was already gone.
   */
  _removeWaiter(waiterOrToken) {
    const token =
      waiterOrToken && typeof waiterOrToken === 'object' ? waiterOrToken.token : waiterOrToken;
    const waiter = this._waiters.get(token);
    if (!waiter) return null;

    this._waiters.delete(token);
    if (waiter.timer) {
      try {
        clearTimeout(waiter.timer);
      } catch (e) {
        /* swallow */
      }
      waiter.timer = null;
    }
    if (waiter.signalHandler && typeof waiter.signal?.removeEventListener === 'function') {
      try {
        waiter.signal.removeEventListener('abort', waiter.signalHandler);
      } catch (e) {
        /* swallow */
      }
    }
    return waiter;
  }

  /**
   * Tear down every registered waiter, clearing its timer and abort listener,
   * then hand each `PowerDefer` to `settle`. Failures from either teardown are
   * swallowed so one bad waiter cannot strand the rest.
   *
   * @param {(defer: PowerDefer) => void} settle
   * @returns {void}
   */
  _settleAll(settle) {
    const waiters = this._waiters;
    /** @type {Map<number, PowerLatchWaiter>} */
    this._waiters = new Map();
    for (const w of waiters.values()) {
      try {
        if (w.timer) clearTimeout(w.timer);
        if (w.signalHandler && typeof w.signal?.removeEventListener === 'function') {
          try {
            w.signal.removeEventListener('abort', w.signalHandler);
          } catch (e) {
            /* swallow */
          }
        }
        settle(w.defer);
      } catch (e) {
        /* swallow */
      }
    }
  }

  _resolveAll() {
    /** @type {(defer: PowerDefer) => void} */
    const settle = (defer) => defer.resolve();
    this._settleAll(settle);
  }

  /**
   * @param {any} err
   * @returns {void}
   */
  _rejectAll(err) {
    /** @type {(defer: PowerDefer) => void} */
    const settle = (defer) => defer.reject(err);
    this._settleAll(settle);
  }

  /**
   * Abort pending waiters. If `reason` provided it will be used to reject waiters.
   *
   * Idempotent. A second call is a no-op rather than a second abort: callers
   * abort on both an error path and a cleanup path, and one logical abort must
   * fire `onAbort` once.
   *
   * @param {any} [reason]
   */
  abort(reason) {
    if (this._aborted) return;
    this._aborted = true;
    this._abortReason = reason || Object.assign(new Error('Aborted'), { code: 'EABORT' });
    // invoke optional onAbort callback
    try {
      if (typeof this._onAbort === 'function') this._onAbort(this._abortReason);
    } catch (e) {
      // swallow
    }
    this._rejectAll(this._abortReason);
  }

  /**
   * Create a latch that waits for a single signal.
   * @returns {PowerLatch}
   */
  static one() {
    return new PowerLatch(1);
  }

  /**
   * Release every resource this instance holds. Terminal: pending waiters are
   * rejected with `code: 'EDISPOSED'`, the count is zeroed, later `wait()`
   * calls reject rather than registering, and `reset()` becomes a no-op.
   *
   * This is a teardown, not a re-arm. It used to call `reset()` with its
   * default count of 1, which left every pending `wait()` unsettled forever and
   * left `remaining` at 1 — and because `reset()` clears the aborted state, it
   * also made an aborted latch live again. Compare
   * `PowerPermitGate.reset()`, which rejects its waiters.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using` and gives callers an explicit
   * name to call.
   *
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._count = 0;
    this._rejectAll(Object.assign(new Error('Disposed'), { code: 'EDISPOSED' }));
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    neutralise(this, 'reset');
  }

  /**
   * Alias for {@link dispose}, so `using x = new X()` releases the instance
   * deterministically at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerLatch;
