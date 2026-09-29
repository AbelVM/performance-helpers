export class PowerBackpressure extends PowerPermitGate {
    /**
     * @param {PowerBackpressureOptions} [options] `capacity` and `queueCapacity`
     *   are inherited from `PowerPermitGate`; the rest tune the refill schedule.
     */
    constructor(options?: PowerBackpressureOptions);
    _lowWaterMark: number;
    _refillAmount: number;
    _refillInterval: number;
    _refillTimer: any;
    _baseRefillAmount: number;
    _adaptive: {
        enabled: boolean;
        additiveIncrease: number;
        beta: number;
        min: number;
        max: number;
    };
    /** Permits currently held by consumers: granted and not yet returned. */
    _inFlight: number;
    _adaptiveHeartbeat: boolean;
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
     * Reset the controller to its initial capacity and clear waiting producers.
     */
    reset(): void;
    _scheduleRefill(): void;
    _performRefill(): void;
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
     * @returns {void}
     * @private
     */
    private _aimdStep;
}
export default PowerBackpressure;
export type BackpressureAdaptiveOptions = import("./jsdoc-types.js").BackpressureAdaptiveOptions;
export type PowerBackpressureOptions = import("./jsdoc-types.js").PowerBackpressureOptions;
export type PowerReleaseFn = import("./jsdoc-types.js").PowerReleaseFn;
import { PowerPermitGate } from './powerPermitGate.js';
