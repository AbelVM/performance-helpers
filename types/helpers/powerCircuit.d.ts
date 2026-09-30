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
     *   to 5 and 30s; `onStateChange` and `eventBus` are optional sinks. `timeout`
     *   is the *base* open window: consecutive trips grow it exponentially up to
     *   `maxTimeout` and jitter the result.
     */
    constructor(options?: PowerCircuitOptions);
    _threshold: number;
    _timeout: number;
    _maxTimeout: number;
    /**
     * Consecutive entries into `open`, which drive the exponential growth.
     * Reset to 0 whenever the circuit proves the dependency is healthy again.
     * @type {number}
     */
    _consecutiveOpens: number;
    /**
     * The jittered window for the *current* `open` period, drawn once when the
     * circuit opened. It must be stored rather than re-drawn: the open check
     * runs on every `call()` and every `state` read, and a per-call draw would
     * make the window fluctuate, so the breaker would flap instead of holding.
     * @type {number}
     */
    _openWindowMs: number;
    /** @type {CircuitState} */
    _state: CircuitState;
    _failures: number;
    /** @type {any} */
    lastError: any;
    /** @type {?number} */
    _openedAt: number | null;
    _trialInFlight: boolean;
    _halfOpenAnnounced: boolean;
    /** @type {?((state: CircuitState, reason?: string) => void)} */
    onStateChange: ((state: CircuitState, reason?: string) => void) | null;
    _bus: PowerEventBus | null;
    /**
     * Draw the open window for a trip: exponential backoff on the base timeout,
     * capped, then equal jitter.
     *
     * The exponential part is what stops a genuinely-down dependency from being
     * probed at a fixed rate forever; the jitter is what stops a *fleet* of
     * clients from probing it in lockstep. With a fixed window, every circuit
     * guarding the same dependency opened on the same tick and retried on the
     * same tick, so the first post-timeout request arrived as an N-wide burst
     * that re-tripped the breaker before it had recovered — a self-inflicted
     * thundering herd, and the exact failure the breaker exists to prevent.
     *
     * @returns {number} The window in ms, always at least half the computed
     *   backoff. See `DEFAULT_CIRCUIT_MIN_JITTER_RATIO` for why this is not full
     *   jitter.
     */
    _drawOpenWindow(): number;
    /**
     * Move to a new state, stamping `_openedAt`, notifying `onStateChange` and
     * emitting on the bus. A no-op when the state is unchanged.
     *
     * @param {CircuitState} newState
     * @param {string} [reason]
     * @returns {void}
     */
    _setState(newState: CircuitState, reason?: string): void;
    /**
     * Announce a state to `onStateChange` and the bus, **without** mutating state.
     *
     * Split out of `_setState` so the lazy `open -> half-open` transition can be
     * announced from the `state` getter. That transition is computed, not applied:
     * `_state` stays `'open'` until a call is attempted, so a dashboard polling
     * `state` saw `half-open` while the only thing that emitted was `_setState` —
     * which means **half-open was never observable**, and a breaker whose trial then
     * succeeded went `open -> closed` for every observer with nothing in between.
     * The lazy design is the right one (an eager transition needs a timer, which is
     * a wakeup and a handle to leak); announcing it is what was missing.
     *
     * The bus emit is guarded where `_setState` did not guard it, because this now
     * runs **inside a getter**: a throwing event bus would otherwise make reading
     * `state` throw, which is a far worse failure than a missed notification.
     *
     * @param {CircuitState} newState
     * @param {string} [reason]
     * @returns {void}
     * @private
     */
    private _notifyState;
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
