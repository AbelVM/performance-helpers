/**
 * Read capability-based resource pressure without starting a sampler.
 * @param {{eventLoopPressure?:number}} [input]
 * @returns {number|null}
 */
export function getResourcePressure(input?: {
    eventLoopPressure?: number;
}): number | null;
export class PowerBrownout {
    /**
     * @param {{threshold?:number, disabledKinds?:string[], adaptive?:boolean|{alpha?:number, margin?:number, min?:number, max?:number}}} [options]
     */
    constructor(options?: {
        threshold?: number;
        disabledKinds?: string[];
        adaptive?: boolean | {
            alpha?: number;
            margin?: number;
            min?: number;
            max?: number;
        };
    });
    /** @type {{enabled:boolean, alpha:number, margin:number, min:number, max:number, additiveIncrease:number, beta:number}} */
    threshold: number;
    /** Update pressure from a normalized local signal. */
    /** @param {number} pressure */
    setPressure(pressure: number): {
        pressure: number;
        threshold: number;
        baseThreshold: number;
        adaptive: boolean;
        pressureEwma: any;
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
        baseThreshold: number;
        adaptive: boolean;
        pressureEwma: any;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
    /** Explain the current brownout state. */
    stats(): {
        pressure: number;
        threshold: number;
        baseThreshold: number;
        adaptive: boolean;
        pressureEwma: any;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
    getStats(): {
        pressure: number;
        threshold: number;
        baseThreshold: number;
        adaptive: boolean;
        pressureEwma: any;
        active: boolean;
        disabledKinds: string[];
        decisions: number;
        shed: number;
    };
}
