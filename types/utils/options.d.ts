/**
 * Coerce to a finite number, or return `fallback` when not possible.
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 * @private
 */
export function num(value: any, fallback?: number): number;
/**
 * Coerce to an integer in `[min, Infinity)`. Non-finite input yields `min`.
 * Use {@link assertLimit} when a nonsensical limit should be an error rather
 * than a silent clamp.
 * @param {any} value
 * @param {number} [min=0]
 * @param {number} [fallback]
 * @returns {number}
 * @private
 */
export function intAtLeast(value: any, min?: number, fallback?: number): number;
/**
 * Validate a numeric limit option.
 *
 * Accepts `Infinity` when `allowInfinity` is set (a legitimate "no limit"
 * for things like `maxWeight`/`maxPoolSize`). Otherwise a `NaN`, non-finite or
 * negative value throws instead of degrading into a limit that silently does
 * nothing.
 *
 * @param {any} value - The option value.
 * @param {object} spec - Validation spec. The `spec.*` tags are what bind the
 *   property types; declaring it as a bare `{object}` with no property tags
 *   makes every field `any`.
 * @param {string} spec.name - Option name, used in the error message.
 * @param {string} spec.className - Constructing class name.
 * @param {number} [spec.min=0] - Smallest acceptable value.
 * @param {boolean} [spec.integer=false] - Require a whole number. A limit that
 *   counts things (permits, entries, waiters) must be one: `capacity: 2.5`
 *   granted **three** concurrent holders, because each `_grant()` decremented
 *   the fractional counter and three decrements of 1 still leave it above 0.
 *   The gate then reported `available: -0.5` and admitted a fourth caller
 *   against a limit of one. Off by default rather than applied everywhere,
 *   because some options are genuinely fractional - `PowerRetryBudget.ratio`
 *   among them - and a blanket `Math.floor` in this helper would quietly
 *   corrupt those.
 * @param {boolean} [spec.allowInfinity=false] - Accept `Infinity` as "no limit".
 * @param {number|null|undefined} [spec.fallback] - Value used when
 *   `undefined`/`null` is passed. When omitted the value passes through
 *   unchanged (BUG-024).
 * @param {string} [spec.invalidMessage] - Overrides the non-finite message.
 *   Exists for options whose pre-existing error text is part of the public
 *   contract, so migrating them onto this helper does not silently restyle a
 *   message users may be grepping for.
 * @param {string} [spec.minMessage] - Overrides the below-minimum message, for
 *   the same reason.
 * @param {string} [spec.integerMessage] - Overrides the non-integer message, for
 *   the same reason.
 * @returns {number|null|undefined} The validated number, `spec.fallback`, or the
 *   original value. Wide on purpose: the passthrough branch really can return
 *   `null`/`undefined`. Constructors should use {@link assertLimitRequired}.
 *
 * @remarks Two things this declaration has to carry, and one it must not.
 *
 *   It was `number|any`, which TypeScript collapses to `any` - so every field
 *   assigned from this helper emitted as `any` in the published `types/*.d.ts`
 *   (`capacity`, `tokens`, `refillRate`, `maxEntries`, `maxWeight`,
 *   `maxPoolSize`, `_maxSize`), *and* it silenced ~25 null-safety diagnostics
 *   across `powerBatch`/`powerCache`/`powerQueue`/`powerSlidingWindow`/
 *   `powerThrottle`, because `any` satisfies anything (QUAL-009).
 *
 *   It then became an unconditional `number`, which was a different lie: the
 *   passthrough branch returns the original value, so a call site that passes
 *   nullish without a `fallback` really does get nullish back.
 *
 *   The way out was a second entry point, not a lie. `assertLimit` keeps the
 *   passthrough and its wide type for the cases that genuinely need it;
 *   `assertLimitRequired` is the constructor-facing variant that resolves to
 *   `number`. Migrating the constructors moved 25 null-safety diagnostics
 *   (QUAL-009) without a cast, a duplicated default constant, or a lie in
 *   either signature.
 * @private
 */
export function assertLimit(value: any, spec: {
    name: string;
    className: string;
    min?: number | undefined;
    integer?: boolean | undefined;
    allowInfinity?: boolean | undefined;
    fallback?: number | null | undefined;
    invalidMessage?: string | undefined;
    minMessage?: string | undefined;
    integerMessage?: string | undefined;
}): number | null | undefined;
/**
 * Validate a numeric limit that must resolve to a `number`.
 *
 * Every constructor in this library destructures a default out of `options`
 * before validating, so a nullish value with no `fallback` is unreachable in
 * practice - but "unreachable in practice" is exactly the kind of claim that
 * rots, and when it did rot the failure was invisible: `assertLimit` returned
 * `undefined`, the field was assigned `undefined`, and the limit it guards
 * silently stopped guarding anything.
 *
 * This is the variant constructors should use. It is `assertLimit` plus an
 * assertion that the result really is a number, so the declared return type is
 * true rather than merely plausible.
 *
 * @param {any} value - The option value.
 * @param {object} spec - Validation spec, exactly as for {@link assertLimit}.
 * @param {string} spec.name - Option name, used in the error message.
 * @param {string} spec.className - Constructing class name.
 * @param {number} [spec.min=0] - Smallest acceptable value.
 * @param {boolean} [spec.integer=false] - Require a whole number. See
 *   {@link assertLimit} for why this is a flag and not a blanket floor.
 * @param {boolean} [spec.allowInfinity=false] - Accept `Infinity` as "no limit".
 * @param {number} [spec.fallback] - Value used when `undefined`/`null` is passed.
 * @param {string} [spec.invalidMessage] - Overrides the non-finite message.
 * @param {string} [spec.minMessage] - Overrides the below-minimum message.
 * @returns {number}
 * @private
 */
