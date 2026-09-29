/**
 * PowerRetry — retry flaky async work with backoff, jitter, a retry budget,
 * and optional hedged attempts.
 *
 * Three separate mechanisms live here, and they answer three different
 * questions:
 *
 * 1. **Backoff + jitter** — *how long to wait* between attempts. Naive
 *    `2^attempt * random()` still synchronises a fleet, because every client
 *    draws from the same range at the same moment. `backoff: 'decorrelated'`
 *    uses the AWS formulation, where each sleep is drawn against the *actual*
 *    previous sleep rather than a formula.
 * 2. **A retry budget** — *whether to retry at all*. Without one, retries
 *    multiply load on a dependency that is already failing, which is the
 *    mechanism behind most retry storms. A budget is a token bucket: every
 *    request funds it, every retry spends from it.
 * 3. **Hedged attempts** — *whether to attack the tail*. A hedge sends a
 *    second copy of the first request if the first has not returned in time.
 *    It raises average load and cuts p99, so it is opt-in.
 *
 * @module powerRetry
 * @public
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerRetryOptions} PowerRetryOptions
 * @typedef {import('./jsdoc-types.js').RetryTimeoutError} RetryTimeoutError
 * @typedef {import('./jsdoc-types.js').PowerRetryBudgetOptions} PowerRetryBudgetOptions
 * @typedef {import('./jsdoc-types.js').PowerRetryBudgetStats} PowerRetryBudgetStats
 */
import { assertLimitRequired } from '../utils/options.js';
import { attach } from './metrics.js';
import {
  DECORRELATED_JITTER_FACTOR,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_BUDGET_CAPACITY,
  DEFAULT_RETRY_BUDGET_RATIO,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from './constants.js';

/** The backoff strategies `PowerRetry` implements. */
const BACKOFF_STRATEGIES = Object.freeze(['exponential', 'linear', 'fixed', 'decorrelated']);

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
  constructor(options = {}) {
    const { ratio = DEFAULT_RETRY_BUDGET_RATIO, capacity = DEFAULT_RETRY_BUDGET_CAPACITY } =
      options || {};
    this._ratio = assertLimitRequired(ratio, {
      name: 'ratio',
      className: 'PowerRetryBudget',
      min: 0,
      fallback: DEFAULT_RETRY_BUDGET_RATIO,
    });
    // A ratio above 1 is not a budget: it would permit more retries than
    // requests, which is the amplification the bucket exists to prevent, and
    // it would read as a misconfiguration rather than a choice.
    if (this._ratio > 1) {
      throw new TypeError(
        `PowerRetryBudget: \`ratio\` must be <= 1 (received ${this._ratio}). ` +
          'A budget larger than 1 permits more retries than requests.'
      );
    }
    this._capacity = assertLimitRequired(capacity, {
      name: 'capacity',
      className: 'PowerRetryBudget',
      min: 1,
      fallback: DEFAULT_RETRY_BUDGET_CAPACITY,
    });
    /** Full on construction — see the class note for why an empty bucket is wrong. */
    this._tokens = this._capacity;
    this._retries = 0;
    this._refused = 0;
    this._funded = 0;
    // FEAT-007: opt-in metrics. The *budget* is observable, not the
    // `PowerRetry` around it: `PowerRetry` has no counters of its own,
    // so registering it would produce a series that always reads zero.
    this._metrics = attach(this, 'retryBudget', options);
  }

  /**
   * The ratio of requests to retries this budget permits, in `(0, 1]`.
   * @returns {number}
   */
  get ratio() {
    return this._ratio;
  }

  /**
   * The most retry tokens the bucket will hold.
   * @returns {number}
   */
  get capacity() {
    return this._capacity;
  }

  /**
   * Fund the budget by one request's worth of tokens.
   *
   * Called once per `PowerRetry.run()`, not per attempt: a retry is a request
   * the dependency did not ask for, so letting retries fund the bucket would
   * let a retry storm pay for itself.
   *
   * @returns {number} The token count after funding.
   */
  recordRequest() {
    this._funded += 1;
    this._tokens = Math.min(this._capacity, this._tokens + this._ratio);
    return this._tokens;
  }

  /**
   * Try to spend one retry token.
   * @returns {boolean} `false` when the budget is exhausted and the retry must
   *   not be sent.
   */
  tryConsumeRetry() {
    if (this._tokens < 1) {
      this._refused += 1;
      return false;
    }
    this._tokens -= 1;
    this._retries += 1;
    return true;
  }

  /**
   * Current retry tokens available.
   * @returns {number}
   */
  available() {
    return this._tokens;
  }

  /**
   * Refill the bucket to capacity and zero the counters.
   * @returns {void}
   */
  reset() {
    this._tokens = this._capacity;
    this._retries = 0;
    this._refused = 0;
    this._funded = 0;
  }

  /**
   * A snapshot of the budget, for logging and for deciding whether a refusal
   * was routine or a sign the dependency is genuinely sick.
   *
   * @returns {PowerRetryBudgetStats}
   */
  stats() {
    return {
      ratio: this._ratio,
      capacity: this._capacity,
      available: this._tokens,
      requests: this._funded,
      retries: this._retries,
      refused: this._refused,
    };
  }
}

