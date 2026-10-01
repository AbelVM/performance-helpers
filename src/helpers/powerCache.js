import { SmallLfuSketch } from '../utils/smallLfu.js';

/**
 * Half-life, as a multiple of `maxEntries`. TinyLFU's guidance is ~10x, but the
 * sketch here is incremented on `get` as well as `set`, so a short warm-up can
 * trip a reset and halve a working set that had only just been learned. Tuned by
 * measurement - see the scan-resistance table in guides/powerCache.md.
 */
const ADMISSION_SAMPLE_MULTIPLE = 200;

/**
 * Counters per cache entry in the TinyLFU admission sketch, per Caffeine.
 *
 * 4-bit counters, two to a byte, so this is 8 bytes per entry — the figure
 * Caffeine quotes for its own frequency sketch. Held as a count of counters
 * rather than bytes so the relationship to `depth` below is visible.
 */
const SKETCH_COUNTERS_PER_ENTRY = 16;

/**
 * Rows in the sketch. Unchanged at the sketch's own default of 4: taking the
 * minimum across rows is what makes this a Count-Min, so a key can read
 * slightly hotter than it is but never colder — the safe direction for an
 * admission filter. This class is Count-Min, not Caffeine's single-table
 * variant, and lowering it would give that guarantee up for memory.
 */
const SKETCH_DEPTH = 4;

/**
 * Largest cache the sketch table is sized for, matching the clamp already
 * applied to `sampleSize` above.
 *
 * `maxEntries` defaults to `Infinity`, so this is not a formality: an unbounded
 * cache cannot be sized from and must not be asked to allocate `Infinity`
 * counters. A cache that large also never consults the sketch, because
 * `_admit` only arbitrates once `size >= maxEntries` — the filter exists to
 * choose what to evict, and an unbounded cache never evicts. The cost at the
 * ceiling is 16 counters per entry, or 8 bytes per entry: a 1 000 000-entry
 * cache spends ~8 MB on the filter, and only when `admission: 'tinylfu'` was
 * asked for.
 */
const SKETCH_SIZE_CEILING = 1e6;

/**
 * Table width, in counters, for a cache holding `maxEntries`.
 *
 * Power of two, because the sketch indexes with a mask (`this.mask = width - 1`).
 * Rounding **up** matters: rounding down would land below the target budget and
 * re-create the undersized-table problem at exactly the capacities where the
 * ratio is closest.
 *
 * @param {number} maxEntries
 * @returns {number}
 */
function sketchWidthFor(maxEntries) {
  const entries = Math.min(Math.max(1, Number(maxEntries) || 1), SKETCH_SIZE_CEILING);
  const wanted = Math.ceil((SKETCH_COUNTERS_PER_ENTRY * entries) / SKETCH_DEPTH);
  // `Math.max(2, …)` matches the sketch's own floor, so this cannot ask for a
  // table the constructor would silently widen.
  return Math.max(2, 1 << Math.ceil(Math.log2(wanted)));
}
/**
 * @typedef {import('./jsdoc-types.js').CacheNode} CacheNode
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerCacheOptions} PowerCacheOptions
 * @typedef {import('./jsdoc-types.js').PowerCacheGetOrFetchOptions} PowerCacheGetOrFetchOptions
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerMemoizerOptions} PowerMemoizerOptions
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerTimedCacheOptions} PowerTimedCacheOptions
 */

/**
 * @example
 * // Create a cache with caps and a simple weight function
 * const cache = new PowerCache({
 *   maxEntries: 100,
 *   maxWeight: 1024 * 1024,
 *   weightFn: (v) => (v?.byteLength) ? v.byteLength : 1,
 *   defaultTTL: 60_000,
 *   rejectOversized: true
 * });
 *
 * // Insert a value with explicit weight and TTL
 * cache.set('tile:0:0:0', { labels: [] }, { ttl: 5 * 60_000, weight: 1024 });
 *
 * // Retrieve and mark as used
 * const val = cache.get('tile:0:0:0');
 *
 * // Iterate MRU-first
 * for (const [key, value] of cache.entries('MRU')) { ... }
 *
 * // Start periodic cleanup every 10s scanning up to 200 nodes per tick
 * cache.startCleanup({ interval: 10000, maxCleanupPerTick: 200 });
 *
 * // Inspect stats
 * logger.log(cache.stats());
 *
 * @class PowerCache
 * @public
 */
import { nowMs } from '../utils/now.js';
import { attach, detach } from './metrics.js';
import {
  assertFunction,
  assertLimitRequired,
  normalizeTtl,
  assertKnownOptions,
} from '../utils/options.js';
import { setSafeTimeout } from '../utils/timers.js';
import {
  DEFAULT_MAX_CLEANUP_PER_TICK,
  DEFAULT_CACHE_DEFAULT_TTL_MS,
  DEFAULT_CACHE_MAX_POOL_SIZE,
  DEFAULT_TIMEOUT_MS,
  MS_PER_SEC,
  MAX_DEEP_EQUAL_DEPTH,
  MAX_DEEP_EQUAL_NODES,
} from './constants.js';

/**
 * Underscore-prefixed fields exposed as read/write aliases for backwards
 * compatibility. `cache.map`, `cache.head` and friends have been public since
 * 1.0, so they stay accessors rather than plain fields: the state lives in
 * `_map` and `_head`, and a plain field would shadow it and desynchronise.
 *
 * @type {ReadonlyArray<string>}
 */
const ALIASED_FIELDS = Object.freeze([
  'map',
  'head',
  'tail',
  'pool',
  'currentWeight',
  'hits',
  'misses',
  'evictions',
  'rejected',
  'expirations',
]);

/**
 * PowerCache
 *
 * In-memory cache with weight-aware eviction, TTLs and optional cleanup.
 * Provides MRU/LRU iteration helpers and hooks for eviction/expiration.
 *
 * @class PowerCache
 * @public
 */
