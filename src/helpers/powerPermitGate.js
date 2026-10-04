/**
 * Internal permit gate helper used by semaphore-like classes.
 *
 * This helper manages a finite number of permits and a FIFO queue of waiters.
 * It is intentionally small and internal to avoid duplicating queue/release logic.
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerReleaseFn} PowerReleaseFn
 * @typedef {import('./jsdoc-types.js').PowerPermitGateOptions} PowerPermitGateOptions
 */
import { PowerQueue } from './powerQueue.js';
import { POWER_QUEUE_INITIAL_CAPACITY } from './constants.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { abortReason } from '../utils/abort.js';
import { queueFullError } from '../utils/errors.js';
import { neutralise } from '../utils/neutralise.js';

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
   * @param {PowerPermitGateOptions} [options] `className` and `limitName` let a
   *   wrapping class report its own vocabulary in validation messages; see
   *   {@link PowerPermitGateOptions}.
   */
  constructor(options = {}) {
    assertKnownOptions(
      options,
      ['capacity', 'queueCapacity', 'initialTokens', 'className', 'limitName'],
      'PowerPermitGate'
    );
    const { capacity, queueCapacity, initialTokens } = options || {};
    // Only `capacity` borrows the wrapper's vocabulary. `queueCapacity` and
    // `initialTokens` keep the gate's own names: a class that exposes neither
    // (`PowerSemaphore`) should still say `queueCapacity` when the gate is the
    // thing rejecting, because that is where the caller would fix it.
    const className =
      typeof options?.className === 'string' ? options.className : 'PowerPermitGate';
    const capacityName =
      typeof options?.limitName === 'string' && options.limitName ? options.limitName : 'capacity';
    // `Math.max(1, Math.floor(Number(capacity) || 1))` read `0` as absent, so
    // `capacity: 0` produced a gate holding *one* permit rather than none. A
    // permit gate configured to allow nothing is a real configuration - it is
    // how a dependency is switched off - and silently becoming open is the worst
    // direction for it to fail in. Validated instead.
    this._capacity = assertLimitRequired(capacity, {
      name: capacityName,
      className,
      min: 1,
      integer: true,
      fallback: 1,
    });
    this._queueCapacity =
      queueCapacity === undefined || queueCapacity === null
        ? Infinity
        : assertLimitRequired(queueCapacity, {
            name: 'queueCapacity',
            className,
            min: 0,
            integer: true,
            allowInfinity: true,
          });
    // `initialTokens` is genuinely optional and genuinely allowed to be 0 -
    // "start with nothing and let it refill" is the point of a token bucket - so
    // it is clamped to capacity rather than rejected.
    this._available =
      initialTokens === undefined || initialTokens === null
        ? this._capacity
        : Math.min(
            this._capacity,
            assertLimitRequired(initialTokens, {
              name: 'initialTokens',
              className,
              min: 0,
              integer: true,
            })
          );
    this._waiters = new PowerQueue(POWER_QUEUE_INITIAL_CAPACITY);
    /**
     * Permits that have been granted and not yet returned.
     *
     * The single count of outstanding work in this class, and the reason
     * {@link PowerPermitGate#reset} can no longer mint a permit. The invariant
     * it maintains is `_available + _held === _capacity`; `reset()` may only set
     * `_available` up to `capacity - _held`, so a holder that is still running
     * keeps occupying its permit across a reset instead of the reset handing
     * out a second one. Both grant paths go through `_grantTo`, so there is no
     * way for a permit to exist without being counted here.
     *
     * `protected` rather than `private`: `PowerBackpressure` reads it for its
     * heartbeat termination condition and for its `_inFlight` view, and
     * `_serveWaiters` below is driven the same way. Neither is part of the
     * public surface - `protected` keeps them out of what a consumer calls - but
     * a subclass reading a base field is precisely what the tag describes.
     *
     * @type {number}
     * @protected
     */
    this._held = 0;
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
    // Clamped rather than raw: the counter is a *decrement on compaction*, and
    // reporting a negative number of waiters is not a state any caller can act
    // on. `reset()` zeroes it alongside the queue, so the subtraction is
    // self-correcting, and the clamp is the belt to that braces.
    return Math.max(0, this._waiters.length - this._cancelledWaiters);
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

  /**
   * Number of permits currently held by callers that have not released yet.
   *
   * Read from `_held` rather than computed as `capacity - available`. The two are
   * the same number whenever `capacity` is a ceiling on concurrent holders -
   * which it is for this class, for `PowerSemaphore` and for `PowerBulkhead`, and
   * there the difference is invisible. It stops being the same for a subclass
   * whose refill can mint more permits than the pool size while a queue waits,
   * and there the difference is the whole point: `capacity - available` cannot
   * exceed `capacity`, so on a `PowerBackpressure` with a consumer that is not
   * returning its permits it saturates at `capacity` and reports a healthy gate
   * while the work is piling up. `_held` keeps counting. See ADR 0004.
   */
  get active() {
    return this._held;
  }

  /**
   * Acquire a permit asynchronously.
   * Resolves immediately when a permit is available; otherwise waits in FIFO order.
   * @param {{signal?: AbortSignal}} [options] `signal` aborts the *wait* for a
   *   permit, not any work started once one is held — see `src/utils/abort.js`.
   *   Checked before the fast path, so an already-aborted signal rejects rather
   *   than resolving because a permit happened to be free.
   * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
   */
  acquire(options = {}) {
    const signal = /** @type {{signal?: AbortSignal}} */ (options)?.signal ?? null;
    // Checked before the fast path, not after. A caller who hands over a dead
    // signal is saying "do not do this", and answering "it happens to be
    // convenient right now" is how an already-cancelled request ends up doing
    // work nobody will collect.
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this._available > 0) {
      return Promise.resolve(this._grant());
    }
    if (this.isFull) {
      return Promise.reject(queueFullError('PowerPermitGate', this._queueCapacity));
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
          reject(abortReason(signal));
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
   *
   * Released permits are handed straight to queued waiters where possible, so
   * a release that serves a waiter is a *transfer*: the permit is never
   * available in between, and the waiter is a holder from that instant. The
   * return value is the number of permits that actually came back to the gate
   * rather than being transferred, which is what a caller tracking outstanding
   * work needs - decrementing it by the requested count would subtract permits
   * that are still out.
   *
   * @param {number} [count=1]
   * @returns {number} Permits returned to the gate rather than transferred.
   */
  release(count = 1) {
    const wanted = Math.max(0, Math.floor(Number(count) || 1));
    const before = this._available;
    // `fromAvailable = false`: a released permit handed to a waiter is
    // transferred, and must never be counted as briefly available. Drawing it
    // out of `_available` anyway drove that counter negative and pushed the
    // outstanding count past `capacity` on the transfer path.
    const served = this._serveWaiters(wanted, false);
    // The permits that actually leave a holder: a transferred one has not left
    // *this* holder so much as changed which holder it is, so the count is
    // invariant for those and only the ones with nowhere to go are subtracted.
    const freed = wanted - served;
    if (freed > 0) {
      this._available = Math.min(this._capacity, this._available + freed);
    }
    this._held = Math.max(0, this._held - freed);
    // What actually made it back into the pool, which is less than `freed` when
    // the capacity clamp discards the surplus. Reported rather than assumed, so
    // a caller tracking outstanding work is not told a discarded permit is
    // still out.
    return this._available - before;
  }

  /**
   * Reset the gate and reject any waiting callers.
   *
   * Outstanding holders are *not* settled: the promise that produced a release
   * callback has already resolved, so there is nothing left to reject. What a
   * reset can do is stop pretending those permits are free - `_available` is
   * capped at `capacity - _held`, so a holder that is still running keeps
   * occupying its permit and a second `acquire()` cannot be granted alongside
   * it. When the holder does release, the permit returns normally. The previous
   * behaviour set `_available` unconditionally, so `reset()` on a gate of 1
   * with one holder running produced a *second* concurrent holder against a
   * limit of 1, permanently, and the first holder's release was then absorbed
   * by the capacity clamp.
   *
   * @param {Object} [options]
   * @param {number} [options.available] Number of permits to restore after reset.
   * @param {Error} [options.reason] Optional rejection reason for queued waiters.
   */
  reset(options = {}) {
    const { available = this._capacity, reason = new Error('PowerPermitGate reset') } = options;
    const wanted = Math.min(this._capacity, Math.max(0, Math.floor(Number(available) || 0)));
    while (this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (typeof next?.reject === 'function') next.reject(reason);
    }
    // The queue is now physically empty, so every cancelled-but-present entry
    // went with it. Not clearing this is how `pending` ended up at -1 and
    // `queueCapacity` one admission too permissive for the rest of the
    // instance's life.
    this._cancelledWaiters = 0;
    // `Math.max(0, ...)` and not a bare `capacity - held`: under the refill model
    // (ADR 0004) more permits can be outstanding than the pool is worth, so the
    // difference goes negative and assigning it straight through would leave
    // `available` reporting negative permits - which is the exact shape of the
    // fractional-`capacity` bug this class used to have.
    this._available = Math.max(0, Math.min(wanted, this._capacity - this._held));
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(1);
    };
  }

  /**
   * The fast-path grant: a permit that was already available is taken now.
   *
   * Paired with {@link PowerPermitGate#_grantTo}, which is the queued-waiter
   * grant. There is no third path, and `test/gates.interactions.test.js`
   * asserts the counter agrees with the number of outstanding release callbacks
   * on every route - which is what catches a new one being added.
   *
   * @returns {PowerReleaseFn}
   * @private
   */
  _grant() {
    this._available -= 1;
    this._held += 1;
    return this._makeRelease();
  }

  /**
   * The queued-waiter grant: the single point at which a permit reaches a
   * caller that was waiting for one.
   *
   * Both callers of this - `release()` handing a permit straight on, and a
   * `PowerBackpressure` refill tick - go through here, which is what makes
   * `_held` a count of reality rather than a count of the easy path. The AIMD
   * signal reads it, and two of the three routes used to bypass it entirely.
   *
   * @param {{resolve: (fn: PowerReleaseFn) => void}} entry
   * @param {boolean} fromAvailable - `true` when the permit was already counted
   *   into `_available` and must be drawn back out of it (a refill tick mints
   *   into the pool, then hands out what it minted); `false` when the permit is
   *   being transferred directly from a holder and never passes through the
   *   pool (a `release()`). See {@link PowerPermitGate#_serveWaiters}.
   * @returns {void}
   * @private
   */
  _grantTo(entry, fromAvailable) {
    // A transfer (`fromAvailable === false`) is invariant for `_held`: the
    // releasing caller's permit becomes the waiter's permit, and `release()`
    // correspondingly decrements nothing. Incrementing here as well is what
    // pushed the count past `capacity` - 4 holders, 3 releases serving 3
    // waiters, 7 "in flight" - and a concurrency count above the limit is a
    // signal the AIMD controller reads as congestion it cannot explain.
    if (fromAvailable) {
      this._available -= 1;
      this._held += 1;
    }
    entry.resolve(this._makeRelease());
  }

  /**
   * Hand permits to queued waiters, skipping any that have been aborted.
   *
   * Shared by `release()` and the `PowerBackpressure` refill loop, which is the
   * point: the refill loop used to shift entries itself, so it neither skipped
   * cancelled ones nor decremented `_cancelledWaiters`. A single cancellation
   * therefore left the counter permanently one too high, `pending` reported 0
   * with a live waiter still queued, and every refill tick short-circuited on
   * `pending === 0` - a self-sustaining deadlock that only `reset()` cleared.
   *
   * Aborted entries are compacted here rather than on the abort path, on
   * purpose: removing by reference from a ring buffer is O(n) per cancellation,
   * and a cancellation storm is exactly when an O(n) walk per cancelled waiter
   * is least affordable. The `_cancelledWaiters` counter keeps
   * {@link PowerPermitGate#pending} and {@link PowerPermitGate#isFull} honest in
   * the meantime.
   *
   * @param {number} permits - Maximum number of waiters to serve.
   * @param {boolean} fromAvailable - Whether the served permits are drawn from
   *   `_available` (they were counted into the pool first) or transferred
   *   straight from a holder without ever entering it. See
   *   {@link PowerPermitGate#_grantTo}; the two routes differ only in that
   *   flag, and conflating them is what put `_available` below zero.
   * @returns {number} How many were served.
   * @protected
   */
  _serveWaiters(permits, fromAvailable) {
    let served = 0;
    while (served < permits && this._waiters.length > 0) {
      const next = this._waiters.shift();
      if (next?.cancelled) {
        // A cancelled waiter never held a permit, so letting it consume one
        // would leak capacity invisibly - the gate would look one permit
        // emptier after every abort.
        this._cancelledWaiters = Math.max(0, this._cancelledWaiters - 1);
        continue;
      }
      if (typeof next?.resolve !== 'function') continue;
      // The waiter is being served, so nothing will abort it now. Detaching is
      // not optional: a caller reusing one AbortSignal across many acquires
      // would otherwise accumulate one listener per acquire and trip
      // MaxListenersExceededWarning, and the signal would retain every settled
      // closure.
      detach(next);
      this._grantTo(next, fromAvailable);
      served += 1;
    }
    return served;
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
}
