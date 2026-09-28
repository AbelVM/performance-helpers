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
 *   original value.
 *
 * @remarks This was declared `number|any`, which TypeScript collapses to `any`.
 *   That was not cosmetic: it made every field assigned from this helper emit as
 *   `any` in the published `types/*.d.ts` (`capacity`, `tokens`, `refillRate`,
 *   `maxEntries`, `maxWeight`, `maxPoolSize`, `_maxSize`), *and* it silenced
 *   ~25 null-safety diagnostics across `powerBatch`/`powerCache`/`powerQueue`/
 *   `powerSlidingWindow`/`powerThrottle`, because `any` satisfies anything. Those
 *   diagnostics are real - see QUAL-008 - and the honest return type is what
 *   makes them countable.
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
