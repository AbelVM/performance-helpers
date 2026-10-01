/**
 * PowerRateLimit — compose multiple limiters (tryConsume succeeds only when all
 * underlying limiters allow consumption).
 *
 * Example:
 * const limit = new PowerRateLimit([
 *   new PowerThrottle({ capacity: 100, refillRate: 10 }),
 *   new PowerSlidingWindow({ capacity: 1000, windowMs: 60000 }),
 * ]);
 * if (limit.tryConsume()) {
 *   // perform work
 * }
 *
 * The composed limiter supports both `tryConsume(n)` and `reserve(n)`/
 * `release(tokenOrN)` workflows when underlying limiters expose those
 * methods. When `atomic: true` is configured, it will attempt to preserve
 * all-or-nothing semantics across the set of limiters.
 */

import { resolveComposerNow } from '../utils/limiterClock.js';
import { assertCount, assertKnownOptions } from '../utils/options.js';

/** @typedef {import('../utils/limiterClock.js').LimiterNowOptions} LimiterNowOptions */

/**
 * Declared at module level, not inside the class, for two reasons.
 *
 * A `@typedef` block sitting between the class opening and the constructor's
 * `@param` block is not attached to anything, and TypeScript then inlines the
 * type structurally into the declaration - which for {@link RateLimiterLike} is
 * a dozen members with comment bodies, emitted twice. And a typedef that is
 * *local* is inlined even when it is attached, because the emitter cannot name
 * a type it does not export.
 *
 * @typedef {import('./jsdoc-types.js').PowerRateLimitOptions} PowerRateLimitOptions
 * @typedef {import('./jsdoc-types.js').PowerRateLimitCallOptions} PowerRateLimitCallOptions
 * @typedef {import('./jsdoc-types.js').RateLimiterLike} RateLimiterLike
 */

/**
 * PowerRateLimit
 *
 * Compose multiple rate limiters and provide a unified `tryConsume`/`reserve` API.
 * Returns success only when all underlying limiters allow consumption.
 *
 * @class PowerRateLimit
 * @public
 */
