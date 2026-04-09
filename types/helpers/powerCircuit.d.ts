/**
 * PowerCircuit
 *
 * Circuit-breaker primitive that short-circuits calls after repeated failures.
 * Use for isolating flaky downstream dependencies and to avoid cascading failures.
 *
 * @class PowerCircuit
 * @public
 */
export class PowerCircuit {
    constructor(options?: {});
    _threshold: number;
    _timeout: number;
    _state: string;
    _failures: number;
    lastError: unknown;
    _openedAt: number | null;
    _trialInFlight: boolean;
    onStateChange: any;
    _bus: PowerEventBus | null;
    _setState(newState: any, reason: any): void;
    get state(): string;
    get failures(): number;
    /**
     * Execute a function under circuit-breaker protection.
     *
     * If the circuit is `open`, this will throw an error with `code === 'ECIRCUITOPEN'`.
     * When in `half-open` state a single trial call is allowed.
     *
     * @param {Function} fn Async function to execute.
     * @returns {Promise<any>} Resolves with the function's result.
     * @throws {Error} If the circuit is open or if `fn` throws/rejects.
     */
    call(fn: Function): Promise<any>;
    /**
     * Force the circuit back to the `closed` state and clear failures.
     * @returns {void}
     */
    reset(): void;
}
export default PowerCircuit;
export type PowerCircuitOptions = import("./jsdoc-types.js").PowerCircuitOptions;
import { PowerEventBus } from './powerEventBus.js';