export function assertLimitRequired(value: any, spec: {
    name: string;
    className: string;
    min?: number | undefined;
    integer?: boolean | undefined;
    allowInfinity?: boolean | undefined;
    fallback?: number | undefined;
    invalidMessage?: string | undefined;
    minMessage?: string | undefined;
}): number;
/**
 * Validate a **request count** - how many operations a caller is asking a
 * limiter to admit - and coerce it to a non-negative integer.
 *
 * This is deliberately *not* {@link assertLimit}, and the distinction is the
 * whole point of this function. A **limit** is a configuration value the
 * library enforces on its own, so `NaN` means "the guard silently stopped
 * guarding" and must throw. A **request count** is caller-supplied input to a
 * single call, and every limiter in this library coerced it with
 * `Math.max(0, Math.floor(+n) || 0)` - which turns `NaN` into `0`, and `0` is
 * the *admit* case: `tryConsume(NaN)` returned `true` having consumed
 * nothing. So the arithmetic that "safely" degraded a nonsense count into an
 * unlimited-by-default free pass, and `throttle.tokens` never moved.
 *
 * The line this draws, and the reason the coercion is kept at all:
 *
 * - **non-finite throws** - `NaN`, `±Infinity`, and anything `Number()` cannot
 *   read (`'many'`, `Symbol`, `undefined` where no default applies). There is
 *   no sensible reading of "how many?" for those, and the old behaviour
 *   answered "zero", which is the one answer a rate limiter must never give.
 *   Note the error surfaces from `Number(value)` itself for a `Symbol` or an
 *   object whose `valueOf` throws, so the message is the native `TypeError`
 *   rather than this one - still a throw, which is the contract.
 * - **a fractional count floors** - `tryConsume(2.9)` costs 2 operations.
 *   Unlike `assertLimit`'s `integer` flag this is not a hazard: a count is
 *   consumed as a whole number either way, so rounding down cannot over-issue
 *   the way `capacity: 2.5` over-issued permits (RES-010).
 * - **a negative count is a no-op, not an error** - `0` means "consume
 *   nothing", and refusing to admit nothing would be a behaviour change with
 *   no defect behind it. A `TypeError` here would be *more* correct in the
 *   abstract and worse in practice, so the documented no-op stands.
 *
 * @param {any} value - The count as supplied by the caller.
 * @param {object} spec - Validation spec.
 * @param {string} spec.name - Parameter name, used in the error message.
 * @param {string} spec.className - Owning class name.
 * @param {string} [spec.method] - Calling method, included in the message so
 *   a failure deep inside a composition says which leg refused.
 * @returns {number} A non-negative integer.
 * @private
 */
export function assertCount(value: any, { name, className, method }: {
    name: string;
    className: string;
    method?: string | undefined;
}): number;
/**
 * Normalise a TTL to a duration in milliseconds, rejecting anything that would
 * make an entry immortal by accident.
 *
 * Accepts a number or a numeric string — `'1000'` from an environment variable
 * is a reasonable thing to pass, and rejecting it would be pedantry. Rejects
 * everything else, including the two coercions that make this a *type* check
 * rather than a value check: `Number([]) === 0` would turn `{ ttl: [] }` into
 * "expire now", and `Number(true) === 1` would turn `{ ttl: true }` into one
 * millisecond.
 *
 * `null`, `undefined` and `Infinity` all mean **no expiry**, and are returned as
 * `0`. That is the caller's stored sentinel, and the distinction between "no
 * expiry" and "expire now" is `0` itself — a real TTL of `0` means *expire now*
 * and is returned unchanged.
 *
 * @param {*} ttl
 * @param {string} className - For the error message.
 * @returns {number} Milliseconds; `0` for "no expiry".
 * @private
 */
export function normalizeTtl(ttl: any, className: string): number;
/**
 * Validate an option that must be a function (or explicitly null/undefined).
 * @param {any} value
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.className
 * @param {boolean} [spec.optional=true]
 * @returns {Function|null|undefined}
 * @private
 */
export function assertFunction(value: any, { name, className, optional }: {
    name: string;
    className: string;
    optional?: boolean | undefined;
}): Function | null | undefined;