export class PowerRateLimit {
  /**
   * @param {RateLimiterLike[]} limiters - Limiter instances to compose. Each
   *   must provide `tryConsume(n)`; `reserve`, `release`, `addTokens`,
   *   `rollback` and `available` are used when present.
   * @param {PowerRateLimitOptions} [options] - `atomic` attempts all-or-nothing
   *   semantics: either every limiter allows the consumption or none is left
   *   mutated. That requires each to expose `available()` or an undo primitive
   *   (`reserve`/`release`, or `addTokens`). When a safe rollback cannot be
   *   guaranteed the call returns `false`.
   */
  constructor(limiters = [], options = {}) {
    assertKnownOptions(options, ['atomic', 'keyFn', 'buckets'], 'PowerRateLimit');
    if (!Array.isArray(limiters)) throw new TypeError('limiters must be an array');
    // `Array<Object>` was the declared type, and the body then calls
    // `tryConsume`, `reserve` and reads `available` on each element - none of
    // which exist on `Object`. Typed as the interface the body actually
    // uses, so a limiter missing one of them is caught where it is stored
    // rather than at every call site.
    /** @type {RateLimiterLike[]} */
    this.limiters = limiters.slice();
    this.atomicDefault = Boolean(options.atomic);

    // ── Per-key limiting (Bottleneck `Group`-shaped) ────────────────────────
    //
    // A `keyFn` turns this composition into one limiter *set* per key, and the
    // design question was how to keep the set of sets bounded. Both obvious
    // answers are wrong, in opposite directions, and both were measured before
    // this was written:
    //
    // - **An unbounded `Map`** of per-key limiters grows with client-controlled
    //   input: 50 000 distinct tenants produced 50 000 resident limiters. That
    //   is a denial-of-service surface reachable from a header.
    // - **An LRU of per-key limiters** (`PowerCache` being the obvious tool in
    //   this repo) is *worse than no bound at all*, because evicting a limiter
    //   discards that tenant's consumed budget with it. A tenant evicted while
    //   quiet returns to a brand-new limiter with a full fresh allowance — a
    //   rate-limit bypass, not a cache miss, and it penalises precisely the
    //   tenants that behaved.
    //
    // So there is **no eviction path**. Keys are hashed into a fixed array of
    // slots (`buckets`, default 1024) and each slot lazily builds its own
    // limiter set on first use. Bounded by construction: 1 000 000 distinct keys
    // allocate exactly `buckets` limiter sets, because nothing is ever removed.
    //
    // The cost is real and is documented rather than hidden: **two keys that hash
    // to the same slot share a budget.** That is nginx's `limit_req` model, and
    // it is the right trade for a limiter whose input is untrusted — but it is a
    // weakening of "per key", so `buckets` is configurable and the guide says so.
    // Validated before it is stored, so a typo is an error rather than a silent
    // fall-back to the *unkeyed* path. That fall-back is the dangerous direction:
    // `keyFn: 'tenant'` would look configured and silently give every caller one
    // shared limit, so a per-key limit becomes a global one with no error. The
    // first version of this check read `if (this.keyFn && ...)`, which is never
    // true for a non-function because `this.keyFn` was already normalised to
    // null above it — so it did not throw at all.
    if (options.keyFn != null && typeof options.keyFn !== 'function') {
      throw new TypeError(`keyFn must be a function (received ${typeof options.keyFn})`);
    }
    this.keyFn = options.keyFn ?? null;
    const buckets = options.buckets == null ? 1024 : options.buckets;
    this.buckets = buckets;
    if (this.keyFn) {
      if (!Number.isInteger(buckets) || buckets < 1) {
        throw new TypeError(`buckets must be a positive integer (received ${String(buckets)})`);
      }
      // Factories, because a per-slot limiter set cannot be a shared instance:
      // one GCRA holding 1024 tenants' budgets is not per-key limiting, it is one
      // limiter with an unbounded key space, which is the thing being fixed.
      for (const entry of limiters) {
        if (typeof entry !== 'function') {
          throw new TypeError(
            'with `keyFn`, each limiter must be a factory (slotIndex) => limiter, ' +
              'because a shared instance cannot hold per-key budgets'
          );
        }
      }
      /** @type {Array<RateLimiterLike[]|null>} */
      this._slots = new Array(buckets).fill(null);
    }
  }

  /**
   * The limiter set for `key`, building it on first use.
   *
   * FNV-1a over the string form of the key. Measured over 100 000 keys into
   * 1024 slots: every slot used, min 59 / max 136 against an expected 98, so
   * max/mean 1.39x with no hot spot. No avalanche step is needed at this size,
   * and adding one would cost per request to solve a problem this does not have.
   *
   * @param {string} key
   * @returns {RateLimiterLike[]} The slot's limiters, empty if the key is unusable.
   * @private
   */
  _slotFor(key) {
    const s = String(key);
    // An empty or non-string key still has to land somewhere deterministic, so
    // the fallback is a single shared slot rather than a throw: refusing to
    // limit at all because a caller passed `''` would be the worst direction.
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const index = (h >>> 0) % this.buckets;
    // Non-null assertion avoided rather than used: `index` is derived from
    // `h >>> 0` modulo a bucket count validated at construction, so it is in
    // range by construction, and saying so with a fallback keeps the narrowing
    // honest without an assertion the linter would flag.
    let slot = this._slots[index] ?? null;
    if (slot === null) {
      // `this.limiters` is typed `RateLimiterLike[]`, which is what the
      // *unkeyed* path consumes; with `keyFn` the constructor has already
      // checked that every entry is a function, and there is no way to narrow
      // `RateLimiterLike` to its callable self with `instanceof`. The cast is
      // the honest expression of that: the runtime check is above.
      const factories = /** @type {Array<(slot: number) => RateLimiterLike>} */ (
        /** @type {unknown} */ (this.limiters)
      );
      slot = this._slots[index] = factories.map((factory) => factory(index));
    }
    return slot;
  }

  /**
   * The per-key limiter set for `key`, for a caller that wants to inspect or
   * drive one key directly (a `retryAfter` in a `Retry-After` header, say).
   *
   * @param {string} key
   * @returns {RateLimiterLike[]|null} `null` when no `keyFn` is configured.
   */
  limitersFor(key) {
    if (!this.keyFn) return null;
    return this._slotFor(key);
  }