export class PowerCache {
  /**
   * Create a PowerCache.
   *
   * The options type is the `PowerCacheOptions` typedef, not a second inline
   * list. The two had drifted: `defaultAsyncTimeout`, `onError` and `policy`
   * were destructured here and documented in the typedef, but absent from a
   * duplicated `@param` list on this constructor - so TypeScript synthesised an
   * options type without them, the body failed to type-check against its own
   * signature, and the three options were missing from the published
   * declarations. One source of truth, not two that have to be kept in step.
   *
   * @param {PowerCacheOptions} [options]
   * @throws {TypeError} When a non-object is provided as the options argument.
   */
  constructor({
    maxEntries = Infinity,
    maxWeight = Infinity,
    weightFn = () => 1,
    defaultTTL = DEFAULT_CACHE_DEFAULT_TTL_MS,
    // ── Stale-while-revalidate ──────────────────────────────────────────────
    // `staleWhileRevalidate` already existed as a **per-call** flag, and that is
    // where the defect lived: with no upper bound on the stale window, it
    // served a value expired at *any* point in the past. Measured — a value
    // **5 years** past `expiresAt` was still returned as "stale", with the
    // refresh running in the background and failing silently every time. That is
    // not stale-while-revalidate, it is serve-forever-while-refreshing, and it
    // is the one failure mode SWR must not have: a caller asking for
    // freshness-while-not-blocking is asking for it for a bounded time.
    allowStale = false,
    staleTtl = Infinity,
    // A default producer for `getOrFetch`. Declared here rather than required at
    // each call site because the per-call form still wins, so a cache can have a
    // general default that one caller overrides.
    fetchMethod = null,
    maxPoolSize = DEFAULT_CACHE_MAX_POOL_SIZE,
    rejectOversized = false,
    onEvict = null,
    onExpire = null,
    initialPoolSize = 0,
    maxCleanupPerTick = DEFAULT_MAX_CLEANUP_PER_TICK,
    // default timeout (ms) applied to `getOrSetAsync` when callers omit per-call timeout
    defaultAsyncTimeout = DEFAULT_TIMEOUT_MS,
    // invoked as onError(err, message) whenever an internal failure is
    // swallowed (throwing onEvict/onExpire, a failing weightFn, ...)
    onError = null,
    /** @see PowerCache#_policy - `'lru'` (default) or `'slru'`. */
    policy = 'lru',
    admission = 'none',
    windowSize = 0,
    /**
     * Injected clock in milliseconds, matching the limiters (PERF-007) and
     * `PowerTTLMap`. Expiry is the one behaviour in this class that cannot be
     * observed synchronously, so this is what turns "assert it expired after
     * 100 ms" from a sleep into an exact assertion.
     */
    now,
  } = {}) {
    // Basic options validation: when an explicit options argument is provided it must be an object
    if (arguments.length > 0 && arguments[0] != null && typeof arguments[0] !== 'object') {
      throw new TypeError('PowerCache options must be an object');
    }
    // Validate limits. `Infinity` is a legitimate "no limit" and is the
    // documented default for `maxEntries`/`maxWeight`, so it stays allowed.
    // What is *not* allowed is a `NaN` (which made `size > NaN` always false,
    // so eviction silently never ran and the cache grew without bound) or a
    // negative bound (which emptied the cache and kept it empty). Both are
    // configuration errors, so fail loudly.
    this.maxEntries = assertLimitRequired(maxEntries, {
      name: 'maxEntries',
      className: 'PowerCache',
      integer: true,
      min: 0,
      allowInfinity: true,
    });
    this.maxWeight = assertLimitRequired(maxWeight, {
      name: 'maxWeight',
      className: 'PowerCache',
      min: 0,
      allowInfinity: true,
    });
    this.maxPoolSize = assertLimitRequired(maxPoolSize, {
      name: 'maxPoolSize',
      className: 'PowerCache',
      integer: true,
      min: 0,
      allowInfinity: true,
    });
    this.weightFn = assertFunction(weightFn, { name: 'weightFn', className: 'PowerCache' })
      ? weightFn
      : () => 1;
    this.defaultTTL = defaultTTL;
    /**
     * Serve a stale value on `getOrSet`/`getOrSetAsync` by default, so a caller
     * does not have to pass `staleWhileRevalidate` at every call site. The
     * per-call flag still wins, and `false` here does not remove the per-call
     * option - it only stops it being the default.
     */
    this.allowStale = Boolean(allowStale);
    // `staleTtl` is a validated *duration*, not a boolean, and the validation is
    // the feature: an unvalidated one let `staleTtl: 'soon'` read as `NaN` and
    // compare false, so stale was silently disabled by a typo rather than
    // rejected. `Infinity` is accepted explicitly, as "no bound", because that
    // is a real (if unwise) choice a caller may make on purpose.
    if (staleTtl !== Infinity && !(Number.isFinite(staleTtl) && staleTtl >= 0)) {
      throw new TypeError(
        'PowerCache: `staleTtl` must be a non-negative finite number or Infinity ' +
          `(received ${String(staleTtl)}). An unparseable stale window would compare ` +
          'false against every entry and silently disable stale serving.'
      );
    }
    // `allowStale` without a `staleTtl` is the one combination refused, and the
    // refusal is the point.
    //
    // `staleTtl` defaults to `Infinity` rather than `0` because the per-call
    // `staleWhileRevalidate: true` flag **already existed and already served
    // stale without an upper bound**. Defaulting to `0` would have silently
    // switched that off for every existing caller — the flag would still be
    // passed and nothing would be stale, which is a behaviour change with no
    // error and no way to notice. Two existing tests caught exactly that.
    //
    // So the *new* surface is the one that is safe by construction: reaching
    // `allowStale` means opting into per-key stale on every call, and that has
    // to be paired with a chosen bound. `staleTtl: Infinity` is still available
    // for a caller who wants unbounded deliberately — they just have to say so.
    // `arguments[0]` is the caller's original options object — the constructor
    // destructures anonymously, so there is no named `options` to ask, and
    // `staleTtl === Infinity` cannot distinguish "defaulted" from "explicitly
    // passed Infinity", which are opposite intentions here. A `Symbol` sentinel
    // would distinguish them and cost two type errors against the declared
    // `number` option, so this asks the object directly.
    if (this.allowStale && !('staleTtl' in arguments[0])) {
      throw new TypeError(
        'PowerCache: `allowStale` requires an explicit `staleTtl`. A stale window with ' +
          'no bound serves a value expired at any point in the past — measured at five ' +
          'years — so the bound is required. Pass the window you can tolerate, or ' +
          '`staleTtl: Infinity` to opt out of it on purpose.'
      );
    }
    this.staleTtl = staleTtl;
    if (fetchMethod != null && typeof fetchMethod !== 'function') {
      throw new TypeError('fetchMethod must be a function when supplied');
    }
    // Annotated rather than defaulted to a function.
    //
    // `fetchMethod = () => null` silenced a `Type 'null' is not assignable to
    // type '() => any'` error, and in doing so **broke `getOrFetch`**: its
    // `factory ?? this.fetchMethod` then always resolved to a function, so the
    // "no factory anywhere" path stopped rejecting and returned `null` instead
    // of a `TypeError`. The error was in the *type*, not the value, and the
    // annotation is where it belonged.
    /** @type {Function|null} */
    this.fetchMethod = fetchMethod;
    // Injected clock, matching the limiters (PERF-007) and `PowerTTLMap`. It
    // is read through `this._now()` at seven sites, all of which are "what time
    // is it" reads with no other argument, so this is the whole change.
    this._now = typeof now === 'function' ? now : nowMs;
    this.rejectOversized = Boolean(rejectOversized);
    this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    this.onError = typeof onError === 'function' ? onError : null;
    /** number of times `weightFn` threw; a non-zero value means `maxWeight`
     *  could not be enforced and should be surfaced by the caller. */
    this._weightErrors = 0;
    this.onExpire = typeof onExpire === 'function' ? onExpire : null;
    this.maxCleanupPerTick = Number.isFinite(+maxCleanupPerTick)
      ? Math.max(1, +maxCleanupPerTick)
      : DEFAULT_MAX_CLEANUP_PER_TICK;

    this._map = new Map();
    // NOTE: there is deliberately no `eagerCleanupOnRead` option. It was
    // documented for two releases, promised that `peek()`/`has()` would remove
    // expired entries when observed, and did nothing — because
    // `_fetchValidNode` already removes them, unconditionally, on every read path.
    // Measured with both values set: identical `size`, `_expirations` and
    // `onExpire` counts. The *guide* was the actual defect, claiming a
    // non-mutating default the code never had. See CACHE-008.
    this._head = null;
    this._tail = null;
    /**
     * Recycled nodes, kept to avoid allocating one per insert.
     *
     * Annotated because an empty `[]` takes its element type from whatever is
     * first pushed into it, and the prefill literal below is a *narrower* type
     * than `CacheNode` — which then made every other push into this pool a type
     * error. The annotation is the fix; the two prefill fields are the rest of
     * it.
     *
     * @type {CacheNode[]}
     */
    this._pool = [];
    // Prefill pool to reduce runtime allocations if requested. `inWindow` is set
    // on every prefilled node as well as on freshly allocated ones: a prefilled
    // node without it would be `undefined` rather than `false`, which behaves
    // the same today and is exactly the kind of latent divergence that becomes a
    // bug when someone writes `node.inWindow === false`.
    for (let i = 0; i < Math.min(initialPoolSize || 0, this.maxPoolSize); i++)
      this._pool.push({
        key: null,
        value: null,
        weight: 0,
        expiresAt: 0,
        prev: null,
        next: null,
        inWindow: false,
      });

    this._currentWeight = 0;
    this._hits = 0;
    /**
     * Serves of an **expired** value, from the stale-while-revalidate path.
     *
     * Separate from `_hits` because a stale serve is the one case where the cache
     * answered without having fresh data, and a caller cannot otherwise tell
     * it apart from a real hit. Operating stale-while-revalidate blind to that
     * rate is how a broken upstream turns into a silently wrong service: every
     * request is "successful" and the numbers look like a warm cache.
     *
     * A subset of `_hits` — a stale serve still counts as a hit, because from the
     * caller's side it was served.
     */
    this._staleServes = 0;
    this._misses = 0;
    this._evictions = 0;
    this._rejected = 0; // rejected oversized insert attempts
    this._rejectedAdmission = 0; // insert attempts refused by the TinyLFU filter
    this._expirations = 0;

    // Backwards-compatible aliases for external access. These were ten
    // copy-pasted `Object.defineProperty` blocks (~110 lines) whose descriptors
    // are all identical; one loop is equivalent, and keeps the aliased set
    // reviewable in one place instead of scattered through a constructor.
    for (const name of ALIASED_FIELDS) {
      const priv = `_${name}`;
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: false,
        get() {
          return this[priv];
        },
        set(v) {
          this[priv] = v;
        },
      });
    }

    this._cleanupTimer = null;
    this._cleanupRunning = false;
    this._cleanupParams = null;
    // Cursor used to resume incremental expiration scans to avoid re-scanning the list start
    this._cleanupCursor = null;
    // Whether the `_cleanupCursor` still points to a live node in `this._map`.
    // This avoids a Map lookup on every incremental cleanup scan — mutation paths
    // that remove or advance the cursor will update this flag accordingly.
    this._cleanupCursorValid = false;
    // Eviction candidate pointer to avoid repeated head lookups during large
    // eviction sweeps. Kept in sync with head mutations.
    this._evictionCandidate = null;
    /**
     * Eviction policy. `'lru'` (default) keeps the previous single-recency-list
     * behaviour. `'slru'` splits the list into a probation segment and a
     * protected segment and promotes on access, which makes the cache far more
     * resistant to a one-off sequential scan evicting the working set.
     */
    this._policy = policy === 'slru' ? 'slru' : 'lru';

    /**
     * Frequency sketch backing `{ admission: 'tinylfu' }`, or `null` when
     * admission is off. See {@link SmallLfuSketch}.
     * @type {SmallLfuSketch|null}
     * @private
     */
    // **`admission: 'tinylfu'` is a no-op under `policy: 'slru'`.**
    //
    // SLRU's probation segment is the same mechanism the sketch provides: both
    // absorb one-shot traffic before it can reach the main region. Stacking them
    // is not a weaker version of either, it is a worse cache - measured on the
    // paired Zipf + scan workload (`node bench/claims.js zipf`), `slru` +
    // `tinylfu` retained **70.9 %** of the working set against `slru` alone's
    // **89.4 %**, and plain LRU's 75.0 %. Composing "the two scan-resistant
    // options" produced the worse of each rather than the better.
    //
    // Not building the sketch is the smallest change that makes the combination
    // predictable: a user who asks for SLRU gets SLRU. The cost is a hash and a
    // memory probe per access, which is what not building it saves.
    //
    // The broader W-TinyLFU admission window that this option was heading
    // towards is **not** in this release - the mechanism is correct but still
    // measures worse than plain LRU on this workload, so it did not meet its own
    // acceptance criteria. `adr/0003-tinylfu-admission-window.md` has the
    // full story, including why.
    this._sketch =
      admission === 'tinylfu' && this._policy === 'lru'
        ? new SmallLfuSketch({
            // Sized from the cache's capacity, not left at the sketch's own
            // default. The default is a fixed 64x4 = 256 counters, so the
            // filter's accuracy depended on nothing about the cache it was
            // protecting: 16 counters per entry at `maxEntries: 16`, 4.0 at 64,
            // **0.256 at 1 000**, 0.00026 at 1e6. At 1 000 the sketch cannot
            // discriminate at all — measured, a working set at capacity drove
            // every hot key to 15 and a key **never inserted** also read 15, so
            // a one-shot scan key was indistinguishable from the working set and
            // the admission filter carried zero information. That is the
            // failure the filter exists to prevent, and it arrived through the
            // one part of the policy that was not sized to the workload.
            //
            // Caffeine's recipe, which this now follows: a 4-bit CountMinSketch
            // "growing at 8 bytes per cache entry" = 16 counters per entry, with
            // the table a power of two so the index is a mask. Depth is held at
            // 4, so the width carries a quarter of the budget.
            width: sketchWidthFor(this.maxEntries),
            // The half-life has to be sized against the working set, not left
            // at the sketch's own default of 10 operations. At 10 a reset
            // fired every ten set/get and halved everything, so by the time a
            // scan began the hot keys had decayed to the same estimate as the
            // scan keys and the filter admitted every one of them - 0/40 on the
            // scan-resistance benchmark, exactly as plain LRU does. TinyLFU's own
            // guidance is roughly 10x the distinct-key count.
            sampleSize: Math.max(1, ADMISSION_SAMPLE_MULTIPLE * Math.min(this.maxEntries, 1e6)),
          })
        : null;
    /**
     * Size of the W-TinyLFU admission window, or `0` for no window.
     *
     * The window is the last `windowSize` entries of the recency list: new keys
     * land there unconditionally, and only the window's oldest entry is
     * arbitrated against the main-space victim. That is what lets a one-shot
     * scan be absorbed in a region it cannot displace the working set from.
     *
     * It defaults to **`0` — the window is off** — and that is the shipped
     * behaviour of `admission: 'tinylfu'`. See the note below and
     * `adr/0003-tinylfu-admission-window.md`.
     *
     * Arming is last because it depends on `_sketch` and `_maxEntries`. An
     * earlier version computed it just below the sketch and was then zeroed
     * again by the declaration further down, so the option silently did nothing
     * and every test that turned it on failed for the same uninteresting reason.
     *
     * @type {number}
     * @private
     */
    this._windowSize =
      this._sketch && this._policy === 'lru'
        ? windowSize === null
          ? Math.min(
              Math.max(4, Math.ceil(this.maxEntries * 0.01)),
              Math.floor(this.maxEntries / 4)
            )
          : Math.max(0, Math.floor(Number(windowSize) || 0))
        : 0;
    if (this._windowSize >= this.maxEntries && this.maxEntries >= 4) {
      // A window that is the whole cache is not a window: every newcomer would be
      // admitted and the filter would never run. Clamp so main space always has
      // room for the comparison to mean something.
      this._windowSize = Math.floor(this.maxEntries / 4);
    }
    /**
     * MRU end of the admission window, or `null` when the list is shorter than
     * the window. Derived rather than tracked: `_windowOldest()` walks back
     * from the tail, because every attempt that maintained this pointer
     * incrementally got it wrong. The window is *positional*, and a node
     * carrying a correct `inWindow` flag can still be on the wrong side of the
     * boundary.
     * @type {CacheNode|null}
     * @private
     */
    this._windowStart = null;
    /**
     * MRU end of the probation segment. With `policy: 'slru'` the list is
     * ordered:
     *
     *   head (probation LRU) ... _probationEnd (probation MRU)
     *        -> protected LRU ... tail (protected MRU)
     *
     * New entries are spliced in at the probation/protected boundary and a hit
     * promotes a node to the tail. `null` when the list is empty.
     * @type {CacheNode|null}
     */
    this._probationEnd = null;
    // Track in-flight async factories for `getOrSetAsync` to dedupe concurrent callers
    this._inflightPromises = new Map();
    // AbortControllers for the fetches named in `_inflightPromises`, held in a
    // **parallel map** rather than by widening the value of that one to a
    // `{promise, controller}` record.
    //
    // The record shape was the first attempt and it was the wrong call: 13 test
    // assertions across 4 files read `_inflightPromises` and expect a bare
    // promise, and every one of them would have had to change for no gain. A
    // second map costs one `Map` and leaves the observable shape alone, so the
    // cancellation work does not gate on a migration of unrelated tests.
    this._inflightControllers = new Map();
    this._defaultAsyncTimeout = Number.isFinite(Number(defaultAsyncTimeout))
      ? Math.max(0, Math.floor(Number(defaultAsyncTimeout)))
      : 30000;
    // FEAT-007: opt-in metrics. Off by default, so the common case pays
    // nothing and allocates no closure.
    this._metrics = attach(this, 'cache', arguments[0] || {});
  }

  /**
   * Allocate a pool node or create a new one.
   *
   * This helper either reuses a node from the internal `pool` or creates a
   * fresh node object. The returned node is initialized with the provided
   * key/value/weight/expiresAt and has its `prev`/`next` pointers nulled.
   *
   * @private
   * @param {*} key
   * @param {*} value
   * @param {number} weight
   * @param {number} expiresAt
   * @returns {CacheNode}
   */
  _allocNode(key, value, weight, expiresAt) {
    const node = this._pool.pop() || {
      key: null,
      value: null,
      weight: 0,
      expiresAt: 0,
      prev: null,
      next: null,
      // Whether this node sits in the admission window. A pooled node carries
      // its last role's flag, so this is reset on every allocation rather than
      // at insert — the window path sets it, the plain path never reads it, and
      // a stale `true` from a pooled node would misplace a fresh entry.
      inWindow: false,
    };
    node.key = key;
    node.value = value;
    node.weight = weight || 0;
    node.expiresAt = expiresAt || 0;
    node.prev = null;
    node.next = null;
    node.inWindow = false;
    return node;
  }

  /**
   * Compute and validate a weight for a value.
   * If `explicitWeight` is provided it is normalized and returned.
   * Otherwise `this.weightFn` is invoked safely and any thrown error
   * or non-finite return value results in a weight of `0`.
   * @private
   * @param {*} value
   * @param {number|null|undefined} explicitWeight
   * @returns {number}
   */
  _computeWeight(value, explicitWeight) {
    if (explicitWeight != null) {
      const v = +explicitWeight;
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    }
    try {
      const w = this.weightFn(value);
      const n = +w;
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    } catch (err) {
      // Previously this returned 0 in silence, which quietly voided the whole
      // `maxWeight` budget: every entry looked weightless so nothing was ever
      // evicted. Surface it and count it.
      this._weightErrors++;
      this._notifyError(err, 'PowerCache weightFn threw');
      return 0;
    }
  }

  /**
   * Report an internal failure (a throwing user callback, a failing
   * `weightFn`, ...) exactly once, through the configured `onError` handler
   * when present and otherwise to `console.error`.
   *
   * Every catch site in this class funnels through here, so a swallowed
   * failure is consistent and observable rather than invisible in some paths
   * and logged in others.
   *
   * @param {any} err - The thrown value.
   * @param {string} msg - Human-readable context.
   * @returns {void}
   * @private
   */
  _notifyError(err, msg) {
    try {
      if (typeof this.onError === 'function') {
        this.onError(err, msg);
        return;
      }
    } catch (_) {
      /* a failing error handler must never break the cache */
    }
    try {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error(msg, err);
      }
    } catch (_) {
      /* ignore console failures */
    }
  }

  /**
   * Reset and return a node to the pool for reuse.
   *
   * This helper clears the node fields and returns it to the node pool when
   * the pool has capacity. It is called for evicted or deleted nodes to
   * reduce allocation churn.
   *
   * @private
   * @param {CacheNode} node
   * @returns {void}
   */
  _freeNode(node) {
    node.key = null;
    node.value = null;
    node.weight = 0;
    node.expiresAt = 0;
    node.prev = null;
    node.next = null;
    if (this._pool.length < this.maxPoolSize) this._pool.push(node);
  }

  /**
   * Remove a node that has expired.
   *
   * Performs map deletion, linked-list unlink, invokes `onExpire`, returns the
   * node to the pool, and updates bookkeeping counters (`misses` and
   * `expirations`). This helper is called from several expiration paths and
   * centralizes the necessary cleanup steps.
   *
   * @private
   * @param {CacheNode} node
   * @param {number} now - Current timestamp (ms) used for comparisons
   * @remarks This helper does not modify the `misses` counter; callers should
   * increment `this._misses` when the removal corresponds to a user-facing
   * lookup (for example, `get()`/`getMany()`/`getOrSet()`).
   */
  _removeExpiredNode(node, now) {
    // Only remove when the node is actually expired according to `now`.
    if (!node.expiresAt || node.expiresAt > now) return false;
    const k = node.key;
    const v = node.value;
    this._unlinkNode(node);
    try {
      if (this.onExpire) this.onExpire(k, v);
    } catch (err) {
      this._notifyError(err, 'PowerCache onExpire callback threw');
    }
    this._freeNode(node);
    this._expirations++;
    return true;
  }

  /**
   * Fetch a node and validate expiry.
   * @private
   * @param {*} key
   * @param {Object} [options]
   * @param {boolean} [options.ignoreExpiry=false]
   * @param {boolean} [options.countMiss=false]
   * @param {boolean} [options.allowExpired=false] Return an expired node instead
   *   of `null`. Read by `_fetchValidNode` and passed by `getOrSet` when
   *   `staleWhileRevalidate` is on; previously read but never documented, so it
   *   was missing from the declared options type.
   * @returns {CacheNode|null}
   */
  _fetchValidNode(key, { ignoreExpiry = false, countMiss = false, allowExpired = false } = {}) {
    const node = this._map.get(key);
    if (!node) {
      if (countMiss) this._misses++;
      return null;
    }
    // Only sample the clock when we need to check expiry to avoid unnecessary
    // system calls on non-expiry paths.
    const now = !ignoreExpiry && node.expiresAt ? this._now() : 0;
    if (now && node.expiresAt <= now) {
      if (allowExpired) return node;
      this._removeExpiredNode(node, now);
      if (countMiss) this._misses++;
      return null;
    }
    return node;
  }

  /**
   * Whether an expired node may still be served at `now`.
   *
   * The whole point of the row, and the predicate that makes
   * `staleWhileRevalidate` safe: a stale value is servable only **within
   * `staleTtl` of its `expiresAt`**. Before this, the flag had no upper bound at
   * all and a value five years past expiry was still returned as "stale".
   *
   * `staleTtl === 0` means the feature is off, which is the default and the
   * pre-existing behaviour, so nothing changes for a caller who never asked for
   * it. `Infinity` means explicitly unbounded.
   *
   * @private
   * @param {CacheNode} node
   * @param {number} now
   * @returns {boolean}
   */
  _staleServable(node, now) {
    // `Infinity` is the one value arithmetic cannot answer for, so it is
    // short-circuited; everything else reduces to the comparison, **including
    // `0`**. There was an `if (!(this.staleTtl > 0)) return false` guard here and
    // a mutation check proved it dead: with `staleTtl: 0` the comparison alone is
    // already false for every expired entry, since `now > expiresAt` always. The
    // guard restated the arithmetic, and a restatement that cannot change the
    // answer is a second thing to keep correct.
    if (this.staleTtl === Infinity) return true;
    return now <= node.expiresAt + this.staleTtl;
  }

  /**
   * Signal the factory in flight for `key`, if there is one.
   *
   * The linkage `lru-cache` documents: *"if the key is evicted or deleted before
   * the fetchMethod resolves, the AbortSignal passed to the fetchMethod will
   * receive an abort event."* Before this there was no cancellation path at all
   * — measured, zero occurrences of `AbortController` in this file — so an
   * evicted key's factory ran to completion and then wrote its result into a
   * cache that no longer wanted it.
   *
   * Aborting is a **request**, not a kill. A factory that predates this takes no
   * argument and cannot be stopped, so it still completes and still stores; the
   * signal is there for a factory that can cooperate, and refusing to store
   * because a key was deleted would lose the value for a caller that wanted it.
   *
   * @private
   * @param {*} key
   * @param {string} [reason] - Diagnostic surfaced through `onError`.
   * @returns {boolean} Whether a factory was signalled.
   */
  _abortInflight(key, reason = 'evicted') {
    const controller = this._inflightControllers.get(key);
    if (!controller || controller.signal.aborted) return false;
    // **A `try`/`catch` around `abort()` does not contain a throwing listener,
    // and the first version of this claimed it did.** `abort()` dispatches
    // listeners synchronously but `runAbort` re-reports a listener exception on
    // `process.nextTick`, so it surfaces as an uncaught exception rather than a
    // rejection this call could catch. Verified: a factory whose abort handler
    // throws took the process down, and the `catch` never ran.
    //
    // That is the platform's contract, not something to wrap — the same is true
    // of `addEventListener` handlers generally — so the comment here records it
    // instead of pretending to handle it. The caller's own listener is the
    // caller's own risk, exactly as with any `abort()`.
    controller.abort(new Error(`PowerCache: in-flight fetch for a ${reason} key was aborted`));
    return true;
  }

  /**
   * Start a background refresh for an expired entry.
   *
   * If a refresh is already in flight for the key, this helper does nothing.
   * The refreshed value is written back to cache when the factory resolves.
   * Errors are swallowed so the stale value remains available.
   *
   * @private
   * @param {*} key
   * @param {Function} factory
   * @param {Object} [options]
   * @param {number} [options.ttl]
   * @param {number} [options.weight]
   * @returns {void}
   */
  _refreshStaleEntry(key, factory, { ttl = undefined, weight = undefined } = {}) {
    if (this._inflightPromises.has(key)) return;
    // The signal is the factory's first argument, as in `fetch` and
    // `lru-cache`, so a factory written for either works here unchanged.
    const controller = new AbortController();
    let p;
    try {
      p = Promise.resolve().then(() => factory(controller.signal));
    } catch (err) {
      return;
    }
    const tracked = p
      .then((value) => {
        try {
          this.set(key, value, { ttl, weight });
        } catch (err) {
          this._notifyError(err, 'PowerCache: storing a refreshed value threw');
        }
        return value;
      })
      .catch(() => undefined)
      .finally(() => {
        this._inflightControllers.delete(key);
        this._inflightPromises.delete(key);
      });
    this._inflightPromises.set(key, tracked);
    this._inflightControllers.set(key, controller);
  }

  /**
   * Append a node to the tail (mark it most-recently used).
   * This updates the linked-list pointers appropriately and is used when
   * inserting new nodes or promoting a node to MRU.
   *
   * @private
   * @param {CacheNode} node - Node to append at the tail.
   * @returns {void}
   */
  _append(node) {
    if (!this._tail) {
      this._head = this._tail = node;
      this._evictionCandidate = this._head;
      if (this._policy === 'slru') this._probationEnd = node;
      return;
    }
    if (this._policy === 'slru') {
      this._insertIntoProbation(node);
      return;
    }
    node.prev = this._tail;
    node.next = null;
    this._tail.next = node;
    this._tail = node;
  }

  /**
   * Splice `node` in as the new MRU of the probation segment (SLRU only).
   *
   * The list puts probation at the front and protected behind it, so a new
   * entry goes immediately *before* the protected LRU rather than at the tail.
   * The head-splice case (no probation segment exists yet) is what stops a
   * freshly-emptied cache from growing its probation at the wrong end.
   *
   * @private
   * @param {CacheNode} node
   * @returns {void}
   */
  _insertIntoProbation(node) {
    const boundary = this._probationEnd;
    if (!boundary) {
      // No probation segment: the whole list is protected, so the new entry
      // becomes the sole probation node at the very front.
      node.next = this._head;
      node.prev = null;
      if (this._head) this._head.prev = node;
      this._head = node;
      this._evictionCandidate = node;
    } else if (boundary === this._tail) {
      // The whole list is still probation: a plain append extends it.
      node.prev = this._tail;
      node.next = null;
      this._tail.next = node;
      this._tail = node;
    } else {
      const after = boundary.next;
      node.prev = boundary;
      node.next = after;
      boundary.next = node;
      after.prev = node;
    }
    this._probationEnd = node;
  }

  /**
   * Unlink a node and update every piece of bookkeeping that depends on it.
   *
   * Four call sites - expiry, eviction, `delete()` and the cleanup sweep -
   * each had their own copy of this sequence, which is exactly the kind of
   * duplication that lets one path drift. The only difference between them is
   * that eviction sweeps must also advance `_evictionCandidate`, hence the
   * flag.
   *
   * A cursor may only ever name a live node: `_remove` nulls both links, so a
   * cursor left pointing at a removed node would be handed by `_evictIfNeeded`
   * to `_unlinkNode`, whose `!p` and `!n` branches would set `head` and `tail`
   * to `null` and destroy the list. That is unreachable today — the eviction
   * sweeps pass the flag, and every other caller happens to remove the head,
   * which `_remove` repairs — and `review.md`'s CACHE-001 records it as
   * `**[verified]**` when it is not. **If you add a fifth call site, advance the
   * cursor when it is on the node you are removing**, or assert the invariant
   * that currently guards it. See `test/powerCache.cursor.ttl.test.js`.
   *
   * @private
   * @param {CacheNode} node - Node to unlink. Must currently be in the list.
   * @param {Object} [options]
   * @param {boolean} [options.advanceEvictionCandidate=false] - Also move the
   *   eviction cursor past the removed node.
   * @returns {CacheNode|null} The node that followed it, now at this position.
   */
  _unlinkNode(node, { advanceEvictionCandidate = false } = {}) {
    const next = node.next;
    this._map.delete(node.key);
    this._currentWeight -= node.weight || 0;
    // If a cursor pointed at the node being removed, step it past the gap.
    if (this._cleanupCursor === node) this._cleanupCursor = next;
    this._cleanupCursorValid = Boolean(this._cleanupCursor);
    if (advanceEvictionCandidate) this._evictionCandidate = next;
    this._remove(node);
    return next;
  }

  /**
   * Remove a node from the linked list without freeing it. The node's
   * `prev`/`next` references are updated on neighbors and the node's links
   * are nulled. Does not modify `this.map` or bookkeeping counters; callers
   * are responsible for those actions.
   *
   * @private
   * @param {CacheNode} node - Node to unlink from the list.
   * @returns {void}
   */
  _remove(node) {
    const p = node.prev,
      n = node.next;
    if (p) p.next = n;
    else this._head = n;
    // Keep eviction candidate aligned with the head when head changes
    if (!p) this._evictionCandidate = this._head;
    if (n) n.prev = p;
    else this._tail = p;
    if (this._probationEnd === node) this._probationEnd = p;
    node.prev = node.next = null;
  }

  /**
   * Move an existing node to the tail (mark as most-recently used).
   * Implemented as an unlink followed by an append. No-op when node is
   * already the tail.
   *
   * @private
   * @param {CacheNode} node - Node to promote to MRU position.
   * @returns {void}
   */
  _moveToTail(node) {
    if (this._policy === 'slru') {
      // A hit promotes the node out of probation into the protected MRU. This
      // must NOT go through `_append`, which would re-insert at the probation
      // boundary and undo the promotion.
      // The predecessor has to be captured *before* `_remove`, which nulls the
      // node's links, and before `node.prev` is repurposed for the tail splice.
      const wasProbationEnd = this._probationEnd === node;
      const prevProbation = node.prev;
      if (this._tail === node) {
        // Already at the tail. The early-out below would skip the promotion and
        // leave the boundary pointing at a node that is now protected, which
        // corrupts the segment order on the next insert. Close the probation
        // segment behind it instead.
        if (wasProbationEnd) this._probationEnd = prevProbation;
        return;
      }
      this._remove(node);
      node.prev = this._tail;
      node.next = null;
      if (this._tail) this._tail.next = node;
      this._tail = node;
      if (wasProbationEnd) this._probationEnd = prevProbation;
      return;
    }
    if (this._windowSize > 0) {
      // A hit in main space must refresh its recency *within main space*. Moving
      // it to the tail of the whole list would put it inside the window region
      // without being counted or flagged there, and the region and the counter
      // would stop describing the same set of nodes — the exact defect the
      // derived `_windowOldest()` exists to make impossible.
      if (!node.inWindow) {
        this._remove(node);
        this._insertAtMainSpaceMrU(node);
        return;
      }
      if (this._tail === node) return;
      this._remove(node);
      this._append(node);
      return;
    }
    if (this._tail === node) return;
    this._remove(node);
    this._append(node);
  }

  /**
   * The oldest node in the admission window, or `null` when the window is empty.
   *
   * Derived from the tail run of flagged nodes rather than maintained as a
   * pointer, and derived by *following the flag* rather than by walking back a
   * fixed number of steps. Both halves matter:
   *
   * - A pointer has to be updated by every mutation of the list. Every attempt
   *   that maintained one missed a mutation, and produced a counter reading
   *   negative some distance from the splice that caused it.
   * - A fixed walk of `windowSize` steps is only right while the window is
   *   **full**. A challenger that loses arbitration is dropped and the window is
   *   briefly one short, at which point the walk reaches past the boundary into
   *   main space: `main space, k-47, k-6, window` with the window's two
   *   survivors after it, which put a recency bump for `k-6` *behind* a key
   *   inserted fifty sets later and quietly destroyed the recency order of main
   *   space. The window is "the flagged run at the tail" at every fill level,
   *   and that is what this returns.
   *
   * The flag is the source of truth for _membership_ because it is set in
   * exactly one place (admission) and cleared in exactly one (promotion or
   * drop). List consistency against it is checked by `test/powerCache.window.test.js`,
   * which is the half this cannot verify on its own.
   *
   * @private
   * @returns {CacheNode|null}
   */
  _windowOldest() {
    let node = this._tail;
    if (!node || !node.inWindow) return null;
    while (node.prev && node.prev.inWindow) node = node.prev;
    return node;
  }

  /**
   * The eviction candidate in main space: the entry just below the window.
   *
   * `null` when the window holds the whole list, which is the cold-cache case
   * the note calls out: with no main space there is nothing to compare against,
   * and evicting a node against *itself* would remove it from `_map` and lose
   * it permanently.
   *
   * @private
   * @returns {CacheNode|null}
   */
  _windowVictim() {
    const oldest = this._windowOldest();
    if (!oldest || oldest === this._head) return null;
    return oldest.prev;
  }

  /**
   * Splice an unlinked node in at the MRU end of main space — immediately
   * before the window's oldest entry.
   *
   * This is the *one* splice that may place a node on the main-space side of
   * the boundary, and every path that leaves the window goes through it.
   * Appending to the tail instead is the error three separate implementations
   * made: it puts a main-space node back inside the window region, the region
   * and the counter stop describing the same set of nodes, and the visible
   * symptom is a counter bug some distance from its cause.
   *
   * Falls back to the tail when the window is empty (main space then runs to
   * the end of the list) and to a head fix when there is no main space at all.
   *
   * @private
   * @param {CacheNode} node - An unlinked node. Its links are overwritten.
   * @returns {void}
   */
  _insertAtMainSpaceMrU(node) {
    const windowStart = this._windowOldest();
    if (!windowStart) {
      node.prev = this._tail;
      node.next = null;
      if (this._tail) this._tail.next = node;
      else {
        this._head = node;
        this._evictionCandidate = node;
      }
      this._tail = node;
      return;
    }
    const prev = windowStart.prev;
    node.prev = prev;
    node.next = windowStart;
    if (prev) prev.next = node;
    else {
      this._head = node;
      // The head moved, so the eviction cursor has to move with it or the sweep
      // will start unlinking from a node that is no longer in the list.
      this._evictionCandidate = node;
    }
    windowStart.prev = node;
  }

  /**
   * Move a node out of the window and into main space, in front of the window.
   *
   * @private
   * @param {CacheNode} node - A linked window node.
   * @returns {void}
   */
  _promoteFromWindow(node) {
    this._remove(node);
    this._insertAtMainSpaceMrU(node);
    node.inWindow = false;
    this._windowStart = null;
  }

  /**
   * Evict one node, reporting it and returning it to the node pool.
   *
   * Single-node sibling of `_evictIfNeeded`, for the paths that displace a
   * specific victim rather than sweeping. Sharing the unlink/report/free
   * sequence is what keeps `onEvict` firing on every path — a window eviction
   * that skipped the callback would be invisible to every user cleanup and to
   * the pool's own node accounting.
   *
   * @private
   * @param {CacheNode} node
   * @returns {void}
   */
  _evictNode(node) {
    if (!node) return;
    const k = node.key;
    const v = node.value;
    this._unlinkNode(node, { advanceEvictionCandidate: true });
    this._evictions++;
    try {
      if (this.onEvict) this.onEvict(k, v, 'evicted');
    } catch (err) {
      this._notifyError(err, 'PowerCache onEvict callback threw');
    }
    this._freeNode(node);
  }

  /**
   * Admit a new key into the window, then arbitrate the window's oldest entry.
   *
   * Called after a new key has been appended at the tail. Once the window is
   * full, its oldest entry is the challenger: it either takes a place in main
   * space or is dropped, and which one is the only place the sketch arbitrates.
   *
   * Two rules here are not in the W-TinyLFU *description* and both were found
   * by attempting it (see `adr/0003-tinylfu-admission-window.md`):
   *
   * - **The challenger wins ties.** A tie means "no evidence either is better",
   *   and discarding the challenger discards the only evidence the filter has.
   *   Refusing ties is what made a fill-then-read caller lose every key written
   *   after the first few, because they all tie at estimate 1.
   * - **Only arbitrate at capacity.** While main space has room the filter has
   *   nothing to protect and a comparison has no signal — every fresh key sits
   *   at estimate 1, so every comparison is a tie and the churn evicts the
   *   entry the previous `set` just promoted. Measured: a 40-key warm ended with
   *   5 entries instead of 40. Caffeine's `admit` makes the same check.
   *
   * `previousSize` is the count **before** the arrival, and it has to be. A
   * cache filled to exactly `maxEntries` has been full the whole time the last
   * key was arriving; testing the count *after* the insert makes the final key
   * of every fill contend with a main-space victim it should have been promoted
   * past, which drops it. That is a 40-key warm ending at 39 — one key short,
   * no error, and invisible unless the test checks the count.
   *
   * @private
   * @param {number} previousSize - `this._map.size` before this arrival.
   * @returns {void}
   */
  _arbitrateWindow(previousSize) {
    if (this._map.size <= this._windowSize) return;
    const challenger = this._windowOldest();
    if (!challenger) return;
    const victim = this._windowVictim();
    // Rule 2b: "full" counts the window, because the window is admission slack
    // and not capacity on top of `maxEntries`. Excluding it makes a main-only
    // test read as never-full, admit every scan key, and churn through the
    // working set one key at a time.
    const atCapacity = victim != null && previousSize >= this.maxEntries;
    if (!atCapacity) {
      // Below capacity nothing is displaced — only the promotion happens. Doing
      // the eviction here too is what made a warm lose 35 of 40 keys: promoted,
      // then immediately evicted by the next arrival, forever.
      this._promoteFromWindow(challenger);
      return;
    }
    if (this._sketch.estimate(challenger.key) > this._sketch.estimate(victim.key)) {
      this._evictNode(victim);
      this._promoteFromWindow(challenger);
    } else {
      this._rejectedAdmission += 1;
      this._evictNode(challenger);
    }
  }

  /**
   * Evict nodes from the head (least-recently used) until the cache
   * satisfies both `maxEntries` and `maxWeight` constraints. For each
   * evicted node `onEvict` is invoked if provided and the node is returned
   * to the node pool via `_freeNode`.
   *
   * @private
   * @returns {void}
   */
  _evictIfNeeded() {
    // Use the eviction candidate pointer to avoid repeatedly reading `head` in
    // large eviction sweeps. Keep the candidate in sync with head mutations.
    while (this._map.size > this.maxEntries || this._currentWeight > this.maxWeight) {
      const node = this._evictionCandidate || this._head;
      if (!node) break;
      const k = node.key;
      const v = node.value;
      this._abortInflight(k, 'evicted');
      this._unlinkNode(node, { advanceEvictionCandidate: true });
      this._evictions++;
      try {
        if (this.onEvict) this.onEvict(k, v, 'evicted');
      } catch (err) {
        this._notifyError(err, 'PowerCache onEvict callback threw');
      }
      this._freeNode(node);
    }
    // Ensure eviction candidate remains aligned with current head after evictions
    if (!this._evictionCandidate) this._evictionCandidate = this._head;
  }

  /**
   * Normalise a caller-supplied TTL into the `expiresAt` this entry stores.
   *
   * The arithmetic used to be written out at each of `set`, `setMany` and
   * `touch`, and `now + ttl` on a non-number does **string concatenation** rather
   * than failing. With `now === 3000`, `{ ttl: 'abc' }` therefore stored
   * `expiresAt === '3000abc'`; every expiry test then compared a number against a
   * string, produced `NaN`, and `NaN > anything` is `false` — so the entry never
   * expired. A one-character typo in a config value silently disabled expiry,
   * which is the worst direction a cache has to fail in: it looks like the value
   * it was given, and memory grows until something else breaks.
   *
   * A numeric *string* is still accepted, because `'1000'` from an environment
   * variable is a reasonable thing to pass and rejecting it would be pedantry.
   * What is rejected is anything that does not name a duration — including
   * `{ ttl: [] }` and `{ ttl: true }`, which `Number()` would happily coerce to 0
   * and 1.
   *
   * @private
   * @param {number|string|null|undefined} ttl - Caller-supplied TTL in ms.
   * @param {number} now - The clock reading this expiry is relative to.
   * @returns {number} `0` for "no expiry", otherwise an absolute expiry.
   * @throws {TypeError} If `ttl` is neither nullish, `Infinity`, nor a finite
   *   number.
   */
  _expiresAt(ttl, now) {
    // `0` is the stored sentinel for "this entry has no expiry", and it is
    // deliberately *not* how a zero TTL is spelled: `{ ttl: 0 }` means expire now
    // and callers of that behaviour existed before this helper did. Nullish
    // short-circuits here so the two are told apart while the caller's intent is
    // still visible, rather than being conflated in a sentinel and reconstructed
    // at each call site.
    //
    // The *validation* now lives in `utils/options.js` as `normalizeTtl`,
    // because `PowerTTLMap` needs the identical rules and could not reach the
    // copy that lived here — `powerCache.js` exports nothing, so CACHE-003's fix
    // fixed one class of two. `PowerTTLMap.set(k, 1, 'abc')` stored an immortal
    // entry while this method throws for the same value. The nullish test stays
    // here because `normalizeTtl` reports "no expiry" as `0`, which is also what
    // a real `{ ttl: 0 }` resolves to, and the two mean opposite things.
    if (ttl == null || ttl === Infinity) return 0;
    return now + normalizeTtl(ttl, 'PowerCache');
  }

  /**
   * The oversize rejection, shared by `set` and `setMany`.
   *
   * Extracted because `setMany` used to carry its own copy of the insert path and
   * this check was the first thing it omitted: a 999-byte value written through
   * `set` was refused with `onEvict` reporting `'rejected-oversized'`, and the
   * same value written through `setMany` was admitted and then swept out by the
   * bulk eviction pass with the **wrong reason**, `'evicted'`. A caller watching
   * `onEvict` to count rejections — which is the only way to observe them, since
   * `setMany` returns `this` for chaining — was counting the wrong thing.
   *
   * @private
   * @param {*} key
   * @param {*} value
   * @param {number} w - Already-computed weight.
   * @returns {boolean} `true` when the insert was rejected and must be skipped.
   */
  _rejectIfOversized(key, value, w) {
    if (!this.rejectOversized || !Number.isFinite(this.maxWeight) || w <= this.maxWeight) {
      return false;
    }
    this._rejected++;
    try {
      if (this.onEvict) this.onEvict(key, value, 'rejected-oversized');
    } catch (err) {
      this._notifyError(err, 'PowerCache onEvict callback threw (rejected-oversized)');
    }
    return true;
  }

  /**
   * Insert a key that is not already present, applying the admission policy.
   *
   * Shared by `set` and `setMany` for the same reason as
   * {@link PowerCache#_rejectIfOversized}: `setMany` omitted the TinyLFU sketch
   * and the admission window entirely, so a bulk load was invisible to admission
   * — `sketch.estimate(key) === 0` for every key written that way, and a
   * frequency-driven filter cannot judge a key it has never seen.
   *
   * @private
   * @param {*} key
   * @param {*} value
   * @param {number} w - Already-computed weight.
   * @param {number} expiresAt - Already-computed absolute expiry.
   * @param {number} previousSize - `this._map.size` before this insert, which the
   *   window arbitration needs to tell "grew by one" from "replaced one".
   * @returns {boolean} `false` when the admission filter refused the key.
   */
  _insertNew(key, value, w, expiresAt, previousSize) {
    // **The window path.** A new key is admitted to the window unconditionally —
    // that is what makes the cold start stop collapsing, because a one-shot key
    // displaces the previous one-shot key inside the window rather than a
    // working-set entry in main space. The filter then arbitrates only the
    // window's oldest entry, which is a comparison between two established keys
    // rather than between a newcomer and a cold sketch.
    //
    // This has to be tested *before* the capacity check below, not after it. As an
    // `else if` it was unreachable exactly when it mattered: once the cache was
    // full, the old refuse-on-tie rule ran instead and every arrival was judged
    // against a single main-space victim, so the window never arbitrated and
    // nothing was ever evicted through it.
    if (this._sketch && this._windowSize > 0) {
      const node = this._allocNode(key, value, w, expiresAt);
      this._map.set(key, node);
      node.inWindow = true;
      this._append(node);
      this._currentWeight += node.weight || 0;
      this._arbitrateWindow(previousSize);
      // The sketch increment and the eviction pass are the caller's, shared with
      // the no-window path. Doing them here as well double-counted every key
      // that went through a window.
      return true;
    }
    // Admission, decided *before* the insert. An LRU evicts the coldest by
    // recency, which a one-off scan does not disturb: the scan's keys are the
    // *most* recent by definition, and it walks the working set straight out.
    // A frequency filter asks a different question - is the thing about to be
    // evicted still wanted - and refuses the insertion when the incumbent is
    // the better bet.
    //
    // Refusing here rather than inside the eviction sweep matters. An earlier
    // version returned from `_evictIfNeeded` to reject, which skipped the sweep
    // entirely and let the cache grow to 77 entries against a limit of 10.
    // Rejection is about *this key*, so it belongs at the insert. Only ever
    // consulted at capacity. A frequency filter compares the challenger's
    // popularity against the victim's, and a brand-new key's estimate is 0 - so
    // applying the rule below capacity refuses every insert after the first and
    // the cache can never fill. Measured: 200 insertions rejected, `size` 1.
    // Admission is about what to *displace*, so it needs something to displace.
    if (this._sketch && this._map.size >= this.maxEntries) {
      const incumbent = this._evictionCandidate || this._head;
      // A brand-new key is **refused whenever the incumbent's estimate is greater
      // than or equal to its own**, and a brand-new key's estimate is 0. In a
      // cold sketch every estimate is 0, so `0 >= 0` holds and the key is refused.
      // Read that against the comment this block used to carry, which claimed a
      // first-seen key was "admitted unconditionally ... the TinyLFU admission
      // window in its simplest form". That was false, and so was the rest of it,
      // which simultaneously asserted that "only a *strictly* hotter incumbent
      // may refuse" (which would need `>`) and that "`>=`, so a tie keeps the
      // incumbent" (which is what the code does, and which refuses the
      // challenger).
      //
      // **This is a known defect, and the refusal rule above is why
      // `admission: 'tinylfu'` currently underperforms plain LRU.** Measured on
      // the paired Zipf + scan workload in `bench/claims.js` (`node bench/claims.js
      // zipf`): on a cold 40-entry cache preceded by a 460-key scan burst the
      // working-set hit rate is 2.5% against plain LRU's 66.4%, because the scan
      // keys fill the cache while it is still below capacity and the working set
      // is then refused every time. On a sustained Zipf mix, working-set
      // retention is 15.4/40 against LRU's 17.2/40, with the worst hot keys
      // sitting at estimate 0 - and a key at 0 can never re-enter. The release note
      // for this option has been withdrawn; the measurements live in `review.md`
      // under BENCH-002.
      //
      // **The fix is not a comparison operator.** Changing `>=` to `>` admits the
      // challenger on every tie, which lets a scan walk the working set - the
      // exact failure this filter exists to prevent. The correct mechanism is
      // W-TinyLFU's admission *window*: a small region at the MRU end that
      // accepts new keys unconditionally, so scan traffic is absorbed there and
      // the frequency filter arbitrates only that window's victim against a
      // main-space victim. That needs a size choice, its own interaction rules
      // with `policy: 'slru'` (which currently makes `tinylfu` *worse*), and its
      // own tests.
      //
      // The sketch itself is sound: `test/smallLfu.test.js` asserts at a
      // production-shaped half-life that a recurring key outranks a one-shot one
      // on every key, so do not "fix" this by re-tuning the sketch.
      const challenger = this._sketch.estimate(key);
      if (incumbent && this._sketch.estimate(incumbent.key) >= challenger) {
        this._rejectedAdmission += 1;
        return false;
      }
    }
    const node = this._allocNode(key, value, w, expiresAt);
    this._map.set(key, node);
    this._append(node);
    this._currentWeight += node.weight || 0;
    return true;
  }

  /**
   * Set a value in the cache (add or update).
   * Marks the entry as most-recently used.
   * If `rejectOversized` is enabled and the computed/explicit weight exceeds `maxWeight`,
   * the insertion will be rejected and `set` returns `false` (otherwise returns `this`).
   * @param {*} key - Cache key
   * @param {*} value - Value to store
   * @param {Object} [options]
   * @param {number} [options.ttl] - Time-to-live in ms. Use `null` or `Infinity` to disable expiration.
   * @param {number} [options.weight] - Optional explicit weight for the entry. If omitted, `weightFn` is used.
   * @returns {this|false} `this` on success, or `false` when insertion was rejected due to oversize.
   */
  set(key, value, { ttl = this.defaultTTL, weight = null } = {}) {
    const now = this._now();
    const expiresAt = this._expiresAt(ttl, now);
    // Compute weight once and validate it before mutating bookkeeping.
    const w = this._computeWeight(value, weight);
    if (this._rejectIfOversized(key, value, w)) return false;

    if (this._map.has(key)) {
      this._updateExisting(key, value, w, expiresAt);
    } else if (!this._insertNew(key, value, w, expiresAt, this._map.size)) {
      // Refused by the admission filter. The key is deliberately *not*
      // recorded in the sketch: it did not reach the cache, and counting a
      // refusal would let a scan inflate its own estimate by being refused.
      return this;
    }
    // The key is recorded even when the insert was admitted, so the sketch
    // reflects attempted demand rather than only what survived.
    this._sketch?.increment(key);
    this._evictIfNeeded();
    return this;
  }

  /**
   * Overwrite an entry that is already in the cache.
   *
   * Shared by `set` and `setMany`. Split out for the same reason as the insert
   * path above: `setMany` had its own copy of this arithmetic too, so the two
   * had already drifted on the TTL and on admission before the weight bookkeeping
   * was checked.
   *
   * @private
   * @param {*} key
   * @param {*} value
   * @param {number} w - Already-computed weight.
   * @param {number} expiresAt - Already-computed absolute expiry.
   * @returns {void}
   */
  _updateExisting(key, value, w, expiresAt) {
    const node = this._map.get(key);
    this._currentWeight -= node.weight || 0;
    node.value = value;
    node.weight = w;
    node.expiresAt = expiresAt;
    this._currentWeight += node.weight || 0;
    this._moveToTail(node);
  }

  /**
   * Retrieve a value and mark it as recently used.
   * @param {*} key
   * @returns {*|undefined} The stored value or `undefined` if missing/expired.
   */
  get(key) {
    const node = this._fetchValidNode(key, { countMiss: true });
    if (!node) return undefined;
    this._moveToTail(node);
    this._hits++;
    // A hit is the strongest frequency evidence there is, and TinyLFU is
    // frequency-driven: without this the sketch only ever sees writes, so a
    // read-mostly cache would admit one-off writes on the strength of a
    // history it never had.
    this._sketch?.increment(key);
    return node.value;
  }

  /**
   * Get a value without updating recency.
   * Returns `undefined` for missing or expired entries.
   * @param {*} key
   * @returns {*|undefined}
   */
  peek(key) {
    const node = this._fetchValidNode(key);
    return node ? node.value : undefined;
  }

  /**
   * Check membership without affecting recency.
   * @param {*} key
   * @param {Object} [options]
   * @param {boolean} [options.ignoreExpiry=false] If true, consider expired entries as present.
   * @returns {boolean}
   */
  has(key, { ignoreExpiry = false } = {}) {
    return Boolean(this._fetchValidNode(key, { ignoreExpiry }));
  }

  /**
   * `getOrSetAsync` using the cache's `fetchMethod` when no per-call factory is
   * given.
   *
   * The reason this exists rather than as a required argument: the row's shape
   * (`fetchMethod` on the instance) removes a function literal from **every**
   * call site, which is most of the cost of the async cache API in a hot path.
   * The per-call factory still wins, so one caller can override a cache-wide
   * default — a cache is often keyed by more than one kind of resource.
   *
   * @param {*} key
   * @param {Function} [factory] Overrides the cache's `fetchMethod`.
   * @param {PowerCacheGetOrFetchOptions} [options] Passed through to `getOrSetAsync`.
   * @returns {Promise<*>}
   */
  getOrFetch(key, factory, options = {}) {
    const fn = factory ?? this.fetchMethod;
    if (typeof fn !== 'function') {
      return Promise.reject(
        new TypeError('PowerCache.getOrFetch: no factory given and no `fetchMethod` configured')
      );
    }
    return this.getOrSetAsync(key, fn, options);
  }

  /**
   * Atomically read-or-compute a value for `key`.
   * If the key is present and not expired the stored value is returned.
   * Otherwise `factory` is invoked to produce the value which is stored
   * in the cache and returned. `factory` may be a value (in which case it
   * is stored directly) or a function. If the function returns a Promise,
   * the Promise is returned and the resolved value is stored when it settles.
   *
   * Note: this method does not deduplicate concurrent async factories —
   * for async factories prefer `getOrSetAsync` or use
   * `PowerMemoizer` for inflight deduplication.
   *
   * @param {*} key
   * @param {Function|*} factory - Function that produces the value or a direct value.
   * @param {Object} [options]
   * @param {number} [options.ttl]
   * @param {number} [options.weight]
   * @param {boolean} [options.staleWhileRevalidate=false] If true, return an expired value immediately and refresh the cache in the background.
   * @returns {*|Promise<*>}
   */

  getOrSet(
    key,
    factory,
    { ttl = undefined, weight = undefined, staleWhileRevalidate = this.allowStale } = {}
  ) {
    const now = this._now();
    const node = this._fetchValidNode(key, {
      countMiss: false,
      allowExpired: staleWhileRevalidate,
    });

    if (node) {
      if (node.expiresAt && node.expiresAt <= now) {
        // Expired. Servable only inside the stale window — this is the branch
        // that used to return the value unconditionally.
        if (typeof factory === 'function' && this._staleServable(node, now)) {
          this._moveToTail(node);
          this._hits++;
          this._staleServes++;
          this._refreshStaleEntry(key, factory, { ttl, weight });
          return node.value;
        }
        this._removeExpiredNode(node, now);
        this._misses++;
      } else {
        this._moveToTail(node);
        this._hits++;
        return node.value;
      }
    } else {
      this._misses++;
    }

    // Compute and store
    if (typeof factory === 'function') {
      const res = factory();
      if (typeof res?.then === 'function') {
        return res.then((value) => {
          try {
            this.set(key, value, { ttl, weight });
          } catch (err) {
            this._notifyError(err, 'PowerCache: storing an async value threw');
          }
          return value;
        });
      }
      this.set(key, res, { ttl, weight });
      return res;
    }

    // factory is a direct value
    this.set(key, factory, { ttl, weight });
    return factory;
  }

  /**
   * Bulk set multiple entries. Accepts an iterable/array of [key, value] pairs.
   * Computes weight once per value and applies a single eviction pass at the end.
   *
   * The per-entry decisions are `set`'s, not a second set of them: oversize
   * rejection, the TinyLFU sketch and the admission window are all applied here.
   * `setMany` used to insert through a simplified path that did none of the
   * three, so a bulk load was invisible to admission and a rejected value came
   * back out of the bulk eviction pass wearing the wrong `onEvict` reason.
   *
   * **It still returns `this`, not `false`, when a value is rejected** — that is
   * its documented contract for chaining, and changing it would be a breaking API
   * change for a batch of a thousand entries. The signal is `onEvict` with
   * `'rejected-oversized'`, and `stats().rejected` afterwards. `set` returns
   * `false` because it can.
   *
   * @param {Iterable<[*,*]>} entries
   * @param {Object} [options]
   * @param {number} [options.ttl]
   * @param {number} [options.weight]
   * @returns {this}
   */
  setMany(entries, { ttl = undefined, weight = undefined } = {}) {
    const now = this._now();
    const expiresAt = this._expiresAt(ttl, now);
    for (const pair of entries) {
      if (!pair) continue;
      const [key, value] = pair;
      const w = this._computeWeight(value, weight);
      if (this._rejectIfOversized(key, value, w)) continue;

      if (this._map.has(key)) {
        this._updateExisting(key, value, w, expiresAt);
      } else if (!this._insertNew(key, value, w, expiresAt, this._map.size)) {
        continue;
      }
      this._sketch?.increment(key);
    }
    // One eviction pass for the whole batch, which is the point of `setMany` and
    // the reason it does not simply loop over `set`: an N-entry load would
    // otherwise walk the eviction list N times.
    this._evictIfNeeded();
    return this;
  }

  /**
   * Bulk get multiple keys. Returns a Map of found entries.
   * @param {Iterable<*>} keys
   * @param {Object} [options]
   * @param {boolean} [options.ignoreExpiry=false]
   * @returns {Map<string, *>} One entry per resolved key, in input order.
   */
  getMany(keys, { ignoreExpiry = false } = {}) {
    const res = new Map();
    for (const key of keys) {
      const node = this._fetchValidNode(key, { ignoreExpiry, countMiss: true });
      if (!node) continue;
      this._moveToTail(node);
      this._hits++;
      res.set(key, node.value);
    }
    return res;
  }

  /**
   * Touch an entry: update its recency and optionally refresh TTL without
   * reading or modifying the stored value.
   * @param {*} key
   * @param {number} [ttl] - Optional per-call TTL in ms. Use `null`/`Infinity` to disable expiry.
   * @returns {boolean} True if the entry existed (and was not expired), false otherwise.
   */
  touch(key, ttl = undefined) {
    const node = this._fetchValidNode(key);
    if (!node) return false;
    const now = this._now();
    if (ttl !== undefined) {
      node.expiresAt = this._expiresAt(ttl, now);
    }
    this._moveToTail(node);
    return true;
  }

  /**
   * Async read-or-compute with inflight deduplication.
   * If a factory is already running for `key`, returns the same Promise.
   * Otherwise invokes `asyncFactory` and stores the resolved value in cache.
   * @param {*} key
   * @param {Function} asyncFactory - Function returning a Promise or value.
   * @param {Object} [options]
   * @param {number} [options.ttl]
   * @param {number} [options.weight]
   * @param {boolean} [options.staleWhileRevalidate=false] If true, return an expired value immediately and refresh the cache in the background.
   * @param {number} [options.timeout] Per-call override of the cache's `defaultAsyncTimeout`, in ms.
   * @returns {Promise<*>}
   */
  getOrSetAsync(
    key,
    asyncFactory,
    {
      ttl = undefined,
      weight = undefined,
      staleWhileRevalidate = this.allowStale,
      timeout = undefined,
    } = {}
  ) {
    if (typeof asyncFactory !== 'function') {
      // treat non-function as direct value
      return Promise.resolve(this.getOrSet(key, asyncFactory, { ttl, weight }));
    }

    const now = this._now();
    const node = this._map.get(key);
    if (node) {
      if (node.expiresAt && node.expiresAt <= now) {
        // Bounded, for the same reason and with the same predicate as
        // `getOrSet`. Before it, this branch returned the value with no upper
        // bound on how long "stale" could mean — measured at five years.
        if (staleWhileRevalidate && this._staleServable(node, now)) {
          this._moveToTail(node);
          this._hits++;
          this._staleServes++;
          this._refreshStaleEntry(key, asyncFactory, { ttl, weight });
          return Promise.resolve(node.value);
        }
        // expired: remove and proceed to compute; count the miss once below.
        this._removeExpiredNode(node, now);
      } else {
        this._moveToTail(node);
        this._hits++;
        return Promise.resolve(node.value);
      }
    }

    // If a factory is already in-flight for this key, return it (not a cache miss)
    if (this._inflightPromises.has(key)) return this._inflightPromises.get(key);

    // No cached node and no inflight factory: count as a miss and invoke factory
    this._misses++;

    // Invoke and normalize result to a Promise. The factory receives the
    // signal; one written before this takes no argument and is unaffected.
    const controller = new AbortController();
    let p;
    try {
      p = Promise.resolve().then(() => asyncFactory(controller.signal));
    } catch (err) {
      return Promise.reject(err);
    }

    // Determine effective timeout: per-call `timeout` overrides cache default
    const effectiveTimeout = Number.isFinite(Number(timeout))
      ? Math.max(0, Math.floor(Number(timeout)))
      : Number.isFinite(Number(this._defaultAsyncTimeout))
        ? this._defaultAsyncTimeout
        : undefined;

    // Wrap with a timeout race when requested
    let timed = p;
    if (Number.isFinite(effectiveTimeout) && effectiveTimeout > 0) {
      let timer = null;
      timed = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            reject(new Error('getOrSetAsync timeout'));
          } catch (e) {
            /* ignore */
          }
        }, effectiveTimeout);
        p.then(
          (v) => {
            try {
              clearTimeout(timer);
            } catch (e) {
              this._notifyError(e, 'PowerCache: clearTimeout threw');
            }
            resolve(v);
          },
          (err) => {
            try {
              clearTimeout(timer);
            } catch (e) {
              this._notifyError(e, 'PowerCache: clearTimeout threw');
            }
            reject(err);
          }
        );
      });
    }

    // Store in inflight map to dedupe concurrent callers.
    //
    // The cache write is deliberately attached to the *factory* promise `p`
    // rather than to `timed` (the timeout race). `timed` rejects as soon as
    // the client's timeout elapses, so a successful-but-late factory result
    // was thrown away and the next caller had to pay the full cost again.
    // Writing on `p` keeps the expensive computation, while `tracked` (what
    // the caller awaits) still settles on the timeout. Only *fulfilments* are
    // cached, so a factory rejection is never cached.
    p.then(
      (value) => {
        try {
          this.set(key, value, { ttl, weight });
        } catch (err) {
          this._notifyError(err, 'PowerCache getOrSetAsync: storing a late value threw');
        }
      },
      () => {
        /* factory rejected: nothing to cache */
      }
    );

    // Releasing the slot at the **timeout**, and signalling the factory at the
    // same moment, is one decision rather than two.
    //
    // Holding the slot until the factory settles closes the F-09 duplicate and
    // leaks: a factory that never settles - `() => new Promise(() => {})`,
    // which `powerCache.timeout.test.js` uses twice - would hold its slot
    // forever, so the key could never fetch again and every entry accumulated
    // one Map row per hanging factory. A duplicate costs compute; a permanent
    // slot is a memory leak *and* a permanently broken key, so the release stays
    // here and the signal is what stops the work.
    //
    // A joining caller still dedupes against the running factory, and receives
    // the value rather than the previous caller's rejection: it awaits
    // `_inflightPromises`, which holds the factory's own promise, not the
    // timeout race.
    const tracked = timed.finally(() => {
      // **Abort before dropping the controller.** The first version deleted
      // `_inflightControllers` first and then called `_abortInflight`, which
      // looks up the controller it had just removed - so the timeout never
      // signalled anything. Caught by a probe that checked `signal.aborted`
      // rather than by the suite, because nothing asserted on it yet.
      this._abortInflight(key, 'timed out');
      this._inflightPromises.delete(key);
      this._inflightControllers.delete(key);
    });

    this._inflightPromises.set(key, p);
    this._inflightControllers.set(key, controller);
    return tracked;
  }

  /**
   * Check membership without affecting recency and verify the stored value is deep-equal
   * to the provided `value`.
   *
   * Optimizations:
   * - Fast reference equality short-circuit
   * - Fast primitive checks
   * - Special-cases for Arrays, TypedArrays/ArrayBuffer, Date, RegExp, Map and Set
   * - WeakMap/WeakSet-based cycle detection
   *
   * @param {*} key
   * @param {*} value
   * @param {Object} [options]
   * @param {boolean} [options.ignoreExpiry=false] If true, consider expired entries as present.
   * @returns {boolean}
   */
  hasEqual(key, value, options = {}) {
    const { ignoreExpiry = false, maxNodes, compareFn } = options || {};
    const node = this._fetchValidNode(key, { ignoreExpiry });
    if (!node) return false;
    const stored = node.value;
    // Fast reference equality
    if (stored === value) return true;

    // Fast primitive check
    const tStored = typeof stored;
    const tIncoming = typeof value;
    if (tStored !== 'object' || stored === null || tIncoming !== 'object' || value === null) {
      return stored === value;
    }

    // Delegate to module-level deep equality helper to avoid allocating a
    // new closure on every call. The deepEqual helper will handle cycles.
    //
    // The comparison state is built from an **allowlist**, not by spreading the
    // caller's options bag. `makeState` reads `seen` off whatever it is given,
    // so `{ ...options }` kept the removed `seen` option alive: a caller
    // passing one still got a stale pair short-circuiting to `true` without
    // any comparison, which is the whole hazard. An allowlist means a removed
    // option cannot be reintroduced by a caller who never updated.
    //
    // `seen` is deliberately not caller-suppliable. It answers "have I already
    // compared this exact pair *in this walk*?" by short-circuiting to `true`,
    // which is correct for a cycle and wrong for a stale pair: reused across
    // two calls, the second returned `true` for a pair a previous, unrelated
    // call had recorded. Since the stored value is mutable, that is reachable
    // in ordinary code, and the failure mode is a cache reporting a hit for a
    // value that is not in it. The allocation it avoided was one `WeakMap`,
    // created only when the walk actually reaches object comparison — the
    // primitive, reference-equality and typed-array fast paths above all return
    // before touching it.
    return deepEqual(stored, value, makeState({ maxNodes, compareFn }));
  }

  /**
   * Delete an entry from the cache.
   * @param {*} key
   * @returns {boolean} true if the key was removed.
   */
  delete(key) {
    this._abortInflight(key, 'deleted');
    const node = this._map.get(key);
    if (!node) return false;
    this._unlinkNode(node);
    try {
      if (this.onEvict) this.onEvict(node.key, node.value, 'deleted');
    } catch (err) {
      this._notifyError(err, 'PowerCache onEvict callback threw (deleted)');
    }
    this._freeNode(node);
    return true;
  }

  /**
   * Clear the cache and return nodes to the pool.
   * @returns {void}
   */
  clear() {
    // Abort every outstanding fetch, including one whose key has no node yet -
    // the node sweep below cannot, because a key mid-fetch is not resident and
    // `clear()` does not go through `delete()`. Wired without this, `clear()`
    // aborted nothing at all.
    for (const key of [...this._inflightPromises.keys()]) this._abortInflight(key, 'cleared');
    for (let node = this._head; node;) {
      const next = node.next;
      this._freeNode(node);
      node = next;
    }
    this._head = this._tail = null;
    this._map.clear();
    // The frequency history goes with the entries. Carrying it across a clear
    // would let the next admission decisions be made from a workload that no
    // longer exists.
    this._sketch?.clear();
    this._rejectedAdmission = 0;
    this._currentWeight = 0;
    this._cleanupCursor = null;
    this._cleanupCursorValid = false;
    this._evictionCandidate = null;
    this._probationEnd = null;
    // Abandon in-flight dedupe entries. They cannot be cancelled (JS cannot
    // interrupt a running factory), but dropping the map means a `getOrSetAsync`
    // started *after* the clear is not deduped into a pre-clear request, and
    // `stats().inflight` stops reporting work the caller has discarded.
    // The `p.then(...)` late-write hook deliberately still populates the cache
    // with a value computed before the clear, which is the useful behaviour.
    this._inflightPromises.clear();
  }

  /**
   * Remove expired entries by scanning from least-recently used to most.
   * @returns {void}
   */
  cleanupExpired() {
    // Backwards-compatible: allow optional scan limit
    return this.cleanupExpiredUpTo();
  }

  /**
   * Cleanup expired entries, scanning up to `maxScan` nodes.
   * Scanning resumes from an internal cursor so repeated small passes will cover the list
   * without repeatedly scanning the head of a very large cache. When the end is reached the
   * cursor wraps to the head.
   * @param {number} [maxScan=Infinity] Maximum nodes to scan in this pass.
   * @returns {number} Number of nodes scanned
   */
  cleanupExpiredUpTo(maxScan = Infinity) {
    const now = this._now();
    let scanned = 0;
    // Resume from the previous cursor when possible to avoid re-scanning from head.
    // `_cleanupCursorValid` is toggled by mutation paths that affect the cursor,
    // avoiding an expensive `Map.get()` on every scan.
    let node = this._cleanupCursor && this._cleanupCursorValid ? this._cleanupCursor : this._head;
    while (node && scanned < maxScan) {
      const next = node.next;
      if (node.expiresAt && node.expiresAt <= now) {
        const k = node.key;
        const v = node.value;
        this._unlinkNode(node);
        try {
          if (this.onExpire) this.onExpire(k, v);
        } catch (err) {
          this._notifyError(err, 'PowerCache onExpire callback threw');
        }
        this._freeNode(node);
        this._expirations++;
      }
      node = next;
      scanned++;
    }
    // resume from where we left off; if we've reached the end, wrap to head
    this._cleanupCursor = node || this._head;
    this._cleanupCursorValid = Boolean(this._cleanupCursor);
    return scanned;
  }

  /**
   * Start periodic, non-blocking cleanup.
   * Accepts either a numeric interval (ms) or an options object `{ interval, maxCleanupPerTick }`.
   * The loop is implemented with `setTimeout` and scans up to `maxCleanupPerTick` nodes per pass
   * to avoid long event-loop stalls.
   * Note: call `stopCleanup()` to stop the periodic timer (for example, on application shutdown)
   * to ensure the internal timer is cleared and resources can be reclaimed.
   * @param {number|Object} [intervalOrOptions] - Cleanup interval in ms, or an
   *   options object `{ interval, maxCleanupPerTick }`. The nested tags were
   *   removed because a qualified `@param` is only valid when the parent is a
   *   bare `{Object}`; against `number|Object` it is rejected with TS8032.
   * @returns {void}
   */
  startCleanup(intervalOrOptions = {}) {
    let interval, maxCleanupPerTick;
    if (typeof intervalOrOptions === 'number') {
      interval = intervalOrOptions;
      maxCleanupPerTick = this.maxCleanupPerTick;
    } else {
      // `intervalMs` is accepted as an alias for `interval`, because it is the
      // spelling roughly fifteen other options in this library use and a caller
      // reaching for the obvious name had it accepted and dropped — the one
      // argument shape `startCleanup` silently ignored.
      const requestedInterval = intervalOrOptions.interval ?? intervalOrOptions.intervalMs;
      interval = Number.isFinite(+requestedInterval)
        ? +requestedInterval
        : Math.max(
            MS_PER_SEC,
            Math.min(this.defaultTTL || DEFAULT_CACHE_DEFAULT_TTL_MS, DEFAULT_CACHE_DEFAULT_TTL_MS)
          );
      maxCleanupPerTick = Number.isFinite(+intervalOrOptions.maxCleanupPerTick)
        ? Math.max(1, +intervalOrOptions.maxCleanupPerTick)
        : this.maxCleanupPerTick;
    }
    this.stopCleanup();
    this._cleanupParams = { interval, maxCleanupPerTick };
    // start loop using prototype cleanup tick method
    this._cleanupTimer = setSafeTimeout(() => this._cleanupTick(), interval);
  }

  /**
   * Stop periodic cleanup.
   * @returns {void}
   */
  stopCleanup() {
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._cleanupRunning = false;
    this._cleanupParams = null;
  }

  /**
   * Synchronous disposal hook (TC39 Explicit Resource Management).
   * Stops any background cleanup and clears the cache.
   */

  /**
   * Named alias for the `Symbol.dispose` implementation, so callers who do not
   * want to reach for the symbol still have something to call.
   * @returns {void}
   */
  dispose() {
    this[Symbol.dispose]();
  }

  [Symbol.dispose]() {
    // The detach lives **here**, not in `dispose()`. `using cache = …` and
    // `await using` call the symbol and nothing else, so a detach that only
    // `dispose()` performed left the series registered for the life of the
    // collector — sampling an object nobody can reach, which answers every time
    // and so fails nothing. `PowerBulkhead` and `PowerRetryBudget` had already
    // been fixed for exactly this, and `using` is the teardown path the
    // guarantee is about: a scope exit.
    detach(this._metrics);
    this._metrics = null;
    try {
      this.stopCleanup();
    } catch (e) {
      /* ignore */
    }
    try {
      this.clear();
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Asynchronous disposal hook. Provided for symmetry with `using`/`await using`.
   * Cache cleanup is synchronous so this simply performs the same actions and
   * returns a resolved Promise for await compatibility.
   */
  async [Symbol.asyncDispose]() {
    try {
      this.stopCleanup();
    } catch (e) {
      /* ignore */
    }
    try {
      this.clear();
    } catch (e) {
      /* ignore */
    }
    return;
  }

  /**
   * Prototype tick used by the cleanup timer loop. Separated to avoid
   * allocating a per-call closure inside `startCleanup()`.
   * @private
   */
  _cleanupTick() {
    if (this._cleanupTimer == null) return; // stopped
    if (this._cleanupRunning) {
      // schedule next run
      this._cleanupTimer = setSafeTimeout(() => this._cleanupTick(), this._cleanupParams.interval);
      return;
    }
    this._cleanupRunning = true;
    try {
      this.cleanupExpiredUpTo(this._cleanupParams.maxCleanupPerTick);
    } finally {
      this._cleanupRunning = false;
    }
    this._cleanupTimer = setSafeTimeout(() => this._cleanupTick(), this._cleanupParams.interval);
  }

  /**
   * Current number of entries in cache.
   * @returns {number}
   */
  get size() {
    return this._map.size;
  }

  /**
   * Hit rate as a fraction (hits / (hits + misses)).
   * @returns {number}
   */
  get hitRate() {
    const total = (this._hits || 0) + (this._misses || 0);
    return total ? this._hits / total : 0;
  }

  /**
   * Return runtime statistics for the cache.
   * @returns {{size:number, weight:number, hits:number, misses:number, staleServes:number,
   *   evictions:number, expirations:number, rejected:number, poolSize:number}}
   */
  stats() {
    return {
      size: this.size,
      weight: this._currentWeight,
      hits: this._hits,
      misses: this._misses,
      // A subset of `hits`, not an addition to it.
      staleServes: this._staleServes,
      evictions: this._evictions,
      expirations: this._expirations,
      rejected: this._rejected,
      poolSize: this._pool.length,
    };
  }

  /**
   * Alias for {@link stats}, so a caller who learned `getStats()` from
   * `PowerPool` — the one class that has always spelled it this way — is not
   * handed `TypeError: x.getStats is not a function` here.
   *
   * Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
   * `getStats()`, with no stated rule and nothing pinning it, which reached the
   * documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
   * spellings work everywhere now. `stats()` is canonical and this delegates to
   * it; `PowerPool` keeps `getStats` because renaming the largest surface in the
   * library would be a breaking change.
   *
   * Written out per class rather than installed on the prototype on purpose: a
   * dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
   * `types/` omitted it and a TypeScript caller got a type error on a method
   * that worked at runtime. That was the first implementation.
   *
   * **No `@returns` tag, and that is load-bearing.** The first version carried a
   * hand-copied copy of the `stats()` return shape, on the reasoning that an
   * explicit type was safer. It is not: the copy went stale the moment a
   * concurrent change added `staleServes` and `expirations` to `PowerCache`
   * `.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
   * byte-identical published type and cannot drift, because there is nothing to
   * keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
   * which is the property a consumer relies on.
   */
  getStats() {
    return this.stats();
  }

  /**
   * Resize the cache limits and evict if necessary.
   * @param {Object} options
   * @param {number} [options.maxEntries]
   * @param {number} [options.maxWeight]
   */
  resize({ maxEntries, maxWeight } = {}) {
    if (Number.isFinite(+maxEntries)) this.maxEntries = Math.max(0, +maxEntries);
    if (Number.isFinite(+maxWeight)) this.maxWeight = Math.max(0, +maxWeight);
    // Mutations that trigger bulk evictions can invalidate the incremental
    // cleanup cursor used by `cleanupExpiredUpTo`. Reset the cursor so
    // subsequent incremental scans start from a known-good head node.
    this._evictIfNeeded();
    this._cleanupCursor = null;
    this._cleanupCursorValid = false;
    // Eviction candidate should align with the (possibly new) head. `head` is an
    // alias onto `_head` (see `ALIASED_FIELDS`), so this is the head node.
    //
    // An earlier version of this comment claimed `this.head` was a typo and that
    // the assignment stored `undefined`. It was not: `head` is one of ten
    // `Object.defineProperty` accessors, and `cache.head === cache._head`. The
    // claim was wrong, and the reordering that came with it changed no
    // observable behaviour — see the note on `_unlinkNode` and `review.md`'s
    // CACHE-001, which records this whole area as unreproducible. The reset runs
    // after `_evictIfNeeded()` because that is where the head can change.
    this._evictionCandidate = this.head;
  }

  /**
   * Iterate entries in LRU or MRU order.
   *
   * **Mutating the cache from inside the loop is supported, and the walk reads
   * the next link *before* each `yield` rather than after.** A walk that advanced
   * after the resume was silently cut short by any mutation of the node the
   * iterator was standing on, because `_remove` nulls both links on the node it
   * removes — so `for (const [k] of cache.entries()) cache.delete(k)`, the most
   * natural way to write "empty this cache", removed exactly one entry and left
   * the rest, while `size` reported the truth afterwards so nothing raised.
   * `cleanupExpired()` called from inside the loop was worse, because a caller
   * has no reason to know that calling a public maintenance method is a
   * mutation: a bulk export that swept each turn silently exported nothing.
   *
   * The contract, since a live iterator that can skip is only a legitimate
   * choice when it is a stated one:
   *
   * - Removing the entry currently being visited continues at the next one.
   * - Removing an entry not yet visited skips it (it is gone), and the walk
   *   completes.
   * - Entries *added* during the walk are not visited: the walk started at the
   *   then-tail, and inserting an entry moves the tail out from under it.
   * - Removing two *adjacent* entries in one iteration step may end the walk
   *   early. That is the one residual loss, it needs two removals before a
   *   single resume, and closing it would mean snapshotting the walk into an
   *   array — an allocation on every call to a bulk-export API.
   *
   * @param {'LRU'|'MRU'} [order='MRU']
   * @returns {IterableIterator<[*,*]>}
   */
  *entries(order = 'MRU') {
    const link = order === 'MRU' ? 'prev' : 'next';
    let node = order === 'MRU' ? this._tail : this._head;
    while (node) {
      // Read the continuation before handing control to the caller: the node we
      // are standing on may be removed while the loop body runs, and `_remove`
      // nulls both of its links on the way out.
      const next = node[link];
      yield [node.key, node.value];
      if (!isLinked(node, this._head, this._tail)) {
        // The node just yielded was removed. Its captured successor was not
        // touched by that removal, so it is still the right place to resume — or
        // the walk is genuinely over if the end of the list was reached.
        node = isLinked(next, this._head, this._tail) ? next : null;
      } else if (isLinked(next, this._head, this._tail)) {
        node = next;
      } else {
        // The successor was removed before we reached it, so it is skipped. The
        // removal repaired *our* link past it, so re-reading it is how the walk
        // steps over the hole rather than stopping on it.
        node = node[link];
      }
    }
  }

  [Symbol.iterator]() {
    return this.entries('MRU');
  }

  /**
   * Iterate keys in LRU or MRU order.
   * @param {'LRU'|'MRU'} [order='MRU']
   */
  *keys(order = 'MRU') {
    for (const [k] of this.entries(order)) yield k;
  }

  /**
   * Iterate values in LRU or MRU order.
   * @param {'LRU'|'MRU'} [order='MRU']
   */
  *values(order = 'MRU') {
    for (const [, v] of this.entries(order)) yield v;
  }
}

/**
 * Whether `node` is still a member of the cache's linked list.
 *
 * Liveness cannot be read off the links alone. A lone entry has `prev` and
 * `next` both `null` and is still in the list, and a removed entry has both
 * `null` and is not — the same shape. The tie is broken by the ends: `_remove`
 * moves `_head` and `_tail` past the node it removes, so a removed node is
 * never either, while a lone entry is both.
 *
 * Module scope rather than a method because it needs no instance state beyond
 * the two ends it is handed, and because `PowerCache` is on the hot path of
 * every helper in the library that caches anything.
 *
 * @private
 * @param {CacheNode|null} node
 * @param {CacheNode|null} head
 * @param {CacheNode|null} tail
 * @returns {boolean}
 */
function isLinked(node, head, tail) {
  if (!node) return false;
  return node.prev !== null || node.next !== null || node === head || node === tail;
}

/**
 * Deep equality check for cache values. Extracted to module scope to avoid
 * allocating a new closure on each call to `hasEqual`.
 * Uses a WeakMap-of-WeakSet for cycle detection and enforces a recursion
 * depth limit to protect against pathological cyclic structures causing
 * stack blowups. When the depth limit is exceeded we fall back to reference
 * equality (i.e. return `a === b`).
 * @private
 * @param {*} a
 * @param {*} b
 * @param {*} state - Comparison state: cycle map, node budget, `compareFn`.
 * @param {number} [depth=0] - Nesting depth, per *level* - not per element.
 * @returns {boolean}
 */
/**
 * One comparison's mutable state: cycle map, depth, node budget and the
 * caller's `compareFn`.
 *
 * A single object rather than the `(seen, depth)` pair it replaced, so a
 * top-level comparison allocates once instead of threading two parallel
 * parameters through six recursion sites.
 *
 * @param {{compareFn?: ?function(*, *): (boolean|undefined), maxNodes?: number, seen?: WeakMap<object, WeakSet<object>>}|undefined} [options]
 * @returns {{seen: ?WeakMap<object, WeakSet<object>>, nodes: number, maxNodes: number, compareFn: ?function(*, *): (boolean|undefined), exhausted: boolean}}
 * @private
 */
function makeState(options) {
  const o = options || {};
  return {
    seen: o.seen ?? null,
    nodes: 0,
    maxNodes: Number.isFinite(o.maxNodes)
      ? Math.max(1, Math.floor(Number(o.maxNodes)))
      : MAX_DEEP_EQUAL_NODES,
    compareFn: typeof o.compareFn === 'function' ? o.compareFn : null,
    exhausted: false,
  };
}

/**
 * Deep equality for cache values, with a cycle guard and two explicit limits.
 *
 * Module scope so `hasEqual` does not allocate a closure per call.
 *
 * @param {*} a
 * @param {*} b
 * @param {{seen: ?WeakMap<object, WeakSet<object>>, nodes: number, maxNodes: number, compareFn: ?function(*, *): (boolean|undefined), exhausted: boolean}} state
 *   Comparison state: cycle map, node budget, `compareFn`, exhaustion flag.
 * @param {number} [depth=0] - Nesting depth, counted per *level* and not per
 *   element. Counting per element was a real bug: a flat 101-element array of
 *   objects exhausted the limit, and every remaining pair fell back to
 *   reference equality, so two structurally identical copies compared as
 *   **unequal** and the entry could never be found.
 * @returns {boolean} `false` if the comparison ran out of budget - the safe
 *   direction for a cache, where a false negative costs a recompute and a false
 *   positive returns the wrong value.
 * @private
 */
function deepEqual(a, b, state, depth = 0) {
  if (depth > MAX_DEEP_EQUAL_DEPTH) {
    // Fall back to reference equality when we've recursed too deep.
    return a === b;
  }
  // Width budget, not just depth (PERF-004). `MAX_DEEP_EQUAL_DEPTH` bounds how
  // *deep* a comparison goes and says nothing about how *wide* it is: a
  // one-million-element array of scalars recurses at depth 2 and never trips
  // the depth limit, and comparing two of them measured 37 ms. `hasEqual` is a
  // cache lookup, so that is 37 ms of blocked event loop on a path a caller
  // reaches by accident. The budget bounds the work instead.
  //
  // Truncation reports **false**, not `true`. A false negative costs a
  // recompute; a false positive hands back the wrong value, and this is a
  // cache. `exhausted` makes the answer sticky so a run that ran out of budget
  // cannot be rescued by a later leaf that happens to match.
  if (state.exhausted) return false;
  if (state.nodes >= state.maxNodes) {
    state.exhausted = true;
    return false;
  }
  state.nodes += 1;

  // Reference equality, *after* the budget. A width budget that exempts
  // reference-equal pairs is not a width budget: two equal arrays of a million
  // scalars are a million reference comparisons, and exempting each one is
  // exactly the unbounded work the budget exists to stop. Rationing it means
  // such a pair reports `false` - a cache miss, a recompute - which is the
  // cheap way to be wrong.
  if (a === b) return true;

  // Escape hatch for values this walk cannot model: classes with private state,
  // domain objects, anything with its own notion of equality. Returning
  // `undefined` means "no opinion" and the walk continues.
  if (state.compareFn) {
    const verdict = state.compareFn(a, b);
    if (verdict !== undefined) return Boolean(verdict);
  }
  if (a == null || b == null) return a === b;
  const ta = typeof a,
    tb = typeof b;
  if (ta !== 'object' || tb !== 'object') return a === b;

  if (!state.seen) state.seen = new WeakMap();
  let mapForA = state.seen.get(a);
  if (mapForA?.has(b)) return true;
  if (!mapForA) {
    mapForA = new WeakSet();
    state.seen.set(a, mapForA);
  }
  mapForA.add(b);

  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  // Uint8Array fast-path
  if (typeof Uint8Array !== 'undefined' && a instanceof Uint8Array) {
    if (!(b instanceof Uint8Array)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Arrays
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], state, depth + 1)) return false;
    return true;
  }

  // TypedArray / DataView / other ArrayBuffer views
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset || 0, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }

  // ArrayBuffer
  if (a instanceof ArrayBuffer) {
    if (!(b instanceof ArrayBuffer) || a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a),
      ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }

  // Date
  if (a instanceof Date) {
    if (!(b instanceof Date)) return false;
    return a.getTime() === b.getTime();
  }

  // RegExp
  if (a instanceof RegExp) {
    if (!(b instanceof RegExp)) return false;
    return a.toString() === b.toString();
  }

  // Map
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k)) return false;
      if (!deepEqual(v, b.get(k), state, depth + 1)) return false;
    }
    return true;
  }

  // Set
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    let allPrimitive = true;
    for (const item of a) {
      if (item !== null && typeof item === 'object') {
        allPrimitive = false;
        break;
      }
    }
    if (allPrimitive) {
      for (const item of a) if (!b.has(item)) return false;
      return true;
    }
    // For non-primitive items try to reduce comparisons:
    // 1) fast reference matches
    // 2) attempt a safe JSON-based signature grouping to limit candidates
    // 3) fall back to structural deepEqual scan for remaining items
    const bItems = Array.from(b);
    const used = new Array(bItems.length).fill(false);

    // Fast reference check: mark direct reference matches
    const refIndex = new Map();
    for (let i = 0; i < bItems.length; i++) refIndex.set(bItems[i], i);

    // Helper: try to produce a stable-ish signature for many common objects
    const trySignature = (val) => {
      try {
        return JSON.stringify(val, (k, v) => {
          if (v instanceof Date) return { __type: 'Date', v: v.getTime() };
          if (v instanceof RegExp) return { __type: 'RegExp', v: v.toString() };
          if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v))
            return {
              __type: 'TypedArray',
              v: Array.from(new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength)),
            };
          if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer)
            return { __type: 'ArrayBuffer', v: Array.from(new Uint8Array(v)) };
          return v;
        });
      } catch (err) {
        return null;
      }
    };

    // Build signature -> indices map for bItems when possible
    const sigMap = new Map();
    const unsigIndices = [];
    for (let i = 0; i < bItems.length; i++) {
      const s = trySignature(bItems[i]);
      if (s == null) unsigIndices.push(i);
      else {
        const arr = sigMap.get(s);
        if (arr) arr.push(i);
        else sigMap.set(s, [i]);
      }
    }

    // For each item in `a`, try to find a matching unused candidate in bItems
    for (const itemA of a) {
      // reference match
      const refI = refIndex.get(itemA);
      if (refI !== undefined && !used[refI]) {
        used[refI] = true;
        continue;
      }

      // signature match
      const sigA = trySignature(itemA);
      let found = false;
      if (sigA != null) {
        const cand = sigMap.get(sigA) || [];
        for (const idx of cand) {
          if (used[idx]) continue;
          if (deepEqual(itemA, bItems[idx], state, depth + 1)) {
            used[idx] = true;
            found = true;
            break;
          }
        }
        if (found) continue;
      }

      // fallback structural scan across any remaining unmatched bItems
      for (let i = 0; i < bItems.length; i++) {
        if (used[i]) continue;
        if (deepEqual(itemA, bItems[i], state, depth + 1)) {
          used[i] = true;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  // Plain objects
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k], state, depth + 1)) return false;
  }
  return true;
}

