/**
 * Read capability-based resource pressure without starting a sampler.
 * @param {{eventLoopPressure?:number}} [input]
 * @returns {number|null}
 */
export function getResourcePressure(input?: {
    eventLoopPressure?: number;
}): number | null;
/**
 * Caller-controlled brownout policy for optional work.
 *
 * @class PowerBrownout
 * @public
 */
export class PowerBrownout {
    /**
     * @param {{threshold?:number, disabledKinds?:string[]}} [options]
     */
    constructor(options?: {
        threshold?: number;
        disabledKinds?: string[];
    });
    threshold: number;
    /** Update pressure from a normalized local signal. */
    /** @param {number} pressure */
    setPressure(pressure: number): {
        pressure: number;
        threshold: number;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
    /** Return whether optional work of `kind` may run. */
    /** @param {string} kind */
    allows(kind: string): boolean;
    /** Add or remove a kind from the explicit brownout set. */
    /** @param {string} kind @param {boolean} [disabled=true] */
    disable(kind: string, disabled?: boolean): {
        pressure: number;
        threshold: number;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
    /** Explain the current brownout state. */
    stats(): {
        pressure: number;
        threshold: number;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
    getStats(): {
        pressure: number;
        threshold: number;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
}
