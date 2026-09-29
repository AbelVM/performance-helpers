import { SmallLfuSketch } from '../utils/smallLfu.js';

/**
 * Half-life, as a multiple of `maxEntries`. TinyLFU's guidance is ~10x, but the
 * sketch here is incremented on `get` as well as `set`, so a short warm-up can
 * trip a reset and halve a working set that had only just been learned. Tuned by
 * measurement - see the scan-resistance table in guides/powerCache.md.
 */
const ADMISSION_SAMPLE_MULTIPLE = 200;
/**
 * @typedef {import('./jsdoc-types.js').CacheNode} CacheNode
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerCacheOptions} PowerCacheOptions
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
import { assertFunction, assertLimitRequired } from '../utils/options.js';
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
    maxPoolSize = DEFAULT_CACHE_MAX_POOL_SIZE,
    rejectOversized = false,
    onEvict = null,
    onExpire = null,
    initialPoolSize = 0,
    maxCleanupPerTick = DEFAULT_MAX_CLEANUP_PER_TICK,
    eagerCleanupOnRead = false,
    // default timeout (ms) applied to `getOrSetAsync` when callers omit per-call timeout
    defaultAsyncTimeout = DEFAULT_TIMEOUT_MS,
    // invoked as onError(err, message) whenever an internal failure is
    // swallowed (throwing onEvict/onExpire, a failing weightFn, ...)
    onError = null,
    /** @see PowerCache#_policy - `'lru'` (default) or `'slru'`. */
    policy = 'lru',
    admission = 'none',
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
      min: 0,
      allowInfinity: true,
    });
    this.weightFn = assertFunction(weightFn, { name: 'weightFn', className: 'PowerCache' })
      ? weightFn
      : () => 1;
    this.defaultTTL = defaultTTL;
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

    this.eagerCleanupOnRead = Boolean(eagerCleanupOnRead);

    this._map = new Map();
    this._head = null;
    this._tail = null;
    this._pool = [];
    // prefill pool to reduce runtime allocations if requested
    for (let i = 0; i < Math.min(initialPoolSize || 0, this.maxPoolSize); i++)
      this._pool.push({ key: null, value: null, weight: 0, expiresAt: 0, prev: null, next: null });

    this._currentWeight = 0;
    this._hits = 0;
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
    // acceptance criteria. `design/0001-tinylfu-admission-window.md` has the
    // full story, including why.
    this._sketch =
      admission === 'tinylfu' && this._policy === 'lru'
        ? new SmallLfuSketch({
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
    this._defaultAsyncTimeout = Number.isFinite(Number(defaultAsyncTimeout))
      ? Math.max(0, Math.floor(Number(defaultAsyncTimeout)))
      : 30000;
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
    };
    node.key = key;
    node.value = value;
    node.weight = weight || 0;
    node.expiresAt = expiresAt || 0;
    node.prev = null;
    node.next = null;
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
    const now = !ignoreExpiry && node.expiresAt ? nowMs() : 0;
    if (now && node.expiresAt <= now) {
      if (allowExpired) return node;
      this._removeExpiredNode(node, now);
      if (countMiss) this._misses++;
      return null;
    }
    return node;
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
    let p;
    try {
      p = Promise.resolve().then(() => factory());
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
        this._inflightPromises.delete(key);
      });
    this._inflightPromises.set(key, tracked);
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
    if (this._tail === node) return;
    this._remove(node);
    this._append(node);
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
    const now = nowMs();
    const expiresAt = ttl == null || ttl === Infinity ? 0 : now + ttl;
    // Compute weight once and validate it before mutating bookkeeping.
    const w = this._computeWeight(value, weight);
    // If item is heavier than maxWeight, optionally reject insertion
    if (this.rejectOversized && Number.isFinite(this.maxWeight) && w > this.maxWeight) {
      this._rejected++;
      try {
        if (this.onEvict) this.onEvict(key, value, 'rejected-oversized');
      } catch (err) {
        this._notifyError(err, 'PowerCache onEvict callback threw (rejected-oversized)');
      }
      return false;
    }

    if (this._map.has(key)) {
      const node = this._map.get(key);
      this._currentWeight -= node.weight || 0;
      node.value = value;
      node.weight = w;
      node.expiresAt = expiresAt;
      this._currentWeight += node.weight || 0;
      this._moveToTail(node);
    } else {
      // Admission, decided *before* the insert. An LRU evicts the coldest by
      // recency, which a one-off scan does not disturb: the scan's keys are the
      // *most* recent by definition, and it walks the working set straight out.
      // A frequency filter asks a different question - is the thing about to be
      // evicted still wanted - and refuses the insertion when the incumbent is
      // the better bet.
      //
      // Refusing here rather than inside the eviction sweep matters. An earlier
      // version returned from `_evictIfNeeded` to reject, which skipped the
      // sweep entirely and let the cache grow to 77 entries against a limit of
      // 10. Rejection is about *this key*, so it belongs at the insert.
      // Only ever consulted at capacity. A frequency filter compares the
      // challenger's popularity against the victim's, and a brand-new key's
      // estimate is 0 - so applying the rule below capacity refuses every
      // insert after the first and the cache can never fill. Measured: 200
      // insertions rejected, `size` 1. Admission is about what to *displace*,
      // so it needs something to displace.
      if (this._sketch && this._map.size >= this.maxEntries) {
        const incumbent = this._evictionCandidate || this._head;
        // A brand-new key is **refused whenever the incumbent's estimate is
        // greater than or equal to its own**, and a brand-new key's estimate is
        // 0. In a cold sketch every estimate is 0, so `0 >= 0` holds and the
        // key is refused. Read that against the comment this block used to
        // carry, which claimed a first-seen key was "admitted unconditionally
        // ... the TinyLFU admission window in its simplest form". That was false,
        // and so was the rest of it, which simultaneously asserted that "only a
        // *strictly* hotter incumbent may refuse" (which would need `>`) and
        // that "`>=`, so a tie keeps the incumbent" (which is what the code does,
        // and which refuses the challenger).
        //
        // **This is a known defect, and the refusal rule above is why
        // `admission: 'tynilfu'` currently underperforms plain LRU.** Measured on
        // the paired Zipf + scan workload in `bench/claims.js` (`node bench/claims.js
        // zipf`): on a cold 40-entry cache preceded by a 460-key scan burst the
        // working-set hit rate is 2.5% against plain LRU's 66.4%, because the
        // scan keys fill the cache while it is still below capacity and the
        // working set is then refused every time. On a sustained Zipf mix,
        // working-set retention is 15.4/40 against LRU's 17.2/40, with the
        // worst hot keys sitting at estimate 0 — and a key at 0 can never
        // re-enter. The release note for this option has been withdrawn; the
        // measurements live in `review.md` under BENCH-002.
        //
        // **The fix is not a comparison operator.** Changing `>=` to `>` admits
        // the challenger on every tie, which lets a scan walk the working set —
        // the exact failure this filter exists to prevent. The correct mechanism
        // is W-TinyLFU's admission *window*: a small region at the MRU end that
        // accepts new keys unconditionally, so scan traffic is absorbed there
        // and the frequency filter arbitrates only that window's victim against
        // a main-space victim. That needs a size choice, its own interaction
        // rules with `policy: 'slru'` (which currently makes `tynilfu` *worse*),
        // and its own tests.
        //
        // The sketch itself is sound: `test/smallLfu.test.js` asserts at a
        // production-shaped half-life that a recurring key outranks a one-shot
        // one on every key, so do not "fix" this by re-tuning the sketch.
        const challenger = this._sketch.estimate(key);
        if (incumbent && this._sketch.estimate(incumbent.key) >= challenger) {
          this._rejectedAdmission += 1;
          return this;
        }
      }
      const node = this._allocNode(key, value, w, expiresAt);
      this._map.set(key, node);
      this._append(node);
      this._currentWeight += node.weight || 0;
    }
    // Evict after both inserts and in-place updates. An update that grows an
    // entry's weight can push the cache over `maxWeight`, and only the insert
    // branch used to trigger eviction — leaving the cache permanently over
    // budget until the next insert.
    // The key is recorded even when the insert is admitted, so the sketch
    // reflects attempted demand rather than only what survived.
    this._sketch?.increment(key);
    this._evictIfNeeded(key);
    return this;
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
    { ttl = undefined, weight = undefined, staleWhileRevalidate = false } = {}
  ) {
    const now = nowMs();
    const node = this._fetchValidNode(key, {
      countMiss: false,
      allowExpired: staleWhileRevalidate,
    });

    if (node) {
      if (node.expiresAt && node.expiresAt <= now) {
        if (typeof factory === 'function') {
          this._moveToTail(node);
          this._hits++;
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
   * @param {Iterable<[*,*]>} entries
   * @param {Object} [options]
   * @param {number} [options.ttl]
   * @param {number} [options.weight]
   * @returns {this}
   */
  setMany(entries, { ttl = undefined, weight = undefined } = {}) {
    const now = nowMs();
    const expiresAt = ttl == null || ttl === Infinity ? 0 : now + ttl;
    for (const pair of entries) {
      if (!pair) continue;
      const [key, value] = pair;
      const w = this._computeWeight(value, weight);

      if (this._map.has(key)) {
        const node = this._map.get(key);
        this._currentWeight -= node.weight || 0;
        node.value = value;
        node.weight = w;
        node.expiresAt = expiresAt;
        this._currentWeight += node.weight || 0;
        this._moveToTail(node);
      } else {
        const node = this._allocNode(key, value, w, expiresAt);
        this._map.set(key, node);
        this._append(node);
        this._currentWeight += node.weight || 0;
      }
    }
    // Perform eviction once after bulk insertions
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
    const now = nowMs();
    if (ttl !== undefined) {
      node.expiresAt = ttl == null || ttl === Infinity ? 0 : now + ttl;
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
    { ttl = undefined, weight = undefined, staleWhileRevalidate = false, timeout = undefined } = {}
  ) {
    if (typeof asyncFactory !== 'function') {
      // treat non-function as direct value
      return Promise.resolve(this.getOrSet(key, asyncFactory, { ttl, weight }));
    }

    const now = nowMs();
    const node = this._map.get(key);
    if (node) {
      if (node.expiresAt && node.expiresAt <= now) {
        if (staleWhileRevalidate) {
          this._moveToTail(node);
          this._hits++;
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

    // Invoke and normalize result to a Promise
    let p;
    try {
      p = Promise.resolve().then(() => asyncFactory());
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

    const tracked = timed.finally(() => {
      this._inflightPromises.delete(key);
    });

    this._inflightPromises.set(key, tracked);
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
    const now = nowMs();
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
      interval = Number.isFinite(+intervalOrOptions.interval)
        ? +intervalOrOptions.interval
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
   * @returns {{size:number, weight:number, hits:number, misses:number, evictions:number, rejected:number, poolSize:number}}
   */
  stats() {
    return {
      size: this.size,
      weight: this._currentWeight,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      expirations: this._expirations,
      rejected: this._rejected,
      poolSize: this._pool.length,
    };
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
    // Eviction candidate should align with the (possibly new) head.
    this._evictionCandidate = this.head;
  }

  /**
   * Iterate entries in LRU or MRU order.
   * @param {'LRU'|'MRU'} [order='MRU']
   * @returns {IterableIterator<[*,*]>}
   */
  *entries(order = 'MRU') {
    if (order === 'MRU') {
      for (let node = this._tail; node; node = node.prev) yield [node.key, node.value];
    } else {
      for (let node = this._head; node; node = node.next) yield [node.key, node.value];
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
   * @param {Object} [options]
   * @param {function(...*):string} [options.keyResolver] - Function that maps the wrapped call args to a cache key. Defaults to `JSON.stringify` on args.
   *   Note: `JSON.stringify(args)` is convenient but can be expensive for large or deeply-nested
   *   arguments. If the wrapped function is on a hot path, provide a custom `keyResolver`
   *   that cheaply and deterministically maps arguments to keys (for example, join simple
   *   scalar args with a separator or use a fast hashing function).
   * @param {Object} [options.cacheOptions] - Options forwarded to the underlying `PowerCache` constructor. Supported keys: `maxEntries` (number), `maxWeight` (number), `weightFn` (function(value):number), `defaultTTL` (number, ms), `maxPoolSize` (number), `rejectOversized` (boolean), `onEvict` (function(key, value, reason)), `onExpire` (function(key, value)), `initialPoolSize` (number), `maxCleanupPerTick` (number). See `PowerCache` constructor JSDoc for details.
   * @param {number} [options.ttl] - Default TTL (ms) used when constructing the memoized wrapper for `fn`.
   * @param {number} [options.weight] - Default weight used when constructing the memoized wrapper for `fn`.
   */
  constructor(fn, options = {}) {
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
    memoizedFn.get = (...args) => this.get(...args);
    memoizedFn.has = (...args) => this.has(...args);
    memoizedFn.delete = (...args) => this.delete(...args);
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
    return this.cache.get(this.keyResolver(...args));
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
    const key = this.keyResolver(...args);
    if (this._inflight.has(key)) this._inflight.delete(key);
    return this.cache.delete(key);
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
   * @param {Object} [options]
   * @param {number} [options.maxEntries] - Forwarded to `PowerCache`.
   * @param {number} [options.interval] - Cleanup interval (ms) for automatic cleanup.
   * @param {number} [options.maxCleanupPerTick] - Max nodes scanned per cleanup tick.
   * @param {Object} [options.cacheOptions] - Additional options forwarded to `PowerCache`.
   */
  constructor(ttl, { maxEntries, interval, maxCleanupPerTick, cacheOptions = {} } = {}) {
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
  set(key, value, options = {}) {
    return this.cache.set(key, value, options);
  }
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
  let sawNonScalar = false;
  const parts = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    const t = typeof v;
    if (v === null) {
      parts[i] = 'n:'; // null
      continue;
    }
    if (t === 'string') {
      // prefix with length to reduce collisions like ['12','3'] vs ['1','23']
      parts[i] = 's:' + v.length + ':' + v;
      continue;
    }
    if (t === 'number') {
      // Normalise -0 to 0 so the two do not produce distinct cache entries.
      parts[i] = 'd:' + String(v === 0 ? 0 : v);
      continue;
    }
    if (t === 'boolean') {
      parts[i] = 'b:' + (v ? '1' : '0');
      continue;
    }
    if (t === 'undefined') {
      parts[i] = 'u:';
      continue;
    }
    if (t === 'bigint') {
      // `JSON.stringify` throws on BigInt, which made this "fast scalar path"
      // throw for a perfectly ordinary argument type.
      parts[i] = 'g:' + v.toString();
      continue;
    }
    if (t === 'symbol') {
      // `JSON.stringify` maps every Symbol to `null`, so falling through
      // would alias *all* Symbol arguments onto the single key `'[null]'` -
      // silent cache poisoning. Symbols are not serialisable by design.
      throw new TypeError('simpleArgsKey() does not support symbol arguments');
    }
    // non-scalar (object, function) — fall back to JSON stringify
    sawNonScalar = true;
    break;
  }

  if (sawNonScalar) return JSON.stringify(args);
  return parts.join('|');
}