/**
 * PowerMemoizer
 *
 * A small memoization wrapper backed by `PowerCache`.
 * It memoizes synchronous values and Promise-returning functions.
 * Concurrent calls for the same arguments are deduplicated (single inflight Promise).
 * Rejected Promises are not cached.
 *
 * Usage (constructor returns a `PowerMemoizer` instance; when a function is supplied
 * the instance creates a memoized wrapper and exposes a convenience `run()` alias):
 * const fetcher = async (id) => await fetchData(id)
 * const pm = new PowerMemoizer(fetcher, { cacheOptions: { defaultTTL: 1000 } })
 * // call the memoized function via the convenience alias
 * await pm.run(1)
 *
 * @class PowerMemoizer
 * @public
 */
export class PowerMemoizer {
  /**
   * Create a PowerMemoizer.
   * @param {Function} [fn] - Optional function to memoize immediately.
   * @param {PowerMemoizerOptions} [options]
   */
  constructor(fn, options = {}) {
    assertKnownOptions(options, ['keyResolver', 'cacheOptions', 'ttl', 'weight'], 'PowerMemoizer');
    assertKnownOptions(
      options,
      [
        'admission',
        'allowStale',
        'cacheOptions',
        'defaultAsyncTimeout',
        'defaultTTL',
        'fetchMethod',
        'initialPoolSize',
        'keyResolver',
        'maxCleanupPerTick',
        'maxEntries',
        'maxPoolSize',
        'maxWeight',
        'now',
        'observability',
        'onError',
        'onEvict',
        'onExpire',
        'policy',
        'rejectOversized',
        'staleTtl',
        'ttl',
        'weight',
        'weightFn',
        'windowSize',
      ],
      'PowerCache'
    );
    const { keyResolver = simpleArgsKey, cacheOptions = {}, ttl, weight } = options;
    // `simpleArgsKey` is the default rather than `JSON.stringify` (PERF-005). It
    // is ~35% cheaper for the scalar arguments memoizers are actually called
    // with, and it falls back to `JSON.stringify` the moment it meets a
    // non-scalar, so behaviour is unchanged for anything it cannot encode
    // cheaply. The cache key *format* changes, which is a 2.0 break: a
    // memoizer's `.cache` is in-memory and is not a persisted format, but a
    // caller reading keys - in a test, or in a debug dump - will see it.
    this.keyResolver = typeof keyResolver === 'function' ? keyResolver : simpleArgsKey;
    this.cache = new PowerCache(cacheOptions);
    // track inflight Promises to deduplicate concurrent calls
    this._inflight = new Map();
    this._defaultMemoizeOptions = {};
    if (ttl !== undefined) this._defaultMemoizeOptions.ttl = ttl;
    if (weight !== undefined) this._defaultMemoizeOptions.weight = weight;

    // Default run behavior: when no function is supplied the instance will
    // throw if `run()` is invoked. Callers should use `memoize(fn)` to obtain
    // a memoized wrapper for a function.
    this.run = () => {
      throw new TypeError(
        'No function supplied to PowerMemoizer; call memoize(fn) to create a memoized wrapper.'
      );
    };
    this._originalFn = null;
    // Per-instance receiver identity table used to build cache keys for
    // memoized *methods* (see `_receiverKey`). WeakMap so a receiver that
    // becomes unreachable cannot leak an entry.
    this._receiverIds = new WeakMap();
    this._nextReceiverId = 0;

    // If a function was provided at construction time, keep it as the
    // original function and create a memoized wrapper available via
    // `memoize(fn)` and the convenience `run()` alias. The constructor
    // always returns the instance (never a bare function).
    if (typeof fn === 'function') {
      this._originalFn = fn;
      try {
        // Create and cache a memoized wrapper using the instance defaults.
        this._fnWrapper = this.memoize(fn);
        // Provide a simple convenience method to invoke the memoized wrapper
        // directly on the instance for callers that previously relied on
        // constructor-returned functions.
        this.run = (...args) => this._fnWrapper(...args);
      } catch (err) {
        // Ignore failures to create the wrapper; callers can still call
        // `memoize(fn)` explicitly.
      }
    }
  }

