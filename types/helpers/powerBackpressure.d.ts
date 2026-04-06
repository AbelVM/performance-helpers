export class PowerBackpressure extends PowerPermitGate {
    /**
     * @param {Object} [options]
     * @param {number} [options.capacity=100] Maximum number of concurrent permits.
     * @param {number} [options.queueCapacity=1000] Maximum number of waiting producers.
     * @param {number} [options.lowWaterMark=Math.ceil(capacity * 0.25)] When available tokens drop below this threshold, adaptive refill begins.
     * @param {number} [options.refillAmount=Math.max(1, Math.ceil(capacity * 0.1))] Base refill amount when pressure is detected.
     * @param {number} [options.refillInterval=200] Refill interval in milliseconds.
     * @param {number} [options.initialTokens=capacity] Initial available permits.
     */
    constructor(options?: {
        capacity?: number | undefined;
        queueCapacity?: number | undefined;
        lowWaterMark?: number | undefined;
        refillAmount?: number | undefined;
        refillInterval?: number | undefined;
        initialTokens?: number | undefined;
    });
    _lowWaterMark: number;
    _refillAmount: number;
    _refillInterval: number;
    _refillTimer: any;
    /**
     * Reset the controller to its initial capacity and clear waiting producers.
     */
    reset(): void;
    _scheduleRefill(): void;
    _performRefill(): void;
}
export default PowerBackpressure;
import { PowerPermitGate } from './powerPermitGate.js';
