// Shared option validation / coercion helpers.
//
// Every helper in this library used to hand-roll the same
// `Math.max(0, Math.floor(Number(x) || 0))` idiom, which silently coerced
// nonsense into a plausible-looking number. The worst case: a
// `maxEntries: NaN` made `size > NaN` always false, so eviction never ran and
// the cache grew without bound with no diagnostic at all.
//
// These helpers make the policy explicit and consistent: a *value* is coerced,
// an invalid *limit* throws with a message naming the option and the class.

/**
 * Coerce to a finite number, or return `fallback` when not possible.
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 * @private
 */
export function num(value, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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
export function intAtLeast(value, min = 0, fallback = min) {
  const n = num(value, NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

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
export function assertLimit(value, spec) {
  const { name, className, min = 0, allowInfinity = false, fallback } = spec;
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    return value;
  }
  const n = Number(value);
  if (n === Number.POSITIVE_INFINITY && allowInfinity) return n;
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `${className}: \`${name}\` must be a finite number (received ${String(value)}). ` +
        'A non-finite limit would silently disable the check it guards.'
    );
  }
  if (n < min) {
    throw new TypeError(`${className}: \`${name}\` must be >= ${min} (received ${n}).`);
  }
  return n;
}

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
export function assertFunction(value, { name, className, optional = true }) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new TypeError(`${className}: \`${name}\` is required.`);
  }
  if (typeof value !== 'function') {
    throw new TypeError(`${className}: \`${name}\` must be a function.`);
  }
  return value;
}
