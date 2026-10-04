export class PowerPermitGate {
    /**
     * @param {PowerPermitGateOptions} [options] `className` and `limitName` let a
     *   wrapping class report its own vocabulary in validation messages; see
     *   {@link PowerPermitGateOptions}.
     */
    constructor(options?: PowerPermitGateOptions);
    _className: string;
    _capacity: number;
    _queueCapacity: number;
    _available: number;
    _waiters: PowerQueue;
    /**
     * Capacity units that have been granted and not yet returned.
     *
     * The single count of outstanding work in this class, and the reason
     * {@link PowerPermitGate#reset} can no longer mint a permit. The invariant
     * it maintains is `_available + _held === _capacity`; `reset()` may only set
     * `_available` up to `capacity - _held`, so a holder that is still running
     * keeps occupying its unit across a reset instead of the reset handing
     * out a second one. Both grant paths go through `_grantTo`, so there is no
     * way for a unit to exist without being counted here.
     *
     * With weights this is the sum of all outstanding `weight` values, not the
     * number of holders: a caller that acquired `weight: 3` occupies three units
     * in this counter.
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
    protected _held: number;
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
     * Number of capacity units currently held by callers that have not released yet.
     *
     * This is the sum of `weight` across all outstanding holders: with the default
     * `weight` of 1 it equals the holder count, but a caller that acquired with
     * `weight: 3` occupies three units. Read from `_held` rather than computed as
     * `capacity - available`. The two are
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
     * Acquire a permit asynchronously, optionally requesting more than one unit of
     * capacity at once.
     *
     * Resolves immediately when enough capacity is available; otherwise waits in
     * FIFO order. A `weight` heavier than `capacity` is rejected up front: a waiter
     * that can never be granted has no business entering the queue.
     *
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal] `signal` aborts the *wait* for a
     *   permit, not any work started once one is held — see `src/utils/abort.js`.
     *   Checked before the fast path, so an already-aborted signal rejects rather
     *   than resolving because a permit happened to be free.
     * @param {number} [options.weight=1] Number of capacity units to acquire. Must
     *   be a whole number >= 1. A weight exceeding `capacity` is rejected with a
     *   `TypeError`, because such a waiter can never be granted and would otherwise
     *   hang or fail only later via queue-full.
     * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback
     *   that returns exactly `weight` units when called.
     */
    acquire(options?: {
        signal?: AbortSignal | undefined;
        weight?: number | undefined;
    }): Promise<PowerReleaseFn>;
    /**
     * Try to acquire permits without waiting, optionally requesting more than one
     * unit of capacity at once.
     * @param {number} [weight=1] Number of capacity units to acquire. Must be a
     *   whole number >= 1; a weight exceeding `capacity` returns `null` because
     *   such a waiter can never be served.
     * @returns {PowerReleaseFn|null} Release callback when acquired, otherwise `null`.
     */
    tryAcquire(weight?: number): PowerReleaseFn | null;
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
    _makeRelease(weight?: number): () => void;
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
     * @param {{resolve: (fn: PowerReleaseFn) => void, weight?: number}} entry
     * @param {boolean} fromAvailable - `true` when the permit was already counted
     *   into `_available` and must be drawn back out of it (a refill tick mints
     *   into the pool, then hands out what it minted); `false` when the permit is
     *   being transferred directly from a holder without ever entering it (a
     *   `release()`). See {@link PowerPermitGate#_serveWaiters}.
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
     * and a cancellation storm is exactly the case where an O(n) walk per cancelled
     * waiter is least affordable. The `_cancelledWaiters` counter keeps
     * {@link PowerPermitGate#pending} and {@link PowerPermitGate#isFull} honest in
     * the meantime.
     *
     * With weights, each waiter consumes `entry.weight` units when served. A waiter
     * whose weight exceeds the remaining permits is **not** skipped — FIFO order
     * means no waiter behind it can advance either, so the loop stops and leaves
     * it in the queue for the next release.
     *
     * @param {number} permits - Maximum number of units to distribute.
     * @param {boolean} fromAvailable - Whether the served permits are drawn from
     *   `_available` (they were counted into the pool first) or transferred
     *   straight from a holder without ever entering it. See
     *   {@link PowerPermitGate#_grantTo}; the two routes differ only in that
     *   flag, and conflating them is what put `_available` below zero.
     * @returns {number} How many units were served.
     * @protected
     */
    protected _serveWaiters(permits: number, fromAvailable: boolean): number;
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