  /**
   * Wrap a function with memoization.
   * @private
   * @param {Function} fn - Function to memoize. May return a Promise.
   * @param {Object} [options]
   * @param {number} [options.ttl] - Per-entry TTL in ms (overrides cache default)
   * @param {number} [options.weight] - Optional explicit weight for the entry
   * @returns {Function} Memoized function
   */
  /**
   * Build a cache key that includes the receiver's identity, so memoizing a
   * method keeps one entry per object instead of collapsing every caller's
   * result into a single shared entry.
   *
   * Object and function receivers get a monotonic id from a per-instance
   * `WeakMap`. Primitive receivers (`memoized.call(5, x)`) fall back to their
   * string form, which is still correct because the same primitive receiver
   * necessarily has the same state.
   *
   * @param {any} receiver - The `this` value the wrapper was called with.
   * @param {any[]} args - The call arguments.
   * @returns {string} Cache key scoped to `receiver`.
   * @private
   */
  _receiverKey(receiver, args) {
    let id;
    if (receiver !== null && (typeof receiver === 'object' || typeof receiver === 'function')) {
      id = this._receiverIds.get(receiver);
      if (id === undefined) {
        id = this._nextReceiverId++;
        this._receiverIds.set(receiver, id);
      }
    } else {
      id = `p${String(receiver)}`;
    }
    return `r${id}:${this.keyResolver(...args)}`;
  }