  /**
   * Try to consume `n` tokens across all limiters. Returns true only when
   * every underlying limiter allows consumption. This method first performs a
   * best-effort availability pre-check using `available()` when present; if all
   * checks pass it then performs the actual `tryConsume` calls to commit.
   * Note: some limiters' `available()` also advances internal state (e.g.
   * `PowerThrottle` refills tokens, `PowerSlidingWindow` prunes expired
   * timestamps). The pre-check and the commit run synchronously within the
   * same tick, so results stay consistent — but `available()` is not strictly
   * read-only.
   *
   * Note: when a limiter does not implement `available()` this method falls
   * back to calling `tryConsume` directly which may partially mutate state
   * if other limiters subsequently fail. Prefer limiters that implement
   * `available()` for atomic semantics.
   *
   * @param {number} [n=1] - Tokens to consume.
   * @param {PowerRateLimitCallOptions} [options] - Per-call overrides; `atomic`
   *   defaults to the instance setting, `now` supplies the single clock reading
   *   threaded into every leg, and `context` is what `keyFn` is called with.
   * @returns {boolean} `true` only when every composed limiter allowed it.
   */
  tryConsume(n = 1, options = {}) {
    // Per-key routing, before anything else. `options.key` selects the slot; a
    // missing key means every call shares one slot, which is the honest
    // degradation - it is the same limit the instance applied before `keyFn`
    // existed, so a caller who forgets the key is throttled rather than
    // unlimited.
    const legs = this.keyFn ? this._slotFor(this.keyFn(options.context ?? options)) : this.limiters;
    if (this.keyFn) return this._consumeIn(legs, n, options);
    return this._consumeIn(this.limiters, n, options);
  }

