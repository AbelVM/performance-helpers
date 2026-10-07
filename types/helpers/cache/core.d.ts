/**
 * PowerCache
 *
 * In-memory cache with weight-aware eviction, TTLs and optional cleanup.
 * Provides MRU/LRU iteration helpers and hooks for eviction/expiration.
 *
 * @class PowerCache
 * @public
 */
/**
 * Every option `PowerCache` accepts, in one place.
 *
 * CACHE-013: `PowerTimedCache` needs to validate the `cacheOptions` it forwards, and
 * the first version of that fix hand-copied this list. It was wrong in four places —
 * it carried `ttl`, `weight`, `keyResolver` and `cacheOptions`, none of which this
 * constructor accepts, and it **omitted `seed`** — so a wrapper advertised options the
 * cache behind it rejected. Two numbers in one file disagreeing is the failure this
 * repository keeps paying for; a *third* copy of a 22-item list would guarantee it.
 *
 * `PowerTimedCache` therefore derives its own allowlist from this array rather than
 * restating it, and `test/powerTimedCache.delegation.test.js` checks the two against
 * each other through the error message, which prints the enforced set.
 *
 * @type {ReadonlyArray<string>}
 */
export const POWER_CACHE_OPTIONS: ReadonlyArray<string>;
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
    constructor(options?: PowerCacheOptions, ...args: any[]);
    maxEntries: number;
    maxInflightRefreshes: number;
    maxWeight: number;
    maxPoolSize: number;
    weightFn: ((arg0: any) => number) | null;
    defaultTTL: number;
    /**
     * Serve a stale value on `getOrSet`/`getOrSetAsync` by default, so a caller
     * does not have to pass `staleWhileRevalidate` at every call site. The
     * per-call flag still wins, and `false` here does not remove the per-call
     * option - it only stops it being the default.
     */
    allowStale: boolean;
    staleTtl: number;
    /** @type {Function|null} */
    fetchMethod: Function | null;
    _now: () => number;
    rejectOversized: boolean;
    onEvict: ((arg0: any, arg1: any, arg2: string) => void) | null;
    onError: ((arg0: any, arg1: string) => void) | null;
    /** number of times `weightFn` threw; a non-zero value means `maxWeight`
     *  could not be enforced. It used to say "should be surfaced by the caller"
     *  and could not be, because nothing in `stats()` carried it (CACHE-011);
     *  `stats().weightErrors` is where a caller reads it now, and `attach()`
     *  flattens that into a metric series. */
    _weightErrors: number;
    onExpire: ((arg0: any, arg1: any) => void) | null;
    maxCleanupPerTick: number;
    _map: Map<any, any>;
    /** @type {CacheNode|null} */
    _head: CacheNode | null;
    /** @type {CacheNode|null} */
    _tail: CacheNode | null;
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
    _pool: CacheNode[];
    _currentWeight: number;
    _hits: number;
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
    _staleServes: number;
    _misses: number;
    _evictions: number;
    _refreshesSkipped: number;
    _refreshesFailed: number;
    _refreshesAborted: number;
    _rejected: number;
    _rejectedAdmission: number;
    _expirations: number;
    _cleanupTimer: any;
    _cleanupRunning: boolean;
    _cleanupParams: {
        interval: number;
        maxCleanupPerTick: number;
    } | null;
    /** @type {CacheNode|null} */
    _cleanupCursor: CacheNode | null;
    _cleanupCursorValid: boolean;
    _evictionCandidate: import("../jsdoc-types.js").CacheNode | null;
    /**
     * SIEVE eviction hand pointer. Scans from tail toward head during eviction.
     * Visited entries get a second chance (bit cleared), unvisited are evicted.
     * @type {CacheNode|null}
     */
    _sieveHand: CacheNode | null;
    /**
     * S3-FIFO Small queue head/tail/size. Holds the newest entries as a filter
     * for one-hit wonders. Promoted to Main when Main has room.
     * @type {CacheNode|null}
     */
    _smallHead: CacheNode | null;
    /** @type {CacheNode|null} */
    _smallTail: CacheNode | null;
    /** @type {number} */
    _smallSize: number;
    /**
     * S3-FIFO Ghost queue head/tail/size. Metadata-only FIFO of recently evicted
     * keys, used to fast-track re-admission directly to Main.
     * @type {CacheNode|null}
     */
    _ghostHead: CacheNode | null;
    /** @type {CacheNode|null} */
    _ghostTail: CacheNode | null;
    /** @type {number} */
    _ghostSize: number;
    /** @type {number} Max entries in the Small queue. */
    _smallMaxSize: number;
    /** @type {number} Max entries in the Ghost queue. */
    _ghostMaxSize: number;
    /** @type {Map<string, CacheNode>} Key -> ghost node for O(1) lookup. */
    _ghostMap: Map<string, CacheNode>;
    /** @type {Map<string, CacheNode>} Small queue entries for S3-FIFO. */
    _smallMap: Map<string, CacheNode>;
    /**
     * Eviction policy. `'lru'` (default) keeps the previous single-recency-list
     * behaviour. `'slru'` splits the list into a probation segment and a
     * protected segment and promotes on access, which makes the cache far more
     * resistant to a one-off sequential scan evicting the working set.
     * `'sieve'` uses the SIEVE algorithm (NSDI '24): a FIFO queue with a
     * visited bit per entry and a scanning hand pointer. On eviction, the hand
     * scans toward the head; visited entries get their bit cleared (second
     * chance), unvisited entries are evicted.
     * `'s3fifo'` uses the S3-FIFO algorithm (SOSP '23): three static FIFO queues
     * (Small, Main, Ghost) for workload-oblivious high hit ratios.
     */
    _policy: string;
    /**
     * Frequency sketch backing `{ admission: 'tinylfu' }`, or `null` when
     * admission is off. See {@link SmallLfuSketch}.
     * @type {SmallLfuSketch|null}
     * @private
     */
    private _sketch;
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
    private _windowSize;
    _windowStartMemo: import("../jsdoc-types.js").CacheNode | null;
    _windowTail: import("../jsdoc-types.js").CacheNode | null;
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
    _probationEnd: CacheNode | null;
    _inflightPromises: Map<any, any>;
    _inflightControllers: Map<any, any>;
    _defaultAsyncTimeout: number;
    _metrics: {
        unregister: () => boolean;
        name: string;
    } | null;
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
    private _allocNode;
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
    private _computeWeight;
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
    private _notifyError;
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
    private _freeNode;
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
    private _removeExpiredNode;
    /**
     * Fetch a node and validate expiry.
     * @public
     * @param {*} key
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @param {boolean} [options.countMiss=false]
     * @param {boolean} [options.allowExpired=false] Return an expired node instead
     *   of `null`. Read by `_fetchValidNode` and passed by `getOrSet` when
     *   `staleWhileRevalidate` is on; previously read but never documented, so it
     *   was missing from the declared options type.
     * @param {number} [options.now] A clock reading the caller has already taken.
     *   Threading it in halves the clock reads on the hot path (PERF-003):
     *   `getOrSet` and `touch` each read the clock and then called this, which read
     *   it again — and `utils/now.js` puts `nowMs()` at 141 ns and calls it "on the
     *   hot path of essentially every helper". Omit it and this reads its own, so
     *   the callers that have no reading to pass are unaffected.
     * @returns {CacheNode|null}
     */
    public _fetchValidNode(key: any, { ignoreExpiry, countMiss, allowExpired, now: providedNow, }?: {
        ignoreExpiry?: boolean;
        countMiss?: boolean;
        allowExpired?: boolean;
        now?: number;
    }): CacheNode | null;
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
    private _staleServable;
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
    private _abortInflight;
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
    private _refreshStaleEntry;
    /**
     * Append a node to the tail (mark it most-recently used).
     * This updates the linked-list pointers appropriately and is used when
     * inserting new nodes or promoting a node to MRU.
     *
     * @private
     * @param {CacheNode} node - Node to append at the tail.
     * @returns {void}
     */
    private _append;
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
    private _insertIntoProbation;
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
    private _unlinkNode;
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
    private _remove;
    /** @param {CacheNode} node */
    _s3fifoAppendSmall(node: CacheNode): void;
    /** @param {CacheNode} node */
    _s3fifoAppendMain(node: CacheNode): void;
    /** @param {CacheNode} node */
    _s3fifoAppendGhost(node: CacheNode): void;
    /** @param {CacheNode} node */
    _s3fifoRemoveFromSmall(node: CacheNode): void;
    /** @param {CacheNode} node */
    _s3fifoRemoveFromGhost(node: CacheNode): void;
    /**
     * Move an existing node to the tail (mark as most-recently used).
     * Implemented as an unlink followed by an append. No-op when node is
     * already the tail.
     *
     * @private
     * @param {CacheNode} node - Node to promote to MRU position.
     * @returns {void}
     */
    private _moveToTail;
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
     * **The walk is memoised, and the memo is validated rather than maintained.**
     * This is deliberately not the maintained pointer the note above describes as
     * having failed: a pointer has to be *corrected* by every mutation, and the
     * way it went wrong was producing a confidently wrong answer, because a node
     * with a correct `inWindow` flag can still sit on the wrong side of the
     * boundary. Here the memo can only be **trusted or discarded**, never
     * adjusted, so a mistake in reasoning about some mutation costs a walk and
     * nothing else — and the conditions below are each individually
     * necessary, so the failure mode is a stale memo rather than a wrong one.
     *
     * The memo is valid when the walk would return the same node, and the two
     * checks are the complete set of ways that can stop being true:
     *
     * 1. `memo.prev === null || !memo.prev.inWindow`. If the node *before* the
     *    memo is now flagged, the memo is no longer the start of the run.
     * 2. `this._windowTail === this._tail`, where `_windowTail` is the tail at the
     *    moment of the walk. This is what makes a memo written before an unlink
     *    comparable to the list afterwards: the tail is unchanged, the removed node
     *    was not the memo, and the run's start is genuinely unmoved — so a walk
     *    would return the same node and skipping it is correct.
     *
     * **There is deliberately no `memo.inWindow` check**, and it was there first.
     * It is redundant rather than merely untested: every way a node stops being
     * flagged is a promotion or a drop, and both of those *unlink* it, and `_remove`
     * discards the memo for any window node it unlinks. Deleting the check left
     // every test in `test/powerCache.window.test.js` passing, and the reason it
     * is safe to delete is that `_remove` is the single funnel every unlink passes
     * through. The same test run is what established it — the check had survived
     * deleting it, which is how a guard nobody has watched fail gets deleted
     * instead of justified.
     *
     * **There is also no `memo === this._tail` condition**, and the first draft of
     * this had one. The walk starts at the tail and walks *backwards*, so the
     * window's oldest node is the tail only when the window holds a single entry —
     * requiring it made the memo miss on *every* read while a multi-entry window was
     * resident, which is precisely the case the row is about. It measured 1.00
     * calls per get and zero benefit, and the diagnostic that found it printed which
     * condition had failed rather than a bare count.
     *
     * The case that is *not* free is a node removed from the window **immediately
     * before the memo**, which moves the run's start without touching the tail or
     * the memo. That is one unlink, and it is covered by the same rule the rest
     * of this class uses: any unlink of a window node drops the memo, because
     * `_remove` cannot know whether it removed the run's start and a wrong guess
     * is the failure this whole design exists to avoid. Dropping it costs one
     * walk, which is what the walk is for.
     *
     * @private
     * @returns {CacheNode|null}
     */
    private _windowOldest;
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
    private _windowVictim;
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
    private _insertAtMainSpaceMrU;
    /**
     * Move a node out of the window and into main space, in front of the window.
     *
     * @private
     * @param {CacheNode} node - A linked window node.
     * @returns {void}
     */
    private _promoteFromWindow;
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
    private _evictNode;
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
    private _arbitrateWindow;
    /**
     * Evict nodes from the head (least-recently used) until the cache
     * satisfies both `maxEntries` and `maxWeight` constraints. For each
     * evicted node `onEvict` is invoked if provided and the node is returned
     * to the node pool via `_freeNode`.
     *
     * @private
     * @returns {void}
     */
    private _evictIfNeeded;
    /** SIEVE eviction: scan from tail, clear visited bits, evict first unvisited. */
    _sieveEvict(): void;
    /** S3-FIFO eviction: enforce Small, Main, and Ghost queue limits. */
    _s3fifoEvict(): void;
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
    private _expiresAt;
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
    private _rejectIfOversized;
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
    private _insertNew;
    /**
     * Set a value in the cache (add or update).
     * Marks the entry as most-recently used.
     * If `rejectOversized` is enabled and the computed/explicit weight exceeds `maxWeight`,
     * the insertion will be rejected and `set` returns `false` (otherwise returns `this`).
     * @param {*} key - Cache key
     * @param {*} value - Value to store
     * @param {Object} [options]
     * @param {number} [options.ttl] - Time-to-live in ms. Use `null` or `Infinity` to disable expiration.
     * @param {number|null} [options.weight] - Optional explicit weight for the entry. If omitted, `weightFn` is used.
     * @returns {this|false} `this` on success, or `false` when insertion was rejected due to oversize.
     */
    set(key: any, value: any, { ttl, weight }?: {
        ttl?: number | undefined;
        weight?: number | null | undefined;
    }): this | false;
    /**
     * Overwrite an entry that is already in the cache.
     *
     * Shared by `set` and `setMany`. Split out for the same reason as the insert
     * path above: `setMany` had its own copy of this arithmetic too, so the two
     * had already drifted on the TTL and on admission before the weight bookkeeping
     * was checked.
     *
     * @private
     * @param {*} node - The already-fetched node from `_map`, passed in rather than
     *   re-fetched. This used to take a `key` and call `this._map.get(key)` itself,
     *   which made every caller read the map twice — see PERF-003 at the call site.
     * @param {*} value
     * @param {number} w - Already-computed weight.
     * @param {number} expiresAt - Already-computed absolute expiry.
     * @returns {void}
     */
    private _updateExisting;
    /**
     * Retrieve a value and mark it as recently used.
     * @param {*} key
     * @returns {*|undefined} The stored value or `undefined` if missing/expired.
     */
    get(key: any): any | undefined;
    /**
     * Get a value without updating recency.
     * Returns `undefined` for missing or expired entries.
     * @param {*} key
     * @returns {*|undefined}
     */
    peek(key: any): any | undefined;
    /**
     * Check membership without affecting recency.
     * @param {*} key
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false] If true, consider expired entries as present.
     * @returns {boolean}
     */
    has(key: any, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): boolean;
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
    getOrFetch(key: any, factory?: Function, options?: PowerCacheGetOrFetchOptions): Promise<any>;
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
    getOrSet(key: any, factory: Function | any, { ttl, weight, staleWhileRevalidate }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
    }): any | Promise<any>;
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
    setMany(entries: Iterable<[any, any]>, { ttl, weight }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
    }): this;
    /**
     * Bulk get multiple keys. Returns a Map of found entries.
     * @param {Iterable<*>} keys
     * @param {Object} [options]
     * @param {boolean} [options.ignoreExpiry=false]
     * @returns {Map<string, *>} One entry per resolved key, in input order.
     */
    getMany(keys: Iterable<any>, { ignoreExpiry }?: {
        ignoreExpiry?: boolean | undefined;
    }): Map<string, any>;
    /**
     * Touch an entry: update its recency and optionally refresh TTL without
     * reading or modifying the stored value.
     * @param {*} key
     * @param {number} [ttl] - Optional per-call TTL in ms. Use `null`/`Infinity` to disable expiry.
     * @returns {boolean} True if the entry existed (and was not expired), false otherwise.
     */
    touch(key: any, ttl?: number): boolean;
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
    getOrSetAsync(key: any, asyncFactory: Function, { ttl, weight, staleWhileRevalidate, timeout, }?: {
        ttl?: number | undefined;
        weight?: number | undefined;
        staleWhileRevalidate?: boolean | undefined;
        timeout?: number | undefined;
    }): Promise<any>;
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
     * @param {{ignoreExpiry?: boolean, maxNodes?: number, compareFn?: function(any, any): boolean}} [options]
     *   `ignoreExpiry` considers expired entries as present; `maxNodes` bounds how far
     *   the scan goes and `compareFn` replaces the default deep comparison.
     * @returns {boolean}
     */
    hasEqual(key: any, value: any, options?: {
        ignoreExpiry?: boolean;
        maxNodes?: number;
        compareFn?: (arg0: any, arg1: any) => boolean;
    }): boolean;
    /**
     * Delete an entry from the cache.
     * @param {*} key
     * @returns {boolean} true if the key was removed.
     */
    delete(key: any): boolean;
    /**
     * Remove every entry the predicate selects, and return how many went.
     *
     * The row that asked for this (`GAP-017`) also asked for
     * `entriesAscending()` / `entriesDescending()`. **Those are not added**, and
     * the reason is worth more than the two methods would be: `entries(order)`
     * already takes `'LRU'` and `'MRU'`, so an alias pair for the same two orders
     * is a second spelling of one decision, and a second spelling is a second
     * thing to document, to type, to test and to keep in sync. Every reference
     * implementation checked has them because it does **not** have an order
     * parameter — this one does, and the parameter is the whole capability.
     *
     * The predicate is evaluated over a **snapshot** of the entries before any of
     * them is removed. Two reasons, and the second is the important one:
     *
     * 1. `entries()` documents that removing two *adjacent* entries in one
     *    iteration step can end its walk early, so driving removal off the public
     *    generator would silently drop matches. This walks the list directly
     *    instead, and the list is not being mutated while the predicate runs.
     * 2. A predicate that throws leaves the cache **untouched**. Collecting first
     *    means a failure cannot leave half the entries gone, which is the one
     *    outcome a bulk-removal API must never produce — there is no way to undo
     *    it and no counter that would tell a caller which half survived.
     *
     * @param {(key: *, value: *) => boolean} predicate - Return truthy to remove.
     * @returns {number} Entries removed.
     */
    invalidate(predicate: (key: any, value: any) => boolean): number;
    /**
     * Evict up to `count` entries, least-recently-used first, and return how many
     * went.
     *
     * Distinct from the sweep `maxEntries` drives, which evicts until the cache is
     * *within* its limit and reports no number. This is the explicit version: a
     * caller shedding memory before a spike, or after a deploy, wants a count and a
     * return value, not a cache that happens to be smaller.
     *
     * `count` above the current size removes everything and reports the real
     * number removed rather than the number asked for — reporting the request
     * would make `evict(1e9)` on an empty cache report 1000000000.
     *
     * `count` must be a `number`, and `Number()` is deliberately **not** used to
     * coerce: it would turn `null` into 0, `true` into 1 and `'3'` into 3, so
     * `evict(null)` would silently do nothing and `evict(true)` would silently evict
     * one. This is the same rule the TTL normaliser in this class already applies,
     * for the same reason — a typo in a count must not read as a deliberate value.
     *
     * @param {number} [count=1]
     * @returns {number} Entries removed.
     */
    evict(count?: number): number;
    /**
     * Clear the cache and return nodes to the pool.
     * @returns {void}
     */
    clear(): void;
    /**
     * Remove expired entries by scanning from least-recently used to most.
     * @returns {void}
     */
    /**
     * @returns {number} How many expired entries the sweep removed.
     */
    cleanupExpired(): number;
    /**
     * Cleanup expired entries, scanning up to `maxScan` nodes.
     * Scanning resumes from an internal cursor so repeated small passes will cover the list
     * without repeatedly scanning the head of a very large cache. When the end is reached the
     * cursor wraps to the head.
     * @param {number} [maxScan=Infinity] Maximum nodes to scan in this pass.
     * @returns {number} Number of nodes scanned
     */
    cleanupExpiredUpTo(maxScan?: number): number;
    /**
     * Start periodic, non-blocking cleanup.
     * Accepts either a numeric interval (ms) or an options object `{ interval, maxCleanupPerTick }`.
     * The loop is implemented with `setTimeout` and scans up to `maxCleanupPerTick` nodes per pass
     * to avoid long event-loop stalls.
     * Note: call `stopCleanup()` to stop the periodic timer (for example, on application shutdown)
     * to ensure the internal timer is cleared and resources can be reclaimed.
     * @param {number|{interval?: number, intervalMs?: number, maxCleanupPerTick?: number}} [intervalOrOptions] -
     *   Cleanup interval in ms, or an options object. Written as one type expression rather
     *   than a bare `{Object}` with nested `@param` tags: those tags are only valid when
     *   the parent is a bare object, so the earlier spelling had to be `{number|Object}`
     *   and every property read off it was an error. Spelling the shape out removes the
     *   reason the nested tags were dropped.
     * @returns {void}
     */
    startCleanup(intervalOrOptions?: number | {
        interval?: number;
        intervalMs?: number;
        maxCleanupPerTick?: number;
    }): void;
    /**
     * Stop periodic cleanup.
     * @returns {void}
     */
    stopCleanup(): void;
    /**
     * Synchronous disposal hook (TC39 Explicit Resource Management).
     * Stops any background cleanup and clears the cache.
     */
    /**
     * Named alias for the `Symbol.dispose` implementation, so callers who do not
     * want to reach for the symbol still have something to call.
     * @returns {void}
     */
    dispose(): void;
    /**
     * Prototype tick used by the cleanup timer loop. Separated to avoid
     * allocating a per-call closure inside `startCleanup()`.
     * @private
     */
    private _cleanupTick;
    /**
     * Current number of entries in cache.
     * @returns {number}
     */
    get size(): number;
    /**
     * Hit rate as a fraction (hits / (hits + misses)).
     * @returns {number}
     */
    get hitRate(): number;
    /**
     * Return runtime statistics for the cache.
     *
     * Two of these counters were unreachable until CACHE-011, and both are read
     * for opposite reasons. `rejectedAdmission` is the *policy working*: non-zero
     * under `admission: 'tinylfu'` is what makes a scan-resistant cache
     * scan-resistant, so a benchmark that reports zero rejections has measured
     * nothing and a monitoring dashboard that expects a non-zero floor after a
     * traffic shift should be told the filter stopped running.
     * `weightErrors` is the opposite — a swallowed failure. `weightFn` threw, the
     * throw was routed to `onError` if one exists, and the entry was skipped; a
     * cache silently under-weighting itself will evict too much, or too little, and
     * nothing else in this object moves when it does.
     *
     * Both were private fields with tests reading them directly, which is the tell
     * that they were meant to be public: `PowerCache` publishes the rest of its
     * counters here and lets `attach()` flatten them into metric series, so a
     * field missing from `stats()` is a field no collector can ever see.
     *
     * @returns {{size:number, weight:number, hits:number, misses:number, staleServes:number,
     *   evictions:number, expirations:number, rejected:number, rejectedAdmission:number,
    *   weightErrors:number, refreshesSkipped:number, refreshesFailed:number,
    *   refreshesAborted:number, poolSize:number}}
     */
    stats(): {
        size: number;
        weight: number;
        hits: number;
        misses: number;
        staleServes: number;
        evictions: number;
        expirations: number;
        rejected: number;
        rejectedAdmission: number;
        weightErrors: number;
        refreshesSkipped: number;
        refreshesFailed: number;
        refreshesAborted: number;
        poolSize: number;
    };
    /**
     * Alias for {@link stats}.
     *
     * See `guides/stats-naming.md` for why both spellings exist and why this
     * method is written out per class.
     */
    getStats(): {
        size: number;
        weight: number;
        hits: number;
        misses: number;
        staleServes: number;
        evictions: number;
        expirations: number;
        rejected: number;
        rejectedAdmission: number;
        weightErrors: number;
        refreshesSkipped: number;
        refreshesFailed: number;
        refreshesAborted: number;
        poolSize: number;
    };
    /**
     * Resize the cache limits and evict if necessary.
     * @param {Object} options
     * @param {number} [options.maxEntries]
     * @param {number} [options.maxWeight]
     */
    resize({ maxEntries, maxWeight }?: {
        maxEntries?: number | undefined;
        maxWeight?: number | undefined;
    }): void;
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
     * **A recency mutation (`get()`, `touch()`, or `set()` on a key already in the
     * list) relinks the entry to the MRU end, which is behind an MRU-first cursor,
     * so the walk arrives back at it.** Left alone that is an infinite loop, not a
     * wrong answer, and it was reachable from one line of loop body. The walk now
     * visits at most as many entries as existed when it started, which ends the
     * cycle; the entries beyond that point are *not* reported, so a loop that
     * refreshes recency as it goes sees a prefix rather than a full pass. Collect
     * the keys first (`Array.from(cache.keys())`) if you need every entry.
     *
     * @param {'LRU'|'MRU'} [order='MRU']
     * @returns {IterableIterator<[*,*]>}
     */
    entries(order?: "LRU" | "MRU"): IterableIterator<[any, any]>;
    /**
     * Iterate keys in LRU or MRU order.
     * @param {'LRU'|'MRU'} [order='MRU']
     */
    keys(order?: "LRU" | "MRU"): Generator<any, void, unknown>;
    /**
     * Iterate values in LRU or MRU order.
     * @param {'LRU'|'MRU'} [order='MRU']
     */
    values(order?: "LRU" | "MRU"): Generator<any, void, unknown>;
    [Symbol.dispose](): void;
    /**
     * Asynchronous disposal hook. Provided for symmetry with `using`/`await using`.
     * Cache cleanup is synchronous so this simply performs the same actions and
     * returns a resolved Promise for await compatibility.
     */
    [Symbol.asyncDispose](): Promise<void>;
    [Symbol.iterator](): IterableIterator<[any, any]>;
}
export type CacheNode = import("../jsdoc-types.js").CacheNode;
export type PowerCacheOptions = import("../jsdoc-types.js").PowerCacheOptions;
export type PowerCacheGetOrFetchOptions = import("../jsdoc-types.js").PowerCacheGetOrFetchOptions;
export type PowerMemoizerOptions = import("../jsdoc-types.js").PowerMemoizerOptions;
export type PowerTimedCacheOptions = import("../jsdoc-types.js").PowerTimedCacheOptions;
