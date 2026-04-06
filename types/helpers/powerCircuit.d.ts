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
    call(fn: any): Promise<any>;
    reset(): void;
}
export default PowerCircuit;
export type PowerCircuitOptions = {
    threshold?: number | undefined;
    timeout?: number | undefined;
    onStateChange?: ((state: string, reason?: string) => void) | undefined;
    eventBus?: PowerEventBus | undefined;
};
import { PowerEventBus } from './powerEventBus.js';
