export class PowerPermitGate {
    /**
     * @param {PowerPermitGateOptions} [options]
     */
    constructor(options?: PowerPermitGateOptions);
    _capacity: number;
    _queueCapacity: number;
    _available: number;
    _waiters: PowerQueue;
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
     * @type {number}
     * @private
     */
    private _held;
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
    private _cancelledWaiters;
    /** Maximum number of permits. */
    get capacity(): number;
    /** Currently available permits. */
    get available(): number;
    /** Number of queued waiters, excluding any that have been aborted. */
    get pending(): number;
    /** Maximum number of waiters allowed in the queue. */
    get queueCapacity(): number;
    /** True when the waiting queue is saturated. */
    get isFull(): boolean;
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
    get active(): number;
    /**
     * Acquire a permit asynchronously.
     * Resolves immediately when a permit is available; otherwise waits in FIFO order.
     * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
     */
    acquire(options?: {}): Promise<PowerReleaseFn>;
    /**
     * Try to acquire a permit without waiting.
     * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(): PowerReleaseFn | null;
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
    release(count?: number): number;
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
    reset(options?: {
        available?: number | undefined;
        reason?: Error | undefined;
    }): void;
    _makeRelease(): () => void;
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
    private _grant;
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
    private _grantTo;
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
     * @private
     */
    private _serveWaiters;
    /**
     * Release every resource this instance holds: queued waiters are rejected and
     * the listener registry is emptied.
     *
     * Idempotent, and safe to call while the instance is idle. Exists so the
     * instance works with `using` / `await using`.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * Alias for {@link dispose}, so `using x = new X()` releases the instance
     * deterministically at scope exit.
     * @returns {void}
     */
    [Symbol.dispose](): void;
}
export type PowerReleaseFn = import("./jsdoc-types.js").PowerReleaseFn;
export type PowerPermitGateOptions = import("./jsdoc-types.js").PowerPermitGateOptions;
import { PowerQueue } from './powerQueue.js';
