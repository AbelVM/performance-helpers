export class PowerBackpressure extends PowerPermitGate {
    /**
     * @param {PowerBackpressureOptions} [options] `capacity` and `queueCapacity`
     *   are inherited from `PowerPermitGate`; the rest tune the refill schedule.
     */
    constructor(options?: PowerBackpressureOptions);
    /**
     * The refill amount the controller is currently probing with.
     *
     * With `adaptive` enabled this moves: up by `additiveIncrease` on every
     * refill that finds consumers draining, and down by a factor of `beta` on
     * every refill that finds them not. With it disabled it is constant, and
     * equal to the `refillAmount` option.
     *
     * @returns {number}
     */
    get refillAmount(): number;
    /**
     * Acquire a permit asynchronously.
     * Resolves immediately when a permit is available.
     * Otherwise queues the producer until capacity frees.
     * @param {Object} [options] - `signal` aborts the wait: the returned promise
     *   rejects with an `AbortError` and the producer leaves the queue instead of
     *   holding a slot until a permit is refilled.
     * @returns {Promise<PowerReleaseFn>} Promise resolving to a release callback.
     */
    acquire(options?: Object): Promise<PowerReleaseFn>;
    /**
     * Try to acquire a permit immediately.
     * @returns {PowerReleaseFn|null} Release callback, or `null` if no permit is available.
     */
    tryAcquire(): PowerReleaseFn | null;
    /**
     * Reset the controller to its initial capacity and clear waiting producers.
     */
    reset(): void;
    /**
     * Whether the wait queue physically holds anything.
     *
     * Deliberately the raw length rather than {@link PowerPermitGate#pending}:
     * the refill machinery is a safety net for a queue nothing else will drain,
     * so gating it on a *derived* count means one cancelled-but-not-yet-compacted
     * entry can turn the net off while a live waiter is still queued. `pending`
     * stays the user-facing answer ("how many producers are actually waiting");
     * this is the mechanism's own question.
     *
     * @returns {boolean}
     * @private
     */
    _scheduleRefill(): void;
    _performRefill(): void;
    /**
     * Permits currently held by consumers: granted and not yet returned.
     *
     * A named view of the base gate's `_held`, not a second counter. The
     * controller used to keep its own, incremented from the fast-path grant only,
     * and the two of them disagreed whenever a permit reached a *queued* producer
     * - which is most of them, and all of the ones a refill tick hands out.
     *
     * @returns {number}
     * @private
     */
    private get _inFlight();
    /**
     * One AIMD round.
     *
     * The signal is whether the consumers we handed permits to gave them back. A
     * refill tick with `_inFlight === capacity` means every permit this pool
     * granted is still out there and nothing has come back, however long the
     * consumer takes: that is congestion, and the window is cut
     * multiplicatively. Anything else means at least part of the outstanding work
     * completed, so the window grows additively.
     *
     * This is the TCP congestion-control shape with `refillAmount` as the
     * congestion window. It is not CoDel's delay-based variant: that measures a
     * round-trip time, and here the honest analogue of "did my probe come back"
     * is "did a permit come back", which needs no clock and cannot be fooled by a
     * fast consumer that keeps everything forever.
     *
     * It is also deliberately *loss-based*, which is the only one of Netflix's
     * three controllers whose signal transfers. `vegas` and `gradient2` are both
     * RTT-shaped, and a permit gate is a producer/consumer queue rather than an
     * RPC: there is no request/response round trip here for them to measure. A
     * delay-shaped controller for this class would need a queue-drain *rate*, not
     * a latency - see `ALGO-010` in `review.md`.
     *
     * @returns {void}
     * @private
     */
}
export default PowerBackpressure;
export type BackpressureAdaptiveOptions = import("./jsdoc-types.js").BackpressureAdaptiveOptions;
export type PowerBackpressureOptions = import("./jsdoc-types.js").PowerBackpressureOptions;
export type PowerReleaseFn = import("./jsdoc-types.js").PowerReleaseFn;
import { PowerPermitGate } from './powerPermitGate.js';
