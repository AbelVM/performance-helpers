/**
 * @typedef {import('./jsdoc-types.js').PowerAdaptiveProposalOptions} PowerAdaptiveProposalOptions
 * @typedef {import('./jsdoc-types.js').PowerAdaptiveProposalResult} PowerAdaptiveProposalResult
 */
/**
 * A bounded controller for opt-in adaptive settings.
 *
 * `signal > 0` requests a decrease, `signal < 0` requests an increase, and
 * values near zero are held by hysteresis. The caller supplies the signal so
 * this primitive stays independent of transport, queue, and latency policy.
 *
 * @class PowerAdaptiveProposal
 * @public
 */
export class PowerAdaptiveProposal {
    /**
     * @param {PowerAdaptiveProposalOptions} [options]
     */
    constructor(options?: PowerAdaptiveProposalOptions);
    /** Current proposed value. */
    get value(): number;
    /** Return the bounded controller state for persistence across restarts. */
    snapshot(): {
        version: number;
        value: number;
        remaining: number;
        reason: string;
    };
    /** Restore a previously captured state without bypassing the controller bounds. */
    restore(snapshot: any): {
        version: number;
        value: number;
        remaining: number;
        reason: string;
    };
    /**
     * Propose a bounded adjustment.
     * @param {number} signal Positive means congestion; negative means recovery.
     * @returns {PowerAdaptiveProposalResult}
     */
    propose(signal: number): PowerAdaptiveProposalResult;
    /** Roll back one proposal to a prior value. */
    rollback(value?: number): {
        value: number;
        changed: any;
        signal: any;
        reason: string;
        confidence: number;
        cooldownRemaining: number;
    };
    /** Stability counters for tuning the controller against real workloads. */
    stats(): {
        value: number;
        min: number;
        max: number;
        adjustments: number;
        reversals: number;
        peakSignal: number;
        atMin: boolean;
        atMax: boolean;
        reason: string;
    };
    /** Alias for {@link stats}. */
    getStats(): {
        value: number;
        min: number;
        max: number;
        adjustments: number;
        reversals: number;
        peakSignal: number;
        atMin: boolean;
        atMax: boolean;
        reason: string;
    };
    _result(changed: any, signal: any): {
        value: number;
        changed: any;
        signal: any;
        reason: string;
        confidence: number;
        cooldownRemaining: number;
    };
}
export type PowerAdaptiveProposalOptions = import("./jsdoc-types.js").PowerAdaptiveProposalOptions;
export type PowerAdaptiveProposalResult = import("./jsdoc-types.js").PowerAdaptiveProposalResult;
