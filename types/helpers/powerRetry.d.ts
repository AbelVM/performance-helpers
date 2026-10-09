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
    /** Full on construction — see the class note for why an empty bucket is wrong. */
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
     * Record an external outcome so upstream throttling can tighten this budget.
     * `penalty` is measured in retry tokens and defaults by outcome kind.
     * @param {{kind?:string, penalty?:number}} [outcome]
     * @returns {number} Tokens remaining after the adjustment.
     */
    recordOutcome(outcome?: {
        kind?: string;
        penalty?: number;
    }): number;
    /**
     * Run one operation against this shared request budget.
     * @param {Function} fn
     * @param {PowerRetryOptions} [options]
     * @returns {Promise<any>}
     */
    execute(fn: Function, options?: PowerRetryOptions): Promise<any>;
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
     * Release the metrics registration. Safe to call more than once.
     *
     * `reset()` deliberately does not do this — a budget can be reset and reused,
     * and unregistering on every reset would make the series flap. `dispose()` is
     * the terminal teardown, and it is new here for the reason
     * `guides/metrics.md` gives: a disposed budget that stays registered is sampled
     * forever, and its `stats()` still answers, so nothing fails visibly.
     *
     * @returns {void}
     */
    dispose(): void;
    /**
     * A snapshot of the budget, for logging and for deciding whether a refusal
     * was routine or a sign the dependency is genuinely sick.
     *
     * @returns {PowerRetryBudgetStats}
     */
    stats(): PowerRetryBudgetStats;
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): import("./jsdoc-types.js").PowerRetryBudgetStats;
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.
     * @returns {Promise<void>}
     */
    [Symbol.asyncDispose](): Promise<void>;
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
    /**
     * A constructor-supplied `signal`, used only while it is not aborted. An
     * aborted signal stays aborted, so once the caller cancels, later runs on
     * this instance reject without doing work — which is the safe direction: a
     * cancelled instance is not a usable one, and silently retrying would be the
     * opposite of what cancelling means.
     * @type {AbortSignal|null}
     */
    /**
     * `null`, a shared bucket, or a bucket created from a ratio here. A bucket
     * built at construction time is the only form that can ration retries
     * *across* calls, because that is the traffic a budget is about.
     * @type {PowerRetryBudget|null}
     */
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