  /**
   * Wrap `fn` so every call goes through this memoizer's cache.
   *
   * Documented because it is a real (private) seam: `memoize()` normalises the
   * options before calling it, and the declaration had no JSDoc at all, so the
   * emitted signature was `{ ttl, weight }?: {}` - a destructuring pattern typed
   * as the empty object, which is not assignable from anything. That is a
   * declaration error in the published `.d.ts`, not a runtime one.
   *
   * @param {Function} fn - Function to wrap.
   * @param {F} fn - Function to wrap.
   * @param {Object} [options] - Per-wrapper overrides merged over the defaults.
   * @param {number} [options.ttl]
   * @param {number} [options.weight]
   * @returns {import('./jsdoc-types.js').MemoizedFunction<F>} The memoized wrapper.
   * @template {Function} F
   * @private
   */
  _memoize(fn, { ttl, weight } = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const self = this;
    return function memoized(...args) {
      // Memoizing a *method* must not lose the receiver. The wrapper is a
      // plain `function` (not an arrow) precisely so `this` is observable.
      // Two things follow from that:
      //   1. `this` has to be forwarded to `fn`, and
      //   2. `this` has to be part of the cache key, or `objA.m(1)` and
      //      `objB.m(1)` would share one entry and return each other's value.
      // A plain `fn(1)` call (no meaningful receiver) keeps the original key
      // space so existing cache entries and key expectations are unchanged.
      const receiver = this === undefined || this === null ? null : this;
      const key = receiver === null ? self.keyResolver(...args) : self._receiverKey(receiver, args);
      // One lookup, not two. `cache.has(key)` followed by `cache.get(key)` is
      // the obvious way to tell "absent" from "cached `undefined`", and it
      // costs a full extra lookup on every single call - measured at 0.25 us for
      // the pair against 0.125 us for one, on a 0.41 us call. `_fetchValidNode`
      // already does the expiry check and returns the node or null, so the node's
      // existence is the answer and the value comes off it.
      const node = self.cache._fetchValidNode(key);
      if (node !== null) return node.value;
      // if there is an inflight Promise, return it to dedupe
      if (self._inflight.has(key)) return self._inflight.get(key);

      const res = receiver === null ? fn(...args) : fn.apply(receiver, args);
      // Promise-like
      if (typeof res?.then === 'function') {
        // Wrap the incoming thenable/promise in an async wrapper so we can
        // register the inflight marker before the original thenable may
        // synchronously invoke callbacks (some thenables call handlers
        // synchronously). The wrapper ensures we always delete the inflight
        // marker exactly once after settlement and avoids races where a
        // deletion could occur before the inflight was recorded.
        const p = (async () => {
          try {
            const value = await res;
            try {
              self.cache.set(key, value, { ttl, weight });
            } catch (err) {
              /* swallow cache errors */
            }
            return value;
          } finally {
            // Ensure inflight marker is removed regardless of resolution
            // or rejection.
            self._inflight.delete(key);
          }
        })();
        self._inflight.set(key, p);
        return p;
      }

      // synchronous result — cache and return
      self.cache.set(key, res, { ttl, weight });
      return res;
    };
  }

