export class PowerBackpressure {
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
    _capacity: number;
    _queueCapacity: number;
    _lowWaterMark: number;
    _refillAmount: number;
    _refillInterval: number;
    _available: number;
    _waiters: PowerQueue;
    _refillTimer: any;
    /** Maximum concurrent permits. */
    get capacity(): number;
    /** Available permits for producers. */
    get available(): number;
    /** Number of producers currently waiting for permits. */
    get pending(): number;
    /** Maximum number of waiting producers. */
    get queueCapacity(): number;
    /** True when the waiting queue is full. */
    get isFull(): boolean;
    /**
     * Acquire a permit asynchronously.
     * Resolves immediately when a permit is available.
     * Otherwise queues the producer until capacity frees.
     * @returns {Promise<Function>} Promise resolving to a release callback.
     */
    acquire(): Promise<Function>;
    /**
     * Try to acquire a permit immediately.
     * @returns {Function|null} Release callback, or `null` if no permit is available.
     */
    tryAcquire(): Function | null;
    /**
     * Release one or more permits back to the controller.
     * @param {number} [count=1]
     */
    release(count?: number): void;
    /**
     * Reset the controller to its initial capacity and clear waiting producers.
     */
    reset(): void;
    _grant(): () => void;
    _scheduleRefill(): void;
    _performRefill(): void;
}
export default PowerBackpressure;
import { PowerQueue } from './powerQueue.js';