/**
 * Validate a `backoff` value.
 *
 * The original implementation was `linear | fixed | else exponential`, so a
 * typo (`'exp'`, `'Expo'`) silently became exponential and produced a
 * backoff curve the caller never asked for. A closed set is checked instead,
 * for the same reason `maxAttempts` is validated: a wrong number is
 * invisible, a wrong *shape* is worse.
 *
 * @param {any} backoff
 * @returns {'exponential'|'linear'|'fixed'|'decorrelated'}
 * @private
 */
function validateBackoff(backoff) {
  if (typeof backoff !== 'string' || !BACKOFF_STRATEGIES.includes(backoff)) {
    throw new TypeError(
      `PowerRetry: \`backoff\` must be one of ${BACKOFF_STRATEGIES.join(', ')} ` +
        `(received ${String(backoff)}).`
    );
  }
  return /** @type {'exponential'|'linear'|'fixed'|'decorrelated'} */ (backoff);
}

/**
 * Resolve the `budget` option to a bucket, or `null` when there is none.
 *
 * Three spellings are accepted, and they are not equivalent:
 *
 *  - a `PowerRetryBudget` — shared, so it bounds retries *across* calls. This
 *    is the form that does the job the budget is for.
 *  - a plain `{ ratio, capacity }` object — a bucket built by this call and
 *    shared by everything the options reach. This is the ergonomic form, and
 *    matches how every other helper in the library takes options.
 *  - a number — read as `ratio`, same scoping as above.
 *
 * Scoping is the part worth being careful about. On the static
 * `PowerRetry.run` a bucket is built for that one call, so it caps that call's
 * retries at `capacity` and no more. That is coherent but weak; only a bucket
 * outliving the call can see the load it is meant to ration.
 *
 * @param {any} budget
 * @param {string} className - For the error message.
 * @returns {PowerRetryBudget|null}
 * @private
 */
function resolveBudget(budget, className) {
  if (budget == null) return null;
  if (budget instanceof PowerRetryBudget) return budget;
  if (typeof budget === 'number') return new PowerRetryBudget({ ratio: budget });
  if (typeof budget === 'object') {
    // A plain options object, not a bucket. Duck-typed on the constructor so a
    // bucket from a second copy of the package still counts as a bucket rather
    // than being silently rebuilt from an empty object.
    if (typeof budget.constructor?.tryConsumeRetry === 'function')
      return /** @type {PowerRetryBudget} */ (budget);
    return new PowerRetryBudget(budget);
  }
  throw new TypeError(
    `${className}: \`budget\` must be a PowerRetryBudget, a { ratio, capacity } ` +
      `object, or a ratio number (received ${typeof budget}).`
  );
}

/**
 * Validate and normalise the numeric/strategy options of one `run()` call.
 *
 * Split out of `run()` so the retry loop reads as a retry loop. The rule that
 * makes this worth a function rather than a comment: **every** option is
 * validated here, before the first request is sent. A configuration error
 * thrown from inside the loop would have already put a request on the wire.
 *
 * @param {any} options
 * @returns {{attempts:number, strategy:'exponential'|'linear'|'fixed'|'decorrelated', base:number, cap:number, timeoutMs:number, hedgeMs:number, jitter:boolean}}
 * @private
 */
