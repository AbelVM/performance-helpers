export default WorkerAgnostic;
export function detectEnv(): 'browser' | 'webworker' | 'node' | 'unknown';
declare class WorkerAgnostic {
    constructor(workerSource: any, options?: {});
    env: string;
    options: any;
    worker: any;
    _listeners: Map<string, Set<Function>>;
    _nativeModel: 'listener' | 'emitter' | 'property';
    static create(workerSource: any, options?: {}): any;
    addEventListener(type: string, handler: Function): this;
    removeEventListener(type: string, handler: Function): this;
    on(type: string, handler: Function): this;
    off(type: string, handler: Function): this;
    postMessage(message: any, transfer?: any): any;
    terminate(): Promise<any>;
}