  /**
   * Public API to memoize an arbitrary function using this PowerMemoizer instance's cache.
   * Mirrors the behavior used by the constructor when a function is supplied —
   * returns a callable memoized function with helpers attached (`get`, `has`, `delete`, `clear`, `stats`, `cache`).
   * @param {F} fn - Function to memoize
   * @param {Object} [options] - Optional per-wrapper options { ttl, weight }
   * @returns {import('./jsdoc-types.js').MemoizedFunction<F>} The memoized
   *   wrapper, callable like `fn` and
   *   carrying `get`/`has`/`delete`/`clear`/`stats`/`cache`/`original`.
   * @template {Function} F
   */
  memoize(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const useOptions =
      options &&
      (Object.prototype.hasOwnProperty.call(options, 'ttl') ||
        Object.prototype.hasOwnProperty.call(options, 'weight'))
        ? options
        : this._defaultMemoizeOptions;
    const memoizedFn = this._memoize(fn, useOptions);
    // Ordinary functions, not arrows, so the receiver survives. See
    // `_scopedKey` for what that receiver means and why the plain call
    // `memo.get(10)` still resolves the unscoped key.
    const self = this;
    memoizedFn.get = function (...args) {
      return self._getFor(memoizedFn, this, args);
    };
    memoizedFn.has = function (...args) {
      return self._hasFor(memoizedFn, this, args);
    };
    memoizedFn.delete = function (...args) {
      return self._deleteFor(memoizedFn, this, args);
    };
    memoizedFn.clear = () => this.clear();
    memoizedFn.stats = () => this.stats();
    memoizedFn.cache = this.cache;
    memoizedFn.original = fn;
    // NB: do not call `Object.setPrototypeOf(memoizedFn, PowerMemoizer.prototype)`.
    // `PowerMemoizer.prototype` chains to `Object.prototype`, so the mutation
    // removes `Function.prototype` from the chain and the returned function
    // loses `.call`/`.apply`/`.bind`. Use the own-properties above instead.
    return memoizedFn;
  }

