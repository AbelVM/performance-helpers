/**
 * @typedef {object} PowerGCRAOptions
 * @property {number} rate - Sustained rate in operations per `per` unit. Must be > 0.
 * @property {number} [per=1000] - The unit `rate` is measured against, in milliseconds.
 * @property {number} [burst=0] - Extra tolerance above the steady-state rate, in
 *   operations. `0` allows exactly the steady-state spacing; larger values admit
 *   a short spike of that many extra operations.
 * @property {function(number):void} [onError] - Called when the internal clock
 *   misbehaves (time moving backwards), instead of throwing.
 */
/**
 * A GCRA rate limiter.
 *
 * @example
 * const limiter = new PowerGCRA({ rate: 100, per: 1000, burst: 10 });
 * if (limiter.tryConsume()) doWork();
 * else setTimeout(doWork, limiter.retryAfter());
 */
export class PowerGCRA {
    [x: number]: () => void;
    /**
     * @param {PowerGCRAOptions} options
     */
    constructor(options?: PowerGCRAOptions);
    rate: number;
    per: number;
    burst: number;
    _onError: ((arg0: number) => void) | null;
    _emission: number;
    _delayTolerance: number;
    _tat: number;
    /**
     * Try to consume one operation.
     * @param {number} [n=1] - Number of operations to consume.
     * @returns {boolean} `true` when the request fits inside the current budget.
     */
    tryConsume(n?: number): boolean;
    /**
     * Exact milliseconds until `tryConsume()` would succeed.
     *
     * @param {number} [n=1] - Number of operations the next call would consume.
     * @returns {number} Milliseconds to wait; `0` when the call would succeed now.
     */
    retryAfter(n?: number): number;
    /**
     * Consume, or return the exact wait needed.
     * @param {number} [n=1]
     * @returns {{ok: true} | {ok: false, retryAfter: number}}
     */
    take(n?: number): {
        ok: true;
    } | {
        ok: false;
        retryAfter: number;
    };
    /**
     * How many operations can be consumed at this instant, given the burst
     * ceiling.
     *
     * A batch is admitted behind a single check, so the count at an idle instant
     * is `burst + 1`, not `burst`: with no history every call up to and including
     * the `burst`-th extra one still finds `tat <= now + delayTolerance`. This
     * also has to be right for composition - `PowerRateLimit` pre-checks
     * `available()` and refuses immediately when it is below the ask, so
     * reporting `0` on a fresh limiter would make GCRA refuse everything.
     *
     * @returns {number} A non-negative whole number.
     */
    available(): number;
    /**
     * Whether the limiter would accept a single operation right now, without
     * consuming it. Same shape as `PowerThrottle.available()` for composition.
     * @returns {boolean}
     */
    get hasCapacity(): boolean;
    /**
     * Clear the accumulated state, as if the limiter were brand new.
     * @returns {void}
     */
    reset(): void;
    /**
     * Serializable snapshot of the limiter's configuration and state.
     * @returns {{rate:number, per:number, burst:number, emissionInterval:number, delayTolerance:number, tat:number}}
     */
    stats(): {
        rate: number;
        per: number;
        burst: number;
        emissionInterval: number;
        delayTolerance: number;
        tat: number;
    };
    /** @returns {void} */
    dispose(): void;
}
export default PowerGCRA;
export type PowerGCRAOptions = {
    /**
     * - Sustained rate in operations per `per` unit. Must be > 0.
     */
    rate: number;
    /**
     * - The unit `rate` is measured against, in milliseconds.
     */
    per?: number | undefined;
    /**
     * - Extra tolerance above the steady-state rate, in
     * operations. `0` allows exactly the steady-state spacing; larger values admit
     * a short spike of that many extra operations.
     */
    burst?: number | undefined;
    /**
     * - Called when the internal clock
     * misbehaves (time moving backwards), instead of throwing.
     */
    onError?: ((arg0: number) => void) | undefined;
};
