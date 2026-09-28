/**
 * Internal permit gate helper used by semaphore-like classes.
 *
 * This helper manages a finite number of permits and a FIFO queue of waiters.
 * It is intentionally small and internal to avoid duplicating queue/release logic.
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerReleaseFn} PowerReleaseFn
 */
import { PowerQueue } from './powerQueue.js';

/**
 * PowerPermitGate
 *
 * Internal helper that manages a finite number of permits and a FIFO waiter queue.
 * Provides `acquire()`, `tryAcquire()` and `release()` primitives used by
 * semaphore-like helpers.
 *
 * @class PowerPermitGate
 * @public
 */
/**
 * Build the rejection for an aborted acquire.
 *
 * A DOMException with name `AbortError` so existing `err.name === 'AbortError'`
 * checks work, and so a cancelled wait is distinguishable from a real failure
 * by code as well as by name.
 *
 * @param {AbortSignal} signal
 * @returns {Error}
 * @private
 */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  try {
    return new DOMException('The operation was aborted', 'AbortError');
  } catch {
    // No DOMException constructor (a stripped runtime). A named Error is the
    // portable equivalent and is what the tests assert on.
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
  }
}

/**
 * Remove an entry's abort listener once it can no longer be aborted.
 * @param {{onAbort: ?EventListener, signal: ?AbortSignal}} entry
 * @returns {void}
 * @private
 */
function detach(entry) {
  if (!entry?.onAbort || !entry.signal) return;
  entry.signal.removeEventListener('abort', entry.onAbort);
  entry.onAbort = null;
}

export class PowerPermitGate {
  /**
   * @param {Object} [options]
   * @param {number} [options.capacity=1]
   * @param {number} [options.queueCapacity=Infinity]
   * @param {number} [options.initialTokens]
   */
  constructor(options = {}) {
    const { capacity = 1, queueCapacity = Infinity, initialTokens } = options || {};
    this._capacity = Math.max(1, Math.floor(Number(capacity) || 1));
    this._queueCapacity = Number.isFinite(Number(queueCapacity))
      ? Math.max(0, Math.floor(Number(queueCapacity)))
      : Infinity;
    this._available = Number.isFinite(initialTokens)
      ? Math.min(this._capacity, Math.max(0, Math.floor(Number(initialTokens))))
      : this._capacity;
    this._waiters = new PowerQueue(16);
    /**
     * Waiters that were aborted and are still physically in the queue.
     *
     * An abort is O(1): the entry is marked and the promise rejected, and the
     * entry is compacted out the next time the queue is drained. That is
     * deliberate - removing by reference from the ring buffer is O(n) per
     * cancellation, and a cancellation storm is exactly the case where you do
     * not want an O(n) walk per cancelled waiter. The counter keeps
     * {@link PowerPermitGate#pending} and {@link PowerPermitGate#isFull}
     * honest in the meantime.
     *
     * @type {number}
     * @private
     */
    this._cancelledWaiters = 0;
  }

  /** Maximum number of permits. */
  get capacity() {
    return this._capacity;
  }

  /** Currently available permits. */
  get available() {
    return this._available;
  }

  /** Number of queued waiters, excluding any that have been aborted. */
  get pending() {
    return this._waiters.length - this._cancelledWaiters;
  }

  /** Maximum number of waiters allowed in the queue. */
  get queueCapacity() {
    return this._queueCapacity;
  }

  /** True when the waiting queue is saturated. */
  get isFull() {
    // Counted against live waiters only. Counting an aborted-but-not-yet-
    // compacted entry would make a cancel storm look like a full queue, and a
    // caller would be told "queue is full" when the real problem is that they
    // cancelled everything.
    return this.pending >= this._queueCapacity;
  }

  /** Number of permits currently held. */
  get active() {
    return this._capacity - this._available;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when a permit is available; otherwise waits in FIFO order.
   * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
   */
  acquire(options = {}) {
    const signal = /** @type {{signal?: AbortSignal}} */ (options)?.signal ?? null;
    // Checked before the fast path, not after. A caller who hands over a dead
    // signal is saying "do not do this", and answering "it happens to be
    // convenient right now" is how an already-cancelled request ends up doing
    // work nobody will collect.
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if (this._available > 0) {
      return Promise.resolve(this._grant());
    }
    if (this.isFull) {
      return Promise.reject(new Error('PowerPermitGate queue is full'));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal: signal ?? null,
        onAbort: /** @type {?EventListener} */ (null),
        cancelled: false,
      };
      this._waiters.push(entry);
      if (signal) {
        entry.onAbort = () => {
          if (entry.cancelled) return;
          entry.cancelled = true;
          this._cancelledWaiters += 1;
          detach(entry);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
    });
  }

  /**
   * Try to acquire a permit without waiting.
   * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
   */
  tryAcquire() {
    if (this._available > 0) {
      return this._grant();
    }
    return null;
  }

  /**
   * Release one or more permits back to the gate.
   * @param {number} [count=1]
   */
  release(count = 1) {
    let remaining = Math.max(0, Math.floor(Number(count) || 1));
    while (remaining > 0 && this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (next?.cancelled) {
        // Compacted out here rather than on the abort path. Deliberately does
        // NOT consume a permit: a cancelled waiter never held one, and letting
        // it consume one would leak capacity invisibly - the gate would look
        // one permit emptier after every abort.
        this._cancelledWaiters = Math.max(0, this._cancelledWaiters - 1);
        continue;
      }
      if (typeof next?.resolve === 'function') {
        // The waiter is being served, so nothing will abort it now. Detaching
        // is not optional: a caller reusing one AbortSignal across many
        // acquires would otherwise accumulate one listener per acquire and
        // trip MaxListenersExceededWarning, and the signal would retain every
        // settled closure.
        detach(next);
        next.resolve(this._makeRelease());
        remaining -= 1;
      }
    }
    if (remaining > 0) {
      this._available = Math.min(this._capacity, this._available + remaining);
    }
  }

  /**
   * Reset the gate and reject any waiting callers.
   * @param {Object} [options]
   * @param {number} [options.available] Number of permits to restore after reset.
   * @param {Error} [options.reason] Optional rejection reason for queued waiters.
   */
  reset(options = {}) {
    const { available = this._capacity, reason = new Error('PowerPermitGate reset') } = options;
    this._available = Math.min(this._capacity, Math.max(0, Math.floor(Number(available) || 0)));
    while (this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (typeof next?.reject === 'function') next.reject(reason);
    }
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(1);
    };
  }

  _grant() {
    this._available -= 1;
    return this._makeRelease();
  }

  /**
   * Release every resource this instance holds: queued waiters are rejected and
   * the listener registry is emptied.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using`.
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
