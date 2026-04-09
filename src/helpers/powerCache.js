/**
 * @typedef {Object} CacheNode
 * @property {*} key
 * @property {*} value
 * @property {number} weight
 * @property {number} expiresAt
 * @property {CacheNode|null} prev
 * @property {CacheNode|null} next
 */

/**
 * @typedef {Object} PowerCacheOptions
 * @property {number} [maxEntries]
 * @property {number} [maxWeight]
 * @property {function(*):number} [weightFn]
 * @property {number} [defaultTTL]
 * @property {number} [maxPoolSize]
 * @property {boolean} [rejectOversized]
 * @property {function(*, *, string):void} [onEvict]
 * @property {function(*, *):void} [onExpire]
 * @property {number} [initialPoolSize]
 * @property {number} [maxCleanupPerTick]
 * @property {boolean} [eagerCleanupOnRead]
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
   * @param {Object} [options]
   * @param {number} [options.maxEntries=Infinity] Maximum number of entries.
   * @param {number} [options.maxWeight=Infinity] Maximum total weight across entries.
   * @param {function(*):number} [options.weightFn] Function to compute weight for a value.
   * @param {number} [options.defaultTTL=60000] Default TTL (ms) for entries.
   * @param {number} [options.maxPoolSize=1000] Maximum node pool size for reuse.
   * @param {boolean} [options.rejectOversized=false] If true, inserting an item whose weight > `maxWeight` will be rejected.
   * @param {function(*, *, string):void} [options.onEvict] Callback invoked when an item is evicted/deleted/rejected. Called as `(key, value, reason)` where reason is `'evicted'|'deleted'|'rejected-oversized'`.
   * @param {function(*, *):void} [options.onExpire] Callback invoked when an item expires. Called as `(key, value)`.
   * @param {number} [options.initialPoolSize=0] Prefill the internal node pool with this many nodes (capped by `maxPoolSize`).
   * @param {number} [options.maxCleanupPerTick=100] Default max nodes scanned per cleanup tick when running `startCleanup()`.
   * @param {boolean} [options.eagerCleanupOnRead=false] If true, `peek()` and `has()` will eagerly remove expired nodes when observed.
   * @throws {TypeError} When a non-object is provided as the options argument.
   */
  constructor({
    maxEntries = Infinity,
    maxWeight = Infinity,
    weightFn = () => 1,
    defaultTTL = 60000,
    maxPoolSize = 1000,
    rejectOversized = false,
    onEvict = null,
    onExpire = null,
    initialPoolSize = 0,
    maxCleanupPerTick = 100,
    eagerCleanupOnRead = false,
    // default timeout (ms) applied to `getOrSetAsync` when callers omit per-call timeout
    defaultAsyncTimeout = 30000,
  } = {}) {
    // Basic options validation: when an explicit options argument is provided it must be an object
    if (arguments.length > 0 && arguments[0] != null && typeof arguments[0] !== 'object') {
      throw new TypeError('PowerCache options must be an object');
    }
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weightFn = weightFn;
    this.defaultTTL = defaultTTL;
    this.maxPoolSize = maxPoolSize;
    this.rejectOversized = Boolean(rejectOversized);
    this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    this.onExpire = typeof onExpire === 'function' ? onExpire : null;
    this.maxCleanupPerTick = Number.isFinite(+maxCleanupPerTick)
      ? Math.max(1, +maxCleanupPerTick)
      : 100;

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
    this._expirations = 0;

    // Backwards-compatible aliases for external access (keep non-underscore
    // properties available but prefer internal `_`-prefixed fields).
    Object.defineProperty(this, 'map', {
      configurable: true,
      enumerable: false,
      get() {
        return this._map;
      },
      set(v) {
        this._map = v;
      },
    });
    Object.defineProperty(this, 'head', {
      configurable: true,
      enumerable: false,
      get() {
        return this._head;
      },
      set(v) {
        this._head = v;
      },
    });
    Object.defineProperty(this, 'tail', {
      configurable: true,
      enumerable: false,
      get() {
        return this._tail;
      },
      set(v) {
        this._tail = v;
      },
    });
    Object.defineProperty(this, 'pool', {
      configurable: true,
      enumerable: false,
      get() {
        return this._pool;
      },
      set(v) {
        this._pool = v;
      },
    });
    Object.defineProperty(this, 'currentWeight', {
      configurable: true,
      enumerable: false,
      get() {
        return this._currentWeight;
      },
      set(v) {
        this._currentWeight = v;
      },
    });
    Object.defineProperty(this, 'hits', {
      configurable: true,
      enumerable: false,
      get() {
        return this._hits;
      },
      set(v) {
        this._hits = v;
      },
    });
    Object.defineProperty(this, 'misses', {
      configurable: true,
      enumerable: false,
      get() {
        return this._misses;
      },
      set(v) {
        this._misses = v;
      },
    });
    Object.defineProperty(this, 'evictions', {
      configurable: true,
      enumerable: false,
      get() {
        return this._evictions;
      },
      set(v) {
        this._evictions = v;
      },
    });
    Object.defineProperty(this, 'rejected', {
      configurable: true,
      enumerable: false,
      get() {
        return this._rejected;
      },
      set(v) {
        this._rejected = v;
      },
    });
    Object.defineProperty(this, 'expirations', {
      configurable: true,
      enumerable: false,
      get() {
        return this._expirations;
      },
      set(v) {
        this._expirations = v;
      },
    });

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
   * @param {boolean} [countMiss=false] - When true, increment the `misses` counter for user-facing lookups.
   */
  _removeExpiredNode(node, now, countMiss = false) {
    // Only remove when the node is actually expired according to `now`.
    if (!node.expiresAt || node.expiresAt > now) return false;
    const k = node.key;
    const v = node.value;
    const next = node.next;
    this._map.delete(k);
    this._currentWeight -= node.weight || 0;
    if (this._cleanupCursor === node) this._cleanupCursor = next;
    this._cleanupCursorValid = Boolean(this._cleanupCursor);
    this._remove(node);
    try {
      if (this.onExpire) this.onExpire(k, v);
    } catch (err) {}
    this._freeNode(node);
    if (countMiss) this._misses++;
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
      this._removeExpiredNode(node, now, countMiss);
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
        } catch (err) {}
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
      return;
    }
    node.prev = this._tail;
    node.next = null;
    this._tail.next = node;
    this._tail = node;
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
      const next = node.next;
      const k = node.key;
      const v = node.value;
      // Advance cleanup cursor if it pointed to the node we're about to evict
      if (this._cleanupCursor === node) this._cleanupCursor = next;
      this._cleanupCursorValid = Boolean(this._cleanupCursor);
      // Advance eviction candidate to the next node (new head after removal)
      this._evictionCandidate = next;
      this._remove(node);
      this._map.delete(k);
      this._currentWeight -= node.weight || 0;
      this._evictions++;
      try {
        if (this.onEvict) this.onEvict(k, v, 'evicted');
      } catch (err) {}
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
    const now = Date.now();
    const expiresAt = ttl == null || ttl === Infinity ? 0 : now + ttl;
    // Compute weight once. Guard against user-supplied weightFn throwing
    // and fall back to 0 if it does or returns a non-finite value.
    let wRaw;
    if (weight != null) {
      wRaw = weight;
    } else {
      try {
        wRaw = this.weightFn(value);
      } catch (err) {
        wRaw = 0;
      }
      if (wRaw == null) wRaw = 0;
    }
    const w = Number.isFinite(+wRaw) ? Math.max(0, +wRaw) : 0;
    // If item is heavier than maxWeight, optionally reject insertion
    if (this.rejectOversized && Number.isFinite(this.maxWeight) && w > this.maxWeight) {
      this._rejected++;
      try {
        if (this.onEvict) this.onEvict(key, value, 'rejected-oversized');
      } catch (err) {}
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
      const node = this._allocNode(key, value, w, expiresAt);
      this._map.set(key, node);
      this._append(node);
      this._currentWeight += node.weight || 0;
      this._evictIfNeeded();
    }
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
    const now = Date.now();
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
        this._removeExpiredNode(node, now, true);
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
          } catch (err) {}
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
    const now = Date.now();
    const expiresAt = ttl == null || ttl === Infinity ? 0 : now + ttl;
    for (const pair of entries) {
      if (!pair) continue;
      const [key, value] = pair;
      let wRaw;
      if (weight != null) wRaw = weight;
      else {
        try {
          wRaw = this.weightFn(value);
        } catch (err) {
          wRaw = 0;
        }
        if (wRaw == null) wRaw = 0;
      }
      const w = Number.isFinite(+wRaw) ? Math.max(0, +wRaw) : 0;

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
   * @returns {Map}
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
    const now = Date.now();
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

    const now = Date.now();
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
        this._removeExpiredNode(node, now, false);
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
            } catch (e) {}
            resolve(v);
          },
          (err) => {
            try {
              clearTimeout(timer);
            } catch (e) {}
            reject(err);
          }
        );
      });
    }

    // Store in inflight map to dedupe concurrent callers
    const tracked = timed
      .then((value) => {
        try {
          this.set(key, value, { ttl, weight });
        } catch (err) {}
        return value;
      })
      .finally(() => {
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
   * @param {WeakMap} [options.seen] Optional reusable `seen` WeakMap for callers that
   *        perform many deep-equality checks and want to avoid per-call allocations.
   * @returns {boolean}
   */
  hasEqual(key, value, { ignoreExpiry = false, seen = undefined } = {}) {
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
    return deepEqual(stored, value, seen);
  }

  /**
   * Variant accepting an explicit `seen` WeakMap for reuse across many checks.
   * @param {*} key
   * @param {*} value
   * @param {WeakMap} seen
   * @param {Object} [options]
   * @param {boolean} [options.ignoreExpiry=false]
   * @returns {boolean}
   */
  hasEqualWithSeen(key, value, seen, { ignoreExpiry = false } = {}) {
    return this.hasEqual(key, value, { ignoreExpiry, seen });
  }

  /**
   * Delete an entry from the cache.
   * @param {*} key
   * @returns {boolean} true if the key was removed.
   */
  delete(key) {
    const node = this._map.get(key);
    if (!node) return false;
    const next = node.next;
    this._map.delete(key);
    this._currentWeight -= node.weight || 0;
    if (this._cleanupCursor === node) this._cleanupCursor = next;
    this._cleanupCursorValid = Boolean(this._cleanupCursor);
    this._remove(node);
    try {
      if (this.onEvict) this.onEvict(node.key, node.value, 'deleted');
    } catch (err) {}
    this._freeNode(node);
    return true;
  }

  /**
   * Clear the cache and return nodes to the pool.
   * @returns {void}
   */
  clear() {
    for (let node = this._head; node; ) {
      const next = node.next;
      this._freeNode(node);
      node = next;
    }
    this._head = this._tail = null;
    this._map.clear();
    this._currentWeight = 0;
    this._cleanupCursor = null;
    this._cleanupCursorValid = false;
    this._evictionCandidate = null;
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
    const now = Date.now();
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
        this._map.delete(k);
        this._currentWeight -= node.weight || 0;
        // advance cursor if it pointed to this node
        if (this._cleanupCursor === node) this._cleanupCursor = next;
        this._cleanupCursorValid = Boolean(this._cleanupCursor);
        this._remove(node);
        try {
          if (this.onExpire) this.onExpire(k, v);
        } catch (err) {}
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
   * @param {number|Object} [intervalOrOptions]
   * @param {number} [intervalOrOptions.interval] Interval between cleanup passes in ms.
   * @param {number} [intervalOrOptions.maxCleanupPerTick] Max nodes to scan per pass.
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
        : Math.max(1000, Math.min(this.defaultTTL || 60000, 60000));
      maxCleanupPerTick = Number.isFinite(+intervalOrOptions.maxCleanupPerTick)
        ? Math.max(1, +intervalOrOptions.maxCleanupPerTick)
        : this.maxCleanupPerTick;
    }
    this.stopCleanup();
    this._cleanupParams = { interval, maxCleanupPerTick };
    // start loop using prototype cleanup tick method
    this._cleanupTimer = setTimeout(() => this._cleanupTick(), interval);
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
      this._cleanupTimer = setTimeout(() => this._cleanupTick(), this._cleanupParams.interval);
      return;
    }
    this._cleanupRunning = true;
    try {
      this.cleanupExpiredUpTo(this._cleanupParams.maxCleanupPerTick);
    } finally {
      this._cleanupRunning = false;
    }
    this._cleanupTimer = setTimeout(() => this._cleanupTick(), this._cleanupParams.interval);
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
 * @param {WeakMap} [seen]
 * @param {number} [depth=0]
 * @returns {boolean}
 */
function deepEqual(a, b, seen = undefined, depth = 0) {
  const MAX_DEEP_EQUAL_DEPTH = 100;
  if (depth > MAX_DEEP_EQUAL_DEPTH) {
    // Fall back to reference equality when we've recursed too deep.
    return a === b;
  }

  if (a === b) return true;
  if (a == null || b == null) return a === b;
  const ta = typeof a,
    tb = typeof b;
  if (ta !== 'object' || tb !== 'object') return a === b;

  if (!seen) seen = new WeakMap();
  let mapForA = seen.get(a);
  if (mapForA?.has(b)) return true;
  if (!mapForA) {
    mapForA = new WeakSet();
    seen.set(a, mapForA);
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
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], seen, depth + 1)) return false;
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
      if (!deepEqual(v, b.get(k), seen, depth + 1)) return false;
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
    for (const itemA of a) {
      let found = false;
      for (const itemB of b) {
        if (deepEqual(itemA, itemB, seen, depth + 1)) {
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
    if (!deepEqual(a[k], b[k], seen, depth + 1)) return false;
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
 * Usage (constructor returns a callable memoized function when given `fn`):
 * const fetcher = async (id) => await fetchData(id)
 * const memoizedFetch = new PowerMemoizer(fetcher, { cacheOptions: { defaultTTL: 1000 } })
 * // call the memoized function directly
 * await memoizedFetch(1)
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
    const {
      keyResolver = (...args) => JSON.stringify(args),
      cacheOptions = {},
      ttl,
      weight,
    } = options;
    this.keyResolver =
      typeof keyResolver === 'function' ? keyResolver : (...args) => JSON.stringify(args);
    this.cache = new PowerCache(cacheOptions);
    // track inflight Promises to deduplicate concurrent calls
    this._inflight = new Map();
    this._defaultMemoizeOptions = {};
    if (ttl !== undefined) this._defaultMemoizeOptions.ttl = ttl;
    if (weight !== undefined) this._defaultMemoizeOptions.weight = weight;

    // If a function is provided at construction time, return the memoized function directly.
    // The returned function has helper methods attached (get, has, delete, clear, stats, cache).
    if (typeof fn === 'function') {
      const memoizedFn = this._memoize(fn, this._defaultMemoizeOptions);
      // attach delegating helpers bound to this PowerMemoizer instance
      memoizedFn.get = (...args) => this.get(...args);
      memoizedFn.has = (...args) => this.has(...args);
      memoizedFn.delete = (...args) => this.delete(...args);
      memoizedFn.clear = () => this.clear();
      memoizedFn.stats = () => this.stats();
      memoizedFn.cache = this.cache;
      memoizedFn.original = fn;
      // Make the returned function behave like an instance so `instanceof PowerMemoizer` works
      try {
        Object.setPrototypeOf(memoizedFn, PowerMemoizer.prototype);
        memoizedFn.constructor = PowerMemoizer;
      } catch (err) {
        // if environment forbids prototype mutation, fall back to returning the function
      }
      return memoizedFn;
    }

    // When no function supplied, keep the instance behavior and require explicit `memoize(fn)`.
    this.run = () => {
      throw new TypeError(
        'No function supplied to PowerMemoizer; call memoize(fn) or construct with a function.'
      );
    };
    this._originalFn = null;
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
  _memoize(fn, { ttl, weight } = {}) {
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const self = this;
    return function memoized(...args) {
      const key = self.keyResolver(...args);
      // return cached value if present (use has() to allow caching `undefined`)
      if (self.cache.has(key)) return self.cache.get(key);
      // if there is an inflight Promise, return it to dedupe
      if (self._inflight.has(key)) return self._inflight.get(key);

      const res = fn(...args);
      // Promise-like
      if (typeof res?.then === 'function') {
        const p = res.then(
          (value) => {
            try {
              self.cache.set(key, value, { ttl, weight });
            } catch (err) {}
            self._inflight.delete(key);
            return value;
          },
          (err) => {
            // do not cache rejections; remove inflight marker
            self._inflight.delete(key);
            throw err;
          }
        );
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
   * @param {Function} fn - Function to memoize
   * @param {Object} [options] - Optional per-wrapper options { ttl, weight }
   * @returns {Function} Memoized function
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
    try {
      Object.setPrototypeOf(memoizedFn, PowerMemoizer.prototype);
      memoizedFn.constructor = PowerMemoizer;
    } catch (err) {
      // ignore environments that forbid prototype mutation
    }
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
  set(key, value, options) {
    return this.cache.set(key, value, options);
  }
  has(key, options) {
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
  startCleanup(intervalOrOptions) {
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
      parts[i] = 'd:' + String(v);
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
    // non-scalar (object, function, symbol) — fall back to JSON stringify
    sawNonScalar = true;
    break;
  }

  if (sawNonScalar) return JSON.stringify(args);
  return parts.join('|');
}