function resolveRunOptions(options) {
  const {
    maxAttempts = 3,
    backoff = 'exponential',
    baseDelay = DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelay = DEFAULT_RETRY_MAX_DELAY_MS,
    jitter = true,
    attemptTimeout,
    hedgeDelay = 0,
  } = options || {};

  const attempts = assertLimitRequired(maxAttempts, {
    name: 'maxAttempts',
    className: 'PowerRetry',
    min: 1,
    fallback: 3,
    // The shared helper's messages name the class and the bound, but the
    // pre-2.0 wording is part of the public contract (two tests, and users
    // grepping for it), so it is preserved verbatim rather than restyled.
    // `assertLimitRequired` still does the checking - only the text is kept.
    invalidMessage: 'maxAttempts must be a positive finite number',
    minMessage: 'maxAttempts must be a positive finite number',
  });
  const strategy = validateBackoff(backoff);
  const base = assertLimitRequired(baseDelay, {
    name: 'baseDelay',
    className: 'PowerRetry',
    min: 0,
    fallback: DEFAULT_RETRY_BASE_DELAY_MS,
  });
  const cap = assertLimitRequired(maxDelay, {
    name: 'maxDelay',
    className: 'PowerRetry',
    min: 0,
    fallback: DEFAULT_RETRY_MAX_DELAY_MS,
  });
  const timeoutMs =
    attemptTimeout == null
      ? 0
      : assertLimitRequired(attemptTimeout, {
          name: 'attemptTimeout',
          className: 'PowerRetry',
          min: 1,
          fallback: 0,
        });
  const hedgeMs =
    hedgeDelay == null
      ? 0
      : assertLimitRequired(hedgeDelay, {
          name: 'hedgeDelay',
          className: 'PowerRetry',
          min: 0,
          fallback: 0,
        });

  // Decorrelated jitter has to remember its own previous draw, so the cursor
  // lives across the attempts of this call rather than being derived from the
  // attempt number. That is the entire difference between it and a formula.
  if (strategy === 'decorrelated' && !jitter) {
    throw new TypeError(
      'PowerRetry: `backoff: "decorrelated"` is defined as a randomised walk, ' +
        'so `jitter: false` contradicts it. Use `fixed` or `exponential` if ' +
        'you want a deterministic delay.'
    );
  }

  return { attempts, strategy, base, cap, timeoutMs, hedgeMs, jitter };
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
   * @param {PowerRetryOptions} [options] - Defaults are listed on
   *   {@link PowerRetryOptions}. A `budget` given here is created once and
   *   shared by every {@link PowerRetry#run} on this instance.
   */
  constructor(options = {}) {
    const { budget = null, ...rest } = options || {};
    /** @type {PowerRetryOptions} */
    this._options = rest;
    /**
     * `null`, a shared bucket, or a bucket created from a ratio here. A bucket
     * built at construction time is the only form that can ration retries
     * *across* calls, because that is the traffic a budget is about.
     * @type {PowerRetryBudget|null}
     */
    this._budget = resolveBudget(budget, 'PowerRetry');
    // FEAT-007: opt-in metrics. Off by default, so the common case pays
    // nothing and allocates no closure.
  }

  /**
   * Run `fn` with the instance defaults, overridden per call.
   * @param {Function} fn - The operation to run.
   * @param {PowerRetryOptions} [options] - Per-call overrides.
   * @returns {Promise<any>} The resolved value of `fn`.
   */
  run(fn, options = {}) {
    const merged = { ...this._options, ...options };
    // The instance budget is the default rather than something `_options`
    // carries, so it survives across calls instead of being rebuilt per call.
    if (merged.budget == null && this._budget) merged.budget = this._budget;
    return PowerRetry.run(fn, merged);
  }

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
  static async run(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const { retryIf = () => true, onRetry, budget = null } = options || {};
    const cfg = resolveRunOptions(options);

    const bucket = resolveBudget(budget, 'PowerRetry.run');
    if (bucket) bucket.recordRequest();

    const { attempts, strategy, base, cap, timeoutMs, hedgeMs, jitter } = cfg;
    let decorrelated = base;

    /**
     * @param {number} attempt
     * @returns {number} Milliseconds to wait before the next attempt.
     */
    const calcDelay = (attempt) => {
      if (strategy === 'decorrelated') {
        // AWS: `sleep = min(cap, random_between(base, previous * 3))`. The
        // `Math.max(base, ...)` is the one guard this needs: a `maxDelay` below
        // `baseDelay` clamps the cursor underneath `base`, and an upper bound
        // below the lower bound would return a negative delay.
        const upper = Math.max(base, decorrelated * DECORRELATED_JITTER_FACTOR);
        decorrelated = Math.min(cap, base + Math.random() * (upper - base));
        return Math.round(decorrelated);
      }
      let d;
      if (strategy === 'linear') d = base * attempt;
      else if (strategy === 'fixed') d = base;
      else d = base * Math.pow(2, attempt - 1);
      if (d > cap) d = cap;
      if (jitter) d = Math.round(d * (0.5 + Math.random() * 0.5));
      return d;
    };

    /**
     * Run one attempt, hedged when `hedgeDelay` applies to it.
     *
     * @param {number} attempt
     * @returns {Promise<any>}
     */
    const runAttempt = (attempt) => {
      const hedging = hedgeMs > 0 && attempt === 1;
      // A hedge needs a signal even without a timeout: cancelling the losing
      // copy is the only reason to have one. Without a timeout *and* without a
      // hedge there is nothing to cancel, so `fn` is handed `undefined` - the
      // 1.x contract, which a function branching on `if (signal)` depends on.
      const canSignal = typeof AbortController === 'function';
      /**
       * One controller per leg, never one shared between them. With a single
       * controller, aborting the loser also aborts the winner - so the hedge
       * that just returned the value would see its own signal fire.
       * @type {{promise: Promise<any>, controller: (AbortController|null)}[]}
       */
      const requestLegs = [];
      /**
       * @param {boolean} withSignal
       * @returns {Promise<any>}
       */
      const startLeg = (withSignal) => {
        const controller = withSignal && canSignal ? new AbortController() : null;
        const promise = (async () => fn(controller ? controller.signal : undefined))();
        requestLegs.push({ promise, controller });
        return promise;
      };

      /** @type {Promise<any>[]} */
      const legs = [startLeg(timeoutMs > 0 || hedging)];
      // Typed rather than left to inference: `setTimeout` resolves to a DOM
      // `number` in a browser type environment and a Node `Timeout` in Node, so
      // a bare `let x = null` has no type the assignment can be checked against
      // - the same narrowing hazard the `attemptTimeout` path documents.
      /** @type {?(ReturnType<typeof setTimeout>)} */
      let hedgeTimer = null;
      let hedgeLaunched = false;

      if (hedging) {
        // A hedge is a request the dependency did not ask for, so it draws on
        // the budget exactly as a retry does. A refused budget means *no
        // hedge* - not a failed attempt. The token is spent when the hedge is
        // armed rather than when it fires, because a hedge that fires only
        // when the budget happens to be full is not a budget.
        if (!bucket || bucket.tryConsumeRetry()) {
          const hedge = new Promise((resolve, reject) => {
            hedgeTimer = setTimeout(() => {
              hedgeTimer = null;
              hedgeLaunched = true;
              startLeg(true).then(resolve, reject);
            }, hedgeMs);
          });
          legs.push(hedge);
        }
      }

      /** @type {?(ReturnType<typeof setTimeout>)} */
      let timer = null;
      let timedOut = false;
      if (timeoutMs > 0) {
        legs.push(
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(
                Object.assign(new Error('Attempt timed out'), {
                  code: /** @type {const} */ ('ETIMEOUT'),
                  attempts: attempt,
                  attemptTimeout: timeoutMs,
                })
              );
            }, timeoutMs);
          })
        );
      }

      // Which leg settled the race. Recorded so the winner can be spared: the
      // point of a hedge is that the *loser* stops, and aborting the winner too
      // would signal cancellation to the call that is currently succeeding.
      let winnerIndex = -1;
      const tracked = legs.map((leg, i) =>
        leg.then(
          (value) => {
            if (winnerIndex === -1) winnerIndex = i;
            return value;
          },
          (err) => {
            if (winnerIndex === -1) winnerIndex = i;
            throw err;
          }
        )
      );

      return Promise.race(tracked).finally(() => {
        if (timer) clearTimeout(timer);
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
        }
        // Cancel whatever is still running, but only once there is something to
        // cancel. A solo successful attempt leaves its signal untouched so `fn`
        // can finish cleanly - the long-standing contract, and one a hedge must
        // not break for callers who never asked for hedging. A timeout, by
        // contrast, must always cancel, including the timed-out leg itself.
        const shouldCancel = timedOut || hedgeLaunched;
        if (!shouldCancel) return;
        for (let i = 0; i < requestLegs.length; i++) {
          if (!timedOut && i === winnerIndex) continue;
          const { controller } = requestLegs[i];
          if (!controller) continue;
          try {
            controller.abort();
          } catch (e) {
            /* an abort that throws must not mask the attempt's own result */
          }
        }
      });
    };

    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await runAttempt(attempt);
      } catch (err) {
        lastErr = err;
        // A timed-out attempt is a *failed attempt*, not a terminal error: the
        // documented contract is that it is "rejected and counted as a failed
        // attempt". Early-throwing on `ETIMEOUT` here would silently turn
        // `maxAttempts` into `1` for every caller who also set a timeout.
        const should = typeof retryIf === 'function' ? Boolean(retryIf(err)) : Boolean(retryIf);
        if (!should || attempt === attempts) break;
        // The budget is the last gate before more traffic is put on the wire.
        if (bucket && !bucket.tryConsumeRetry()) break;
        const delay = calcDelay(attempt);
        if (typeof onRetry === 'function') {
          try {
            onRetry(attempt, err, delay);
          } catch (e) {
            /* a throwing observer must not change the retry outcome */
          }
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }
}

export default PowerRetry;
