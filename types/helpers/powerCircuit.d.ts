/**
 * PowerCircuit — a simple circuit breaker primitive.
 *
 * States:
 * - `closed` — normal operation
 * - `open` — short-circuit calls until timeout elapses
 * - `half-open` — allow a single trial call; success -> `closed`, failure -> `open`
 *
 * @class PowerCircuit
 * @param {Object} [options]
 * @param {number} [options.threshold=5] - Consecutive failure threshold to open the circuit.
 * @param {number} [options.timeout=30000] - Milliseconds to keep the circuit open before allowing a trial call.
 * @example
 * const cb = new PowerCircuit({ threshold: 3, timeout: 1000 });
 * await cb.call(() => fetch('/api'));
 */
/**
 * @typedef {Object} PowerCircuitOptions
 * @property {number} [threshold]
 * @property {number} [timeout]
 */
export class PowerCircuit {
    /**
     * Create a PowerCircuit.
     * @param {PowerCircuitOptions} [options]
     */
    constructor(options?: PowerCircuitOptions);
    _threshold: number;
    _timeout: number;
    _state: string;
    _failures: number;
    lastError: unknown;
    _openedAt: number | null;
    _trialInFlight: boolean;
    get state(): string;
    get failures(): number;
    call(fn: any): Promise<any>;
    reset(): void;
}
export default PowerCircuit;
export type PowerCircuitOptions = {
    threshold?: number | undefined;
    timeout?: number | undefined;
};