  /**
   * Retrieve a cached value for the given call args (if present).
   * @param  {...*} args
   * @returns {*|undefined}
   */
  get(...args) {
    return this._lookup(this.keyResolver(...args));
  }

  /**
   * Check presence for the given call args.
   * @param  {...*} args
   * @returns {boolean}
   */
  has(...args) {
    return this.cache.has(this.keyResolver(...args));
  }

  /**
   * Delete the cached entry for the given call args.
   * Also clears any inflight Promise for the key.
   * @param  {...*} args
   * @returns {boolean}
   */
  delete(...args) {
    return this._evict(this.keyResolver(...args));
  }

  /**
   * Key an attached helper should use, given the helper's own receiver.
   *
   * The helpers are the only way to reach a **method**-memoized entry, and they
   * used to be arrow functions, which discarded their receiver entirely. So
   * `memo.call(obj, 10)` stored under `r1:10` while `memo.get(10)` looked up
   * `10`: the entry existed, was invisible, and could not be invalidated by any
   * of `get`/`has`/`delete`. They are ordinary functions now, and this is where
   * the receiver is turned back into a key.
   *
   * Calling a helper plainly — `memo.get(10)` — leaves the memoized function as
   * the receiver, and that must resolve the **unscoped** key, because a plain
   * `memo(10)` call is what stored it. So the guide's documented
   * `get(...args)` keeps working unchanged, and
   * `memo.get.call(obj, 10)` reaches the entry `memo.call(obj, 10)` stored.
   *
   * A `null`/absent receiver is the detached-helper case (`const g = memo.get`),
   * which resolved the unscoped key before this change and still does.
   *
   * @param {Function} memoizedFn - The wrapper the helper is attached to.
   * @param {any} receiver - The helper's `this`.
   * @param {any[]} args
   * @returns {string}
   * @private
   */
  _scopedKey(memoizedFn, receiver, args) {
    if (receiver === memoizedFn || receiver == null) return this.keyResolver(...args);
    return this._receiverKey(receiver, args);
  }

