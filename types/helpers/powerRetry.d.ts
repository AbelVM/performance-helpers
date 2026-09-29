/**
 * A token bucket that bounds how much retry traffic a dependency may receive.
 *
 * The rule is the one from the Google SRE Workbook's *Handling Overload*
 * chapter: the budget is refilled in proportion to the traffic you are
 * *already* sending, and each retry spends a token. During a partial outage
 * the bucket drains, so retries throttle exactly when the dependency can least
 * afford them.
 *
 * The bucket starts **full**. A token bucket that started empty would refuse
 * the first retry of a fresh budget, because one request funds 0.2 of a token
 * and a retry costs a whole one — so the protection would engage on a healthy
 * dependency and disengage on the sick one, which is backwards.
 *
 * @class PowerRetryBudget
 * @public
 * @example
 * const budget = new PowerRetryBudget({ ratio: 0.2 });
 * await PowerRetry.run(call, { budget, maxAttempts: 5 });
 */
export class PowerRetryBudget {
    /**
     * @param {PowerRetryBudgetOptions} [options] - `ratio` defaults to 0.2 (the
     *   top of the SRE-recommended 10-20 % band) and `capacity` to 10 retry
     *   tokens. See {@link PowerRetryBudgetOptions}.
     */
    constructor(options?: PowerRetryBudgetOptions);
    _ratio: number;
    _capacity: number;
    /** Full on construction — see the class note for why an empty bucket is wrong. */
    _tokens: number;
    _retries: number;
    _refused: number;
    _funded: number;
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
    /**
     * The ratio of requests to retries this budget permits, in `(0, 1]`.
     * @returns {number}
     */
    get ratio(): number;
    /**
     * The most retry tokens the bucket will hold.
     * @returns {number}
     */
    get capacity(): number;
    /**
     * Fund the budget by one request's worth of tokens.
     *
     * Called once per `PowerRetry.run()`, not per attempt: a retry is a request
     * the dependency did not ask for, so letting retries fund the bucket would
     * let a retry storm pay for itself.
     *
     * @returns {number} The token count after funding.
     */
    recordRequest(): number;
    /**
     * Try to spend one retry token.
     * @returns {boolean} `false` when the budget is exhausted and the retry must
     *   not be sent.
     */
    tryConsumeRetry(): boolean;
    /**
     * Current retry tokens available.
     * @returns {number}
     */
    available(): number;
    /**
     * Refill the bucket to capacity and zero the counters.
     * @returns {void}
     */
    reset(): void;
    /**
     * A snapshot of the budget, for logging and for deciding whether a refusal
     * was routine or a sign the dependency is genuinely sick.
     *
     * @returns {PowerRetryBudgetStats}
     */
    stats(): PowerRetryBudgetStats;
}
/**
 * PowerRetry
 *
 * @class PowerRetry
 * @public
 * @example
 * // The common case.
 * const data = await PowerRetry.run(() => fetch(url).then((r) => r.json()));
 *
 * // Tail-latency control with a shared budget.
 * const budget = new PowerRetryBudget({ ratio: 0.2 });
 * const data = await PowerRetry.run(() => fetch(url).then((r) => r.json()), {
 *   backoff: 'decorrelated',
 *   budget,
 *   hedgeDelay: 200,
 * });
 */
export class PowerRetry {
    /**
     * Run `fn`, retrying it according to `options`.
     *
     * @param {Function} fn - `(signal?: AbortSignal) => any`. It receives the
     *   attempt's `AbortSignal` when `attemptTimeout` or `hedgeDelay` is
     *   configured, and `undefined` otherwise. Honour the signal if you can: it
     *   is how a timed-out attempt and a losing hedge are stopped.
     * @param {PowerRetryOptions} [options]
     * @returns {Promise<any>} The resolved value of the first attempt to succeed.
     * @throws {any} The last error, once attempts are exhausted, the budget is
     *   spent, or `retryIf` declines.
     */
    static run(fn: Function, options?: PowerRetryOptions): Promise<any>;
    /**
     * @param {PowerRetryOptions} [options] - Defaults are listed on
     *   {@link PowerRetryOptions}. A `budget` given here is created once and
     *   shared by every {@link PowerRetry#run} on this instance.
     */
    constructor(options?: PowerRetryOptions);
    /** @type {PowerRetryOptions} */
    _options: PowerRetryOptions;
    /**
     * `null`, a shared bucket, or a bucket created from a ratio here. A bucket
     * built at construction time is the only form that can ration retries
     * *across* calls, because that is the traffic a budget is about.
     * @type {PowerRetryBudget|null}
     */
    _budget: PowerRetryBudget | null;
    /**
     * Run `fn` with the instance defaults, overridden per call.
     * @param {Function} fn - The operation to run.
     * @param {PowerRetryOptions} [options] - Per-call overrides.
     * @returns {Promise<any>} The resolved value of `fn`.
     */
    run(fn: Function, options?: PowerRetryOptions): Promise<any>;
}
export default PowerRetry;
export type PowerRetryOptions = import("./jsdoc-types.js").PowerRetryOptions;
export type RetryTimeoutError = import("./jsdoc-types.js").RetryTimeoutError;
export type PowerRetryBudgetOptions = import("./jsdoc-types.js").PowerRetryBudgetOptions;
export type PowerRetryBudgetStats = import("./jsdoc-types.js").PowerRetryBudgetStats;