  /**
   * The consume path, parameterised on the leg set.
   *
   * Split out of {@link PowerRateLimit#tryConsume} so the keyed and unkeyed
   * routes share **one** implementation. Duplicating the atomic pre-check, the
   * commit loop and the rollback bookkeeping would be the likeliest way to end
   * up with per-key consumption that does not roll back when a leg fails — the
   * exact defect the unkeyed path was fixed for.
   *
   * @param {RateLimiterLike[]} legs - The limiters to consult: the instance's own,
   *   or one hashed slot's.
   * @param {number} n - The count, already validated.
   * @param {PowerRateLimitCallOptions} options
   * @returns {boolean}
   * @private
   */
  _consumeIn(legs, n, options) {
    // Validated here, before the `want === 0` early return and before any leg
    // is touched. The old coercion turned `NaN` into `0`, and `0` is the
    // *admit* case — so `PowerRateLimit.tryConsume(NaN)` returned `true` having
    // consulted no limiter at all, and a composition would report success that
    // none of its legs agreed to. A count a limiter cannot price is not zero
    // work (see `assertCount`).
    const want = assertCount(n, { name: 'n', className: 'PowerRateLimit', method: 'tryConsume' });
    if (want === 0) return true;
    const atomic = options.atomic == null ? this.atomicDefault : Boolean(options.atomic);
    // The whole point of PERF-007. `nowMs()` reads two clocks per call and
    // costs ~141 ns, so an N-limiter composition was spending N of them - the
    // dominant cost of the call, and pure waste: every limiter inside a single
    // `tryConsume` is deciding what time it is at the same instant, so they
    // should all be *told* rather than each going and looking.
    //
    // A limiter with its own injected clock ignores this (see
    // `resolveLimiterNow`), and a third-party limiter that only accepts `n`
    // simply reads its own clock - so threading is safe without a capability
    // check on the limiter.
    const legOptions = { now: resolveComposerNow(options) };

    // Validate every limiter up front. Previously the capability check lived
    // *inside* the commit loop, so a limiter without `tryConsume` threw only
    // after the earlier limiters had already consumed - leaving the caller's
    // limiter set mutated and the "returns a boolean" contract broken.
    for (const l of legs) {
      if (typeof l.tryConsume !== 'function' && typeof l.reserve !== 'function') {
        throw new TypeError('limiter must implement tryConsume or reserve');
      }
    }

    // Fast non-mutating check when available() exists on all limiters.
    // NB: `available()` is not required to be side-effect free (PowerThrottle's
    // refill is), it is only a cheap pre-flight that keeps the common
    // all-satisfied case on the fast path.
    let allHaveAvailable = true;
    for (const l of legs) {
      if (typeof l.available === 'function') {
        try {
          if (l.available(legOptions) < want) return false;
        } catch (e) {
          return false;
        }
      } else {
        allHaveAvailable = false;
      }
    }

    if (!atomic || allHaveAvailable) {
      // Non-atomic, or a pre-flight that all limiters satisfied. Commit
      // directly; a mid-way failure returns `false` and the already-consumed
      // limiters keep their tokens, which is the documented non-atomic
      // contract.
      for (const l of legs) {
        const ok = l.tryConsume(want, legOptions);
        if (!ok) return false;
      }
      return true;
    }

    // Atomic required but some limiters lack available(): attempt two-phase
    // approach using reserve/tryConsume and best-effort rollbacks.
    const committed = [];
    // Pre-check: if any limiter without available() also lacks any undo
    // capability (reserve/release or addTokens), we cannot guarantee atomicity.
    for (const l of legs) {
      if (typeof l.available !== 'function') {
        const supportsUndo =
          typeof l.reserve === 'function' ||
          typeof l.release === 'function' ||
          typeof l.addTokens === 'function' ||
          typeof l.rollback === 'function';
        if (!supportsUndo) {
          // cannot safely perform atomic consume
          return false;
        }
      }
    }

    // Commit attempts
    for (const l of legs) {
      if (typeof l.reserve === 'function') {
        // reserve returns a token or truthy marker
        try {
          const token = l.reserve(want);
          if (!token) {
            // reservation failed -> rollback
            for (let i = committed.length - 1; i >= 0; i--) {
              this._undoCommit(committed[i], want).catch(() => {});
            }
            return false;
          }
          committed.push({ l, method: 'reserve', token });
          continue;
        } catch (e) {
          for (let i = committed.length - 1; i >= 0; i--) {
            this._undoCommit(committed[i], want).catch(() => {});
          }
          return false;
        }
      }

      // fallback: call tryConsume. The capability check at the top of this
      // method guarantees one of the two exists, so reaching here means
      // `tryConsume` is present and safe to call.
      try {
        const ok = l.tryConsume(want, legOptions);
        if (!ok) {
          for (let i = committed.length - 1; i >= 0; i--) {
            this._undoCommit(committed[i], want).catch(() => {});
          }
          return false;
        }
        committed.push({ l, method: 'tryConsume' });
      } catch (e) {
        for (let i = committed.length - 1; i >= 0; i--) {
          this._undoCommit(committed[i], want).catch(() => {});
        }
        return false;
      }
    }

    return true;
  }

  /**
   * Return the minimum available tokens across all limiters.
   * If any limiter does not expose `available()`, this returns `0`.
   * With `keyFn`, `options.context` selects the key whose slot is measured —
   * without it the result is the shared default slot's.
   * @param {PowerRateLimitCallOptions} [options]
   * @returns {number}
   */
  available(options = {}) {
    const legs = this.keyFn ? this._slotFor(this.keyFn(options.context ?? options)) : this.limiters;
    if (legs.length === 0) return Infinity;
    // One read for the whole composition, as in `tryConsume`. Without this the
    // atomic pre-flight above costs a second N clock reads per call.
    const legOptions = { now: resolveComposerNow(options) };
    let min = Infinity;
    for (const l of legs) {
      if (typeof l.available !== 'function') return 0;
      try {
        const value = l.available(legOptions);
        min = Math.min(min, Number(value) || 0);
      } catch (e) {
        return 0;
      }
    }
    return min === Infinity ? 0 : min;
  }