  /**
   * @param {string} key
   * @returns {*|undefined}
   * @private
   */
  _lookup(key) {
    return this.cache.get(key);
  }

  /**
   * @param {string} key
   * @returns {boolean}
   * @private
   */
  _evict(key) {
    if (this._inflight.has(key)) this._inflight.delete(key);
    return this.cache.delete(key);
  }

  /**
   * @param {Function} memoizedFn
   * @param {any} receiver
   * @param {any[]} args
   * @returns {*|undefined}
   * @private
   */
  _getFor(memoizedFn, receiver, args) {
    return this._lookup(this._scopedKey(memoizedFn, receiver, args));
  }

  /**
   * @param {Function} memoizedFn
   * @param {any} receiver
   * @param {any[]} args
   * @returns {boolean}
   * @private
   */
  _hasFor(memoizedFn, receiver, args) {
    return this.cache.has(this._scopedKey(memoizedFn, receiver, args));
  }

  /**
   * @param {Function} memoizedFn
   * @param {any} receiver
   * @param {any[]} args
   * @returns {boolean}
   * @private
   */
  _deleteFor(memoizedFn, receiver, args) {
    return this._evict(this._scopedKey(memoizedFn, receiver, args));
  }

  /**
   * Clear all cached entries and any inflight markers.
   * @returns {void}
   */
  clear() {
    this._inflight.clear();
    this.cache.clear();
  }

  /**
   * Expose underlying cache stats.
   * @returns {Object}
   */
  stats() {
    return this.cache.stats();
  }

  /**
   * Alias for {@link stats}, so a caller who learned `getStats()` from
   * `PowerPool` — the one class that has always spelled it this way — is not
   * handed `TypeError: x.getStats is not a function` here.
   *
   * Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
   * `getStats()`, with no stated rule and nothing pinning it, which reached the
   * documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
   * spellings work everywhere now. `stats()` is canonical and this delegates to
   * it; `PowerPool` keeps `getStats` because renaming the largest surface in the
   * library would be a breaking change.
   *
   * Written out per class rather than installed on the prototype on purpose: a
   * dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
   * `types/` omitted it and a TypeScript caller got a type error on a method
   * that worked at runtime. That was the first implementation.
   *
   * **No `@returns` tag, and that is load-bearing.** The first version carried a
   * hand-copied copy of the `stats()` return shape, on the reasoning that an
   * explicit type was safer. It is not: the copy went stale the moment a
   * concurrent change added `staleServes` and `expirations` to `PowerCache`
   * `.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
   * byte-identical published type and cannot drift, because there is nothing to
   * keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
   * which is the property a consumer relies on.
   */
  getStats() {
    return this.stats();
  }
  /**
   * Release the underlying cache.
   *
   * `PowerMemoizer` owns no state of its own - it delegates to a `PowerCache`
   * - so disposal forwards to it. The inner cache is not replaced, so a
   * disposed memoizer's `cache` reference stays readable.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    if (typeof this.cache?.[Symbol.dispose] === 'function') {
      this.cache[Symbol.dispose]();
    }
  }

  /**
   * Named alias for the `Symbol.dispose` implementation, so callers who do not
   * want to reach for the symbol still have something to call.
   * @returns {void}
   */
  dispose() {
    this[Symbol.dispose]();
  }
}

/**
 * PowerTimedCache
 *
 * A thin convenience wrapper around `PowerCache` for the common pure-TTL
 * use-case. It constructs an internal `PowerCache` with the provided `ttl`
 * used as the cache `defaultTTL` and automatically starts the periodic
 * cleanup loop. The wrapper delegates common cache methods to the
 * underlying `PowerCache` instance.
 *
 * @example
 * const timed = new PowerTimedCache(60000, { maxEntries: 100, interval: 10000 });
 * timed.set('k', 1);
 * // entries will be automatically expired by the background cleaner
 *
 * @class PowerTimedCache
 * @public
 */
export class PowerTimedCache {
  /**
   * @param {number} ttl - Default TTL in milliseconds for entries.
   * @param {PowerTimedCacheOptions} [options]
   */
  constructor(ttl, { maxEntries, interval, maxCleanupPerTick, cacheOptions = {} } = {}) {
    assertKnownOptions(cacheOptions, ['ttl', 'weight', 'cacheOptions'], 'PowerTimedCache');
    if (!Number.isFinite(+ttl) || ttl <= 0) throw new TypeError('ttl must be a positive number');
    const cfg = Object.assign({}, cacheOptions);
    if (maxEntries !== undefined) cfg.maxEntries = maxEntries;
    cfg.defaultTTL = +ttl;
    this.cache = new PowerCache(cfg);
    // auto-start cleanup; if caller supplied interval options, forward them
    if (interval !== undefined || maxCleanupPerTick !== undefined) {
      this.cache.startCleanup({ interval, maxCleanupPerTick });
    } else {
      this.cache.startCleanup();
    }
  }

  // Delegate commonly used methods to the underlying PowerCache
  get(key) {
    return this.cache.get(key);
  }
  // These forward to the inner `PowerCache` and were declared with required
  // parameters, so `timed.set(k, v)` - two arguments, which is all the method
  // needs - failed to type-check with "Expected 3 arguments, but got 2".
  //
  // The `options` parameter is declared for the same reason: the inner methods
  // take `{ttl, weight}`, and an undeclared third parameter is published as
  // `options?: {}`, which type-checks anything and tells the caller nothing.
  /**
   * @param {any} key
   * @param {any} value
   * @param {{ttl?: number, weight?: number}} [options] Per-entry TTL in ms and
   *   weight. Both are ignored when this instance was constructed with a
   *   non-null TTL — the constructor's TTL wins.
   * @returns {false|PowerTimedCache}
   */
  set(key, value, options = {}) {
    return this.cache.set(key, value, options);
  }
  /**
   * @param {any} key
   * @param {{allowStale?: boolean, staleTtl?: number}} [options] `allowStale`
   *   returns an expired entry and refreshes in the background, bounded by
   *   `staleTtl` — see the `PowerCache` guide, because an unbounded stale window
   *   serves a value of any age.
   * @returns {boolean}
   */
  has(key, options = {}) {
    return this.cache.has(key, options);
  }
  delete(key) {
    return this.cache.delete(key);
  }
  clear() {
    return this.cache.clear();
  }
  stats() {
    return this.cache.stats();
  }

  /**
   * Alias for {@link stats}, so a caller who learned `getStats()` from
   * `PowerPool` — the one class that has always spelled it this way — is not
   * handed `TypeError: x.getStats is not a function` here.
   *
   * Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
   * `getStats()`, with no stated rule and nothing pinning it, which reached the
   * documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
   * spellings work everywhere now. `stats()` is canonical and this delegates to
   * it; `PowerPool` keeps `getStats` because renaming the largest surface in the
   * library would be a breaking change.
   *
   * Written out per class rather than installed on the prototype on purpose: a
   * dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
   * `types/` omitted it and a TypeScript caller got a type error on a method
   * that worked at runtime. That was the first implementation.
   *
   * **No `@returns` tag, and that is load-bearing.** The first version carried a
   * hand-copied copy of the `stats()` return shape, on the reasoning that an
   * explicit type was safer. It is not: the copy went stale the moment a
   * concurrent change added `staleServes` and `expirations` to `PowerCache`
   * `.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
   * byte-identical published type and cannot drift, because there is nothing to
   * keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
   * which is the property a consumer relies on.
   */
  getStats() {
    return this.stats();
  }
  startCleanup(intervalOrOptions = undefined) {
    return this.cache.startCleanup(intervalOrOptions);
  }
  stopCleanup() {
    return this.cache.stopCleanup();
  }
  get size() {
    return this.cache.size;
  }
  get hitRate() {
    return this.cache.hitRate;
  }
  entries(order) {
    return this.cache.entries(order);
  }
  keys(order) {
    return this.cache.keys(order);
  }
  values(order) {
    return this.cache.values(order);
  }
  /**
   * Named alias for the `Symbol.dispose` implementation, so callers who
   * do not want to reach for the symbol still have something to call.
   * @returns {void}
   */
  dispose() {
    this[Symbol.dispose]();
  }

  [Symbol.dispose]() {
    if (typeof this.cache?.[Symbol.dispose] === 'function') return this.cache[Symbol.dispose]();
  }
  async [Symbol.asyncDispose]() {
    if (typeof this.cache?.[Symbol.asyncDispose] === 'function')
      return this.cache[Symbol.asyncDispose]();
    return;
  }
}

/**
 * Structural, type-tagged encoding of one memoizer argument.
 *
 * `simpleArgsKey` used to hand the **whole argument list** to `JSON.stringify`
 * the moment it met anything non-scalar, and that single decision caused four
 * distinct defects, all measured:
 *
 * - `({a:1}, undefined)`, `({a:1}, fn)` and `({a:1}, null)` all produced
 *   `'[{"a":1},null]'` — `JSON.stringify` maps `undefined` and functions to
 *   `null`. A memoizer served the *first* call's value to the other two. That is
 *   the row's report, confirmed with a live `PowerMemoizer`: two distinct calls,
 *   one underlying invocation.
 * - **Every `Map`, `Set`, `RegExp` and `Error` serialised to `'[{}]'`**, so two
 *   unrelated `Map`s were indistinguishable. Worse than the reported case,
 *   because nothing about the inputs suggests they are unencodable.
 * - A `BigInt` *inside* an object threw, while a top-level `BigInt` was
 *   explicitly supported on the fast path — the same value, two answers.
 * - A circular structure threw `Converting circular structure to JSON`.
 *
 * Encoding per argument, with a type tag on each, removes all four: an
 * unencodable value can no longer alias a *different* value, because the
 * alternatives are a distinct tag or a throw.
 *
 * @param {*} v
 * @param {Set<object>} seen - Objects already on the current path, for cycles.
 * @returns {string}
 */
function encodeArg(v, seen) {
  const t = typeof v;
  if (v === null) return 'n:';
  if (t === 'string') return 's:' + v.length + ':' + v;
  // No `-0` normalisation, because it is not needed: `String(-0)` is already
  // `'0'`, so the original `String(v === 0 ? 0 : v)` could not change the result.
  // A test asserted the two were equal and passed whichever way it was written —
  // a guard that cannot fail. Removed when a mutation check proved it.
  if (t === 'number') return 'd:' + String(v);
  if (t === 'boolean') return 'b:' + (v ? '1' : '0');
  if (t === 'undefined') return 'u:';
  if (t === 'bigint') return 'g:' + v.toString();
  if (t === 'symbol') {
    // `JSON.stringify` maps every Symbol to `null`, so falling through would
    // alias *all* Symbol arguments onto one key. Symbols are not serialisable
    // by design, and a `Symbol.keyFor` registry would only be stable within a
    // registry.
    throw new TypeError('simpleArgsKey() does not support symbol arguments');
  }
  if (t === 'function') {
    // A closure has no stable identity: two structurally identical arrows are
    // different functions, and `String(fn)` is the same text for both, so any
    // encoding would either collide or be useless. Refusing is the only answer
    // that cannot be wrong.
    throw new TypeError(
      'simpleArgsKey() does not support function arguments - two closures cannot be told apart. ' +
        'Pass a key explicitly, or supply a `keyResolver`.'
    );
  }

  // A value already on this path is a cycle. Its *depth* is enough to
  // distinguish the structures, and it terminates.
  if (seen.has(v)) return 'c:';
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      let out = 'A:[';
      for (let i = 0; i < v.length; i++) {
        if (i) out += ',';
        out += encodeArg(v[i], seen);
      }
      return out + ']';
    }
    if (v instanceof Date) return 'D:' + v.getTime();
    if (v instanceof RegExp) return 'R:' + v.source + '/' + v.flags;
    if (v instanceof Error) return 'E:' + v.name + ':' + v.message;
    if (v instanceof Map) {
      // Order is significant for a Map, so it is preserved rather than sorted.
      let out = 'Mp:[';
      let first = true;
      for (const [k, val] of v) {
        if (!first) out += ',';
        first = false;
        out += encodeArg(k, seen) + '=' + encodeArg(val, seen);
      }
      return out + ']';
    }
    if (v instanceof Set) {
      let out = 'St:[';
      let first = true;
      for (const val of v) {
        if (!first) out += ',';
        first = false;
        out += encodeArg(val, seen);
      }
      return out + ']';
    }
    // Plain object. Key order follows insertion order, as `JSON.stringify` did,
    // so an object built the same way twice still matches.
    let out = 'O:{';
    let first = true;
    for (const k of Object.keys(v)) {
      if (!first) out += ',';
      first = false;
      out += 's:' + k.length + ':' + k + '=' + encodeArg(v[k], seen);
    }
    return out + '}';
  } finally {
    // Pop, so a value reached twice on sibling paths is not mistaken for a
    // cycle. `seen` is a path, not a visited-set.
    seen.delete(v);
  }
}

/**
 * A small, fast key resolver for common cases where arguments are simple scalars.
 * - Fast path for primitive scalar args (string, number, boolean, null, undefined).
 * - Joins scalar args with `|` and prefixes type codes to avoid collisions.
 * - Falls back to `JSON.stringify(args)` when any arg is a non-scalar (object, function, symbol).
 *
 * This is intended as a performant default for hot paths where most calls use
 * simple identifiers (ids, numbers, short strings). It is deterministic but
 * not suitable for canonicalizing complex objects — provide a custom
 * `keyResolver` in that case.
 *
 * Example: `new PowerMemoizer(fn, { keyResolver: simpleArgsKey })`
 *
 * @public
 */
export function simpleArgsKey(...args) {
  if (args.length === 0) return '';
  // One encoder for every argument, including the scalars. The previous shape
  // had a fast path for scalars and a wholesale `JSON.stringify` fallback for
  // anything else, and the fallback is where every defect in this row lived:
  // it mapped `undefined`, functions and every `Map`/`Set`/`RegExp` onto the
  // same text, so distinct calls shared a cache entry.
  //
  // The scalar codes are unchanged, so the key format for scalar-only calls —
  // the overwhelmingly common case, and the one PERF-005 measured — is
  // byte-identical to before. Only calls that previously hit the fallback
  // change, which is precisely the set that was broken.
  const seen = new Set();
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (i) out += '|';
    out += encodeArg(args[i], seen);
  }
  return out;
}
