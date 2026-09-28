/**
 * Resolve the clock a limiter should read for one call.
 *
 * PERF-007 asked for a single `now` threaded through an N-limiter composition.
 * That is worth doing, and the reason is arithmetic rather than aesthetic:
 * `nowMs()` reads **two** clocks per call (the high-resolution one and
 * `Date.now()`, the second purely to check they have not diverged under a test
 * harness), and measures ~141 ns. A composition of three limiters therefore
 * spent ~282 ns of a ~300 ns call deciding what time it was.
 *
 * The precedence rule is the part worth stating, because the obvious version is
 * wrong. An **explicitly injected clock always wins**, even when a caller
 * supplies a per-call `now`. If a limiter was built with a fake clock and the
 * composer overrode it with its own reading, the limiter's notion of time would
 * silently change mid-run - and a limiter that faked its clock is a limiter
 * under test, which is exactly when a silent override does the most damage and
 * is hardest to notice.
 *
 * So: injected clock first, then the per-call value, then `nowMs()`. A limiter
 * the library did not construct, or one that ignores the second argument, simply
 * reads its own clock - which is why threading is safe for third-party limiters
 * and needs no capability check.
 *
 * @param {(() => number)} injected - The limiter's own configured clock, or
 *   `nowMs` when none was given.
 * @param {boolean} injectedExplicitly - Whether the clock came from the
 *   constructor rather than being the default.
 * @param {LimiterNowOptions} [options] - Per-call options, possibly carrying
 *   `now`.
 * @returns {number}
 * @private
 */
export function resolveLimiterNow(injected: (() => number), injectedExplicitly: boolean, options?: LimiterNowOptions): number;
/**
 * Attach the clock fields a limiter needs, so every limiter records the same
 * pair and cannot drift into a different precedence rule.
 *
 * @param {any} target - The limiter instance.
 * @param {function():number} defaultNow - The module's clock, passed in rather
 *   than imported so this file stays free of a circular reference.
 * @param {any} options - The limiter's constructor options.
 * @param {string} className - For the error message.
 * @returns {void}
 * @private
 */
export function attachLimiterClock(target: any, defaultNow: () => number, options: any, className: string): void;
/**
 * Resolve the clock a **composer** should read for one composed call.
 *
 * Deliberately simpler than {@link resolveLimiterNow}. A composition is not a
 * limiter: it has no bucket to refill and no window to prune, so the question
 * "did the caller bring a clock or do I read one" has no ambiguity to resolve,
 * and an injected-clock precedence rule would only add a way to be wrong.
 *
 * The composer also takes **no constructor `now`**. On the limiters `now` is a
 * function; threading makes it a number in the per-call options. Having one
 * name mean a function in one place and a number in another, on the same class,
 * is a trap - and the per-call value already covers every use the constructor
 * injection did, because the composer reads the clock once and tells everyone.
 *
 * @param {{now?: number}} [options] - Per-call options.
 * @returns {number}
 * @private
 */
export function resolveComposerNow(options?: {
    now?: number;
}): number;
export type LimiterNowOptions = import("../helpers/jsdoc-types.js").LimiterNowOptions;
