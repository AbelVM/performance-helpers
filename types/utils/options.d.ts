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
 * @param {boolean} [spec.allowInfinity=false] - Accept `Infinity` as "no limit".
 * @param {number|null|undefined} [spec.fallback] - Value used when
 *   `undefined`/`null` is passed. When omitted the value passes through
 *   unchanged (BUG-024).
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
    allowInfinity?: boolean | undefined;
    fallback?: number | null | undefined;
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
 * @param {boolean} [spec.allowInfinity=false] - Accept `Infinity` as "no limit".
 * @param {number} [spec.fallback] - Value used when `undefined`/`null` is passed.
 * @returns {number}
 * @private
 */
export function assertLimitRequired(value: any, spec: {
    name: string;
    className: string;
    min?: number | undefined;
    allowInfinity?: boolean | undefined;
    fallback?: number | undefined;
}): number;
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
