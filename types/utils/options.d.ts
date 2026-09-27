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
 * @param {object} spec - Validation spec.
 * @param {string} spec.name - Option name, used in the error message.
 * @param {string} spec.className - Constructing class name.
 * @param {number} [spec.min=0] - Smallest acceptable value.
 * @param {boolean} [spec.allowInfinity=false] - Accept `Infinity` as "no limit".
 * @param {any} [spec.fallback] - Value used when `undefined`/`null` is passed.
 *   When omitted, `undefined` is passed through unchanged.
 * @returns {number|any}
 * @private
 */
export function assertLimit(value: any, { name, className, min, allowInfinity, fallback }: {
    name: string;
    className: string;
    min?: number | undefined;
    allowInfinity?: boolean | undefined;
    fallback?: any;
}): number | any;
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