  /**
   * Reserve `n` tokens across all limiters and return a token to undo later.
   * Returns `null` when reservation fails.
   * The returned token is a simple marker object such as `{ n: 1 }`, and it can
   * be consumed by `release(token)` or `rollback(token)` to restore the limiters.
   * @param {number} [n=1]
   * @param {PowerRateLimitCallOptions} [options] - Per-call overrides; `context`
   *   selects the `keyFn` slot, so a reservation is made against the same
   *   budget the caller's own `tryConsume` will spend.
   * @returns {{n:number}|null}
   */
  reserve(n = 1, options = {}) {
    const want = assertCount(n, { name: 'n', className: 'PowerRateLimit', method: 'reserve' });
    if (want === 0) return { n: 0 };
    // The key has to reach `tryConsume`, so it is forwarded rather than
    // re-derived: reserving on the instance's default slot and consuming on the
    // caller's slot would split one reservation across two budgets.
    if (!this.tryConsume(want, { ...options, atomic: true })) return null;
    // The token shape is `{ n }` and nothing else. A `slot` field was added here
    // so `reserve()` could be tested against `limitersFor()`, and it broke an
    // existing `toEqual({ n: 1 })` in `powerRateLimit.extra.test.js` — a test
    // pinning the documented shape. The token is public API: `release()` accepts
    // it and callers may compare it, so growing it for a test's benefit is the
    // wrong direction of dependency. `limitersFor()` already exposes the slot.
    return { n: want };
  }

  /**
   * Release a prior reservation token or numeric count back to the limiters.
   * This accepts the same token object produced by `reserve()` or a numeric
   * count to return tokens directly.
   *
   * Deliberately still coercing rather than calling `assertCount`, because this
   * is the *return* path and not the admission path. A count that cannot be
   * read returns nothing, which is the safe direction: admitting a request you
   * cannot price is how a limiter is bypassed, whereas returning nothing merely
   * over-charges the caller.
   *
   * @param {object|number} tokenOrN
   */
  release(tokenOrN) {
    const n =
      tokenOrN == null
        ? 0
        : typeof tokenOrN === 'object'
          ? Number(tokenOrN.n) || 0
          : Math.max(0, Math.floor(+tokenOrN) || 0);
    if (n === 0) return;

    for (const l of this._liveLimiters()) {
      if (typeof l.release === 'function') {
        try {
          l.release(tokenOrN);
          continue;
        } catch (e) {
          // fallback to other undo paths
        }
      }
      if (typeof l.rollback === 'function') {
        try {
          l.rollback(n);
          continue;
        } catch (e) {
          /* swallow */
        }
      }
      if (typeof l.addTokens === 'function') {
        try {
          l.addTokens(n);
          continue;
        } catch (e) {
          /* swallow */
        }
      }
    }
  }

  rollback(nOrToken) {
    return this.release(nOrToken);
  }

  /**
   * Every limiter that is currently real: the instance's own legs, or every
   * built slot's legs when `keyFn` is configured.
   *
   * @returns {RateLimiterLike[]}
   * @private
   */
  _liveLimiters() {
    if (!this.keyFn) return this.limiters;
    const out = [];
    for (const slot of this._slots) {
      if (slot) out.push(...slot);
    }
    return out;
  }

  async _undoCommit(entry, want) {
    const { l, method, token } = entry;
    try {
      if (method === 'reserve' && typeof l.release === 'function') {
        // release a reservation token
        return l.release(token);
      }
      if (typeof l.rollback === 'function') return l.rollback(want);
      if (typeof l.addTokens === 'function') return l.addTokens(want);
      // best-effort: if limiter exposes reset, call it (may be heavy)
      if (typeof l.reset === 'function') return l.reset();
    } catch (e) {
      // swallow undo errors — nothing more we can do
    }
  }

  /**
   * Reset all underlying limiters where supported.
   *
   * With `keyFn`, every **built** slot is reset rather than the factory list:
   * the factories are not limiters and resetting them would rebuild nothing.
   * Built slots stay built, because discarding them would hand every tenant a
   * fresh allowance — the eviction-is-a-reset bypass this design exists to avoid.
   */
  reset() {
    for (const l of this._liveLimiters()) {
      if (typeof l.reset === 'function') {
        try {
          l.reset();
        } catch (e) {
          /* swallow */
        }
      }
    }
  }
}

export default PowerRateLimit;
