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
 * @param {string} [spec.invalidMessage] - Overrides the non-finite message.
 *   Exists for options whose pre-existing error text is part of the public
 *   contract, so migrating them onto this helper does not silently restyle a
 *   message users may be grepping for.
 * @param {string} [spec.minMessage] - Overrides the below-minimum message, for
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
export function assertLimit(value, spec) {
  const {
    name,
    className,
    min = 0,
    allowInfinity = false,
    fallback,
    invalidMessage,
    minMessage,
  } = spec;
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    return value;
  }
  const n = Number(value);
  if (n === Number.POSITIVE_INFINITY && allowInfinity) return n;
  if (!Number.isFinite(n)) {
    throw new TypeError(
      invalidMessage ??
        `${className}: \`${name}\` must be a finite number (received ${String(value)}). ` +
          'A non-finite limit would silently disable the check it guards.'
    );
  }
  if (n < min) {
    throw new TypeError(
      minMessage ?? `${className}: \`${name}\` must be >= ${min} (received ${n}).`
    );
  }
  return n;
}

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
 * @param {string} [spec.invalidMessage] - Overrides the non-finite message.
 * @param {string} [spec.minMessage] - Overrides the below-minimum message.
 * @returns {number}
 * @private
 */
export function assertLimitRequired(value, spec) {
  const n = assertLimit(value, spec);
  if (typeof n !== 'number') {
    throw new TypeError(
      `${spec.className}: \`${spec.name}\` must be a number or have a \`fallback\`, ` +
        `but resolved to ${String(n)}.`
    );
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
