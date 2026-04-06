/**
 * Measure a synchronous function's execution duration.
 * @param {Function|any} fn A function to call or a value to return.
 * @returns {{result:any,ms:number,start:number,end:number}}
 */
export function measureSync(fn: Function | any): {
    result: any;
    ms: number;
    start: number;
    end: number;
};
/**
 * Measure an async function or promise's execution duration.
 * @param {Function|Promise|any} fn Async function to call or a promise/value to await.
 * @returns {Promise<{result:any,ms:number,start:number,end:number}>}
 */
export function measureAsync(fn: Function | Promise<any> | any): Promise<{
    result: any;
    ms: number;
    start: number;
    end: number;
}>;
export function nowMs(): number;
export default nowMs;
