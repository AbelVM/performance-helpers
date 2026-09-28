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
    /**
     * @param {PowerCircuitOptions} [options] - `threshold` and `timeout` default
     *   to 5 and 30s; `onStateChange` and `eventBus` are optional sinks.
     */
    constructor(options?: PowerCircuitOptions);
    _threshold: number;
    _timeout: number;
    /** @type {CircuitState} */
    _state: CircuitState;
    _failures: number;
    /** @type {any} */
    lastError: any;
    /** @type {?number} */
    _openedAt: number | null;
    _trialInFlight: boolean;
    /** @type {?((state: CircuitState, reason?: string) => void)} */
    onStateChange: ((state: CircuitState, reason?: string) => void) | null;
    _bus: PowerEventBus | null;
    /**
     * Move to a new state, stamping `_openedAt`, notifying `onStateChange` and
     * emitting on the bus. A no-op when the state is unchanged.
     *
     * @param {CircuitState} newState
     * @param {string} [reason]
     * @returns {void}
     */
    _setState(newState: CircuitState, reason?: string): void;
    /** @returns {CircuitState} */
    get state(): CircuitState;
    get failures(): number;
    /**
     * Execute a function under circuit-breaker protection.
     *
     * If the circuit is `open`, this will throw an error with `code === 'ECIRCUITOPEN'`.
     * When in `half-open` state a single trial call is allowed.
     *
     * @param {() => Promise<any>|any} fn Async or sync function to execute.
     * @returns {Promise<any>} Resolves with the function's result.
     * @throws {Error} If the circuit is open or if `fn` throws/rejects.
     */
    call(fn: () => Promise<any> | any): Promise<any>;
    /**
     * Force the circuit back to the `closed` state and clear failures.
     * @returns {void}
     */
    reset(): void;
    /**
     * Release every resource this instance holds.
     *
     * Idempotent, and safe to call while the instance is idle. Exists so the
     * instance works with `using` / `await using` and gives callers an explicit
     * name to call.
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
export default PowerCircuit;
export type PowerCircuitOptions = import("./jsdoc-types.js").PowerCircuitOptions;
export type CircuitState = import("./jsdoc-types.js").CircuitState;
export type CircuitOpenError = import("./jsdoc-types.js").CircuitOpenError;
import { PowerEventBus } from './powerEventBus.js';
