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
export function assertLimit(value, spec) {
  const {
    name,
    className,
    min = 0,
    integer = false,
    allowInfinity = false,
    fallback,
    invalidMessage,
    minMessage,
    integerMessage,
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
  if (integer && !Number.isInteger(n)) {
    throw new TypeError(
      integerMessage ??
        `${className}: \`${name}\` must be a whole number (received ${String(value)}). ` +
          'A fractional limit is silently rounded up by the first consumer, so it ' +
          'admits more than the number that was configured.'
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
 * @param {boolean} [spec.integer=false] - Require a whole number. See
 *   {@link assertLimit} for why this is a flag and not a blanket floor.
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
export function assertCount(value, { name, className, method }) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const where = method ? `${className}.${method}()` : className;
    throw new TypeError(
      `${where}: \`${name}\` must be a finite number (received ${String(value)}). ` +
        'A non-finite request count is not zero work - it is a request whose ' +
        'cost cannot be computed, and a limiter that cannot price a request ' +
        'must not admit it.'
    );
  }
  return Math.max(0, Math.floor(n));
}

/**
 * The message for a `ttl` that is not a duration.
 *
 * Lives here rather than in `powerCache.js` because **two** classes need it and
 * one of them could not reach the original: `PowerCache` fixed this (CACHE-003)
 * by extracting `_expiresAt`/`ttlTypeMessage` into its own module, where
 * `PowerTTLMap` has no access — `powerCache.js` exports nothing. So
 * `PowerTTLMap.set(k, 1, 'abc')` still stored `expiresAt === 0` while
 * `PowerCache.set(k, 1, { ttl: 'abc' })` throws, and an immortal entry is the
 * worst failure direction a TTL container has. Same lesson as
 * `assertLimitRequired` (QUAL-001): a validator that lives in a leaf module is
 * a validator the rest of the library cannot use.
 *
 * @param {*} ttl - The rejected value.
 * @param {string} className - For the message prefix.
 * @returns {string}
 * @private
 */
function ttlTypeMessage(ttl, className) {
  return (
    `${className}: \`ttl\` must be a finite number of milliseconds or Infinity ` +
    `(received ${JSON.stringify(ttl) ?? String(ttl)}). A value that is not a number ` +
    'concatenates rather than adds, and every expiry comparison against it is ' +
    'false — so the entry would never expire.'
  );
}

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
export function normalizeTtl(ttl, className) {
  if (ttl == null || ttl === Infinity) return 0;
  if (typeof ttl !== 'number' && typeof ttl !== 'string') {
    throw new TypeError(ttlTypeMessage(ttl, className));
  }
  const ms = Number(ttl);
  if (!Number.isFinite(ms)) {
    throw new TypeError(ttlTypeMessage(ttl, className));
  }
  return ms;
}

/**
 * Validate a hash seed: a whole number in the int32 range, or nothing at all.
 *
 * Lives here for the reason {@link normalizeTtl} does (BUG-024): the knowledge
 * about what a seed may be belongs to the thing that *consumes* it, and the
 * consumer here is `SmallLfuSketch`, which is a leaf module nothing else may
 * depend on. A validator next to the sketch would be one `PowerCache` could not
 * use, and the option would be unvalidated at the public surface — which is how
 * `ttl: '1e3'` reached the cache and produced an immortal entry (CACHE-003).
 *
 * The int32 bound is not pedantry, it is the contract the sketch already
 * implements: `smallLfu.js:138` ends with `| 0`, so `seed: 4294967296` and
 * `seed: 1.5` both arrive as `0`. Silently substituting a different seed is
 * precisely the failure this option exists to prevent — a caller who passed a
 * seed to make admission reproducible would get a reproducible *wrong* one,
 * with nothing to say so.
 *
 * `undefined` passes through and means "random", which is the sketch's own
 * documented default. `null` is treated the same way rather than rejected: the
 * constructor destructures before validating everywhere else in this library, so
 * `null` is what an explicitly-absent option collapses to.
 *
 * @param {*} seed
 * @param {string} className - For the message prefix.
 * @returns {number|undefined}
 * @private
 */
export function assertSeed(seed, className) {
  if (seed === undefined || seed === null) return undefined;
  const n = Number(seed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
    throw new TypeError(
      `${className}: \`seed\` must be a whole number in the int32 range ` +
        `(received ${String(seed)}). The sketch mixes the seed into each hash row ` +
        'and truncates it to 32 bits, so a fractional or out-of-range value would ' +
        'silently become a different seed than the one you asked for. Omit it ' +
        'entirely for a random seed.'
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

/**
 * Reject constructor options the class does not accept.
 *
 * ## Why this throws, when the previous behaviour was to ignore them
 *
 * Every helper in this library silently ignored unrecognised option keys. The
 * reasoning that got it there (9a1f9d5, which removed four inert options) was
 * sound for the population it considered: a caller already passing a *removed*
 * option could not have been depending on the behaviour, because there was none.
 *
 * That does not cover the far more common case — a **misspelled** option:
 *
 *     new PowerThrottle({ capacity: 10, refillRat: 5 })
 *
 * The bucket never refills, nothing is thrown or warned, and the limiter is
 * indistinguishable from a correct one until a request is refused in production.
 *
 * ## What ignoring unknown keys actually cost
 *
 * Turning this on for a commit found nine tests across six classes passing
 * options that do not exist. Every one **passed**, and every one was asserting
 * nothing. Three passed both the real option and a misspelling of it, such as
 * `new PowerThrottle({ capacity: 10, windowMs: 1000, capacity: 10 })`, where
 * `windowMs` is a `PowerSlidingWindow` option: read as intent that is ambiguous,
 * which is the real damage. The same defect had reached `guides/powerThrottle.md`
 * as a documented option. Both directions are now guarded.
 *
 * ## The suggestion
 *
 * "unknown option `refillRat`" is far less use than "did you mean
 * `refillRate`?". Levenshtein over a list this small needs no dependency. It is
 * deliberately not fuzzy — a wrong suggestion is worse than none — so the
 * threshold scales with the length of the word.
 *
 * @param {object} options - The options object exactly as supplied.
 * @param {readonly string[]} known - Every option name the class accepts.
 * @param {string} className - Used in the message.
 * @returns {void}
 * @throws {TypeError} Carrying `code: 'ERR_UNKNOWN_OPTION'` and `option: <key>`.
 */
export function assertKnownOptions(options, known, className) {
  if (!options || typeof options !== 'object') return;
  const allowed = new Set(known);
  for (const key of Object.keys(options)) {
    if (allowed.has(key)) continue;
    const parts = [`${className}: unknown option \`${key}\`.`];
    const near = suggestOption(key, known);
    if (near) parts.push(`Did you mean \`${near}\`?`);
    parts.push(`Accepted options: ${[...allowed].sort().join(', ')}.`);
    const err = new TypeError(parts.join(' '));
    /** @type {any} */ (err).code = 'ERR_UNKNOWN_OPTION';
    /** @type {any} */ (err).option = key;
    throw err;
  }
}

/**
 * The nearest known option name, when close enough to be worth naming.
 *
 * Threshold `max(2, floor(maxLen / 3))`: long names need a closer match before
 * the suggestion is believable, and short names are all within two edits anyway.
 *
 * @param {string} word
 * @param {readonly string[]} candidates
 * @returns {string|null} the option name, or `null` when nothing is close
 */
function suggestOption(word, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = levenshtein(word, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  if (best === null) return null;
  const limit = Math.max(2, Math.floor(Math.max(word.length, best.length) / 3));
  return bestDistance > 0 && bestDistance <= limit ? best : null;
}

/**
 * Levenshtein edit distance, two-row variant.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}
