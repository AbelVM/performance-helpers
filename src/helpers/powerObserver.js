/**
 * Lightweight reactive value store.
 * Subscribers are called synchronously when the value changes.
 *
 * @class PowerObserver
 * @public
 *
 * Example:
 * const obs = new PowerObserver(42);
 * obs.subscribe((next, prev) => console.log(next, prev));
 * obs.value = 99;
 */
/**
 * @typedef {import('./jsdoc-types.js').PowerObserverOptions} PowerObserverOptions
 */
import { PowerScheduler } from './powerScheduler.js';
import { PowerSubscriberSet } from './powerSubscriberSet.js';

/**
 * Translate a source's internal schedule mode into a constructor `async` option.
 *
 * `_scheduleMode` is `'sync' | 'microtask' | 'macrotask'`, but the constructor
 * does **not** accept the string `'sync'` - sync is spelled `false`. Passing the
 * string falls through to the final `else`, which quietly yields `'microtask'`.
 * That is why an earlier version of the derived chain appeared to inherit the
 * mode and did not: nothing was wrong with the inheritance, only with the
 * encoding of it.
 *
 * @param {PowerObserver} source
 * @returns {boolean|'microtask'|'macrotask'} A value the `async` option accepts.
 * @private
 */
function inheritedAsync(source) {
  const mode = source._scheduleMode;
  return mode === 'microtask' || mode === 'macrotask' ? mode : false;
}

/**
 * Wire an observer so that its upstream subscriptions are created on first
 * subscribe and dropped on last unsubscribe.
 *
 * @param {PowerObserver} out - The derived observer.
 * @param {() => void} attach
 * @param {() => void} detach
 * @returns {PowerObserver} `out`, with `subscribe` and `dispose` replaced.
 * @private
 */
function lazyChain(out, attach, detach) {
  /** @type {any} */
  const target = out;
  const innerAdd = target.subscribe.bind(target);
  target.subscribe = (/** @type {(next:any, prev:any)=>void} */ fn) => {
    attach();
    const off = innerAdd(fn);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      if (out.size === 0) detach();
    };
  };
  target.dispose = () => {
    detach();
    target.clear();
  };
  return target;
}

/**
 * Build a derived observer over `source`.
 *
 * @param {PowerObserver} source
 * @param {(value:any, prev:any)=>any} map - Produce the derived value.
 * @param {(next:any, prev:any)=>boolean} emit - Whether to propagate this change.
 * @param {string} name - For error messages.
 * @returns {PowerObserver}
 * @private
 */
function derived(source, map, emit, name) {
  if (typeof map !== 'function') {
    throw new TypeError(`PowerObserver.${name}() requires a function`);
  }
  const out = new PowerObserver(map(source.value, undefined), {
    async: inheritedAsync(source),
  });
  /** @type {(() => void)|null} */
  let release = null;
  return lazyChain(
    out,
    () => {
      if (release) return;
      release = source.subscribe((next, prev) => {
        if (!emit(next, prev)) return;
        out.value = map(next, prev);
      });
    },
    () => {
      if (!release) return;
      release();
      release = null;
    }
  );
}

export class PowerObserver {
  /**
   * Create a new PowerObserver.
   * @param {*} initial Initial value
   * @param {PowerObserverOptions} options
   */
  constructor(initial, options = {}) {
    this._value = initial;
    this._subs = new PowerSubscriberSet();
    this._map = typeof options.map === 'function' ? options.map : null;
    this._distinct = !!options.distinct;

    // Cached `map(this._value)`, so a `map` on the hot path runs once per set
    // rather than twice. A dedicated `_mappedValid` flag rather than a sentinel
    // `undefined`, because `undefined` is a perfectly legal mapped value.
    // The initial value is deliberately *not* mapped here: calling a user's
    // mapper from the constructor would be a side effect at construction time
    // that nobody asked for. The first `set` maps it once, lazily.
    /** @type {*} */
    this._mapped = undefined;
    this._mappedValid = false;

    // scheduling: true (microtask) by default, false => sync, or string mode
    if (options.async === undefined) this._scheduleMode = 'microtask';
    else if (options.async === true) this._scheduleMode = 'microtask';
    else if (options.async === false) this._scheduleMode = 'sync';
    else if (options.async === 'microtask' || options.async === 'macrotask')
      this._scheduleMode = options.async;
    else this._scheduleMode = 'microtask';

    // batching state for scheduled notifications
    this._pending = false;
    this._pendingPrev = undefined;
    this._pendingNext = undefined;
    this._scheduler = new PowerScheduler(() => this._flushPending(), {
      scheduling: this._scheduleMode === 'macrotask' ? 'macrotask' : 'microtask',
    });
  }

  /** Current value */
  get value() {
    return this._value;
  }

  /** Set value and schedule notification according to `async` option */
  set value(v) {
    const prev = this._value;
    this._value = v;

    const mapFn = this._map;
    // `mappedPrev` is `map(prev)`, and `prev` is the value this observer
    // already held - which is exactly what the last `set` mapped. Reusing that
    // is the whole point: the old code called the user's mapper on both sides of
    // every write, so a two-call mapper with a `distinct` check in the middle
    // meant the mapper was the most-executed code in the class. The first `set`
    // after construction has nothing cached and maps once, which is the one
    // unavoidable extra call.
    const mappedPrev = this._mappedValid ? this._mapped : mapFn ? mapFn(prev) : prev;
    const mappedNext = mapFn ? mapFn(v) : v;
    this._mapped = mappedNext;
    this._mappedValid = true;

    if (this._distinct && Object.is(mappedPrev, mappedNext)) return;

    if (this._scheduleMode === 'sync') {
      // deliver immediately
      const subs = this._subs.values();
      for (const s of subs) {
        try {
          s(mappedNext, mappedPrev);
        } catch (e) {
          // swallow subscriber errors
        }
      }
      return;
    }

    if (!this._pending) {
      this._pending = true;
      this._pendingPrev = mappedPrev;
      this._pendingNext = mappedNext;
      this._scheduler.schedule();
    } else {
      // already scheduled: update next value, keep original prev
      this._pendingNext = mappedNext;
    }

    return;
  }

  /**
   * Subscribe to changes. Returns an unsubscribe function.
   * @param {(next:any, prev:any)=>void} fn
   */
  subscribe(fn) {
    return this._subs.add(fn);
  }

  /** Remove all subscribers */
  clear() {
    this._subs.clear();
  }

  /** Number of subscribers */
  get size() {
    return this._subs.size;
  }

  /**
   * Set or replace the mapping function used for notifications.
   *
   * @param {?((value:any)=>any)} fn - `null` clears the mapping. Anything
   *   that is not a function and not `null` throws rather than silently
   *   disabling mapping, because a typo'd option is otherwise invisible.
   * @returns {void}
   */
  map(fn) {
    // The cached mapped value belongs to the *previous* mapping function, so
    // swapping the mapper invalidates it. Forgetting this would make the next
    // set report a `prev` that no mapper ever produced.
    this._mappedValid = false;
    this._mapped = undefined;
    if (fn == null) this._map = null;
    else if (typeof fn !== 'function') throw new TypeError('map must be a function');
    else this._map = fn;
  }

  /**
   * Create a **derived** observer: a new observer whose value is recomputed from
   * this one, and which only exists as long as something subscribes to it.
   *
   * `map()` *mutates* this observer's mapping and returns nothing; this is the
   * pure counterpart, so chains can be built without disturbing the source.
   *
   * ```js
   * const label = user.derive((u) => u.name).filter((n) => n.length > 0);
   * const off = label.subscribe((name) => render(name));
   * ```
   *
   * **The upstream subscription is created on first subscribe and released on
   * last unsubscribe.** That is the whole difficulty with derived observables
   * and the reason a naive version leaks: a chain of ten `derive` calls held by
   * one consumer keeps all ten upstreams alive, and a consumer that unsubscribes
   * and is collected leaves every one of them running. Nothing is subscribed
   * until someone asks, and everything is released when they stop.
   *
   * **While nobody is subscribed, the derived value is a snapshot, not a live
   * value** — the value captured when the chain was built. That is the direct
   * cost of not subscribing, and it is why a consumer that wants a live value has
   * to subscribe.
   *
   * @param {(value:any, prev:any)=>any} fn - Derive the next value.
   * @returns {PowerObserver} A new observer, already holding `fn(this.value)`.
   */
  derive(fn) {
    return derived(this, fn, () => true, 'derive');
  }

  /**
   * Only notify subscribers when `predicate` passes. The derived value is the
   * last value that *passed*, so a filtered stream cannot be read as "the latest
   * upstream value".
   *
   * @param {(value:any, prev:any)=>boolean} predicate
   * @returns {PowerObserver}
   */
  filter(predicate) {
    if (typeof predicate !== 'function') {
      throw new TypeError('PowerObserver.filter() requires a function');
    }
    return derived(
      this,
      (v) => v,
      (next, prev) => Boolean(predicate(next, prev)),
      'filter'
    );
  }

  /**
   * Only notify when the value actually changes, using `Object.is` so `NaN`
   * equals itself and `-0` does not equal `0`. This is per-derived-observer and
   * does not change the source, unlike the `distinct` constructor option.
   *
   * @returns {PowerObserver}
   */
  distinct() {
    return derived(
      this,
      (v) => v,
      (next, prev) => !Object.is(next, prev),
      'distinct'
    );
  }

  /**
   * Combine several observers into one that emits whenever **any** of them
   * changes, with the latest value of each.
   *
   * ```js
   * const both = PowerObserver.combineLatest(a, b); // [a.value, b.value]
   * ```
   *
   * Like every derived observer, it subscribes upstream on first use and releases
   * on last unsubscribe.
   *
   * @param {...PowerObserver} sources
   * @returns {PowerObserver}
   */
  static combineLatest(...sources) {
    if (sources.length < 2) {
      throw new TypeError('PowerObserver.combineLatest() needs at least two sources');
    }
    for (const src of sources) {
      if (!(src instanceof PowerObserver)) {
        throw new TypeError('PowerObserver.combineLatest() takes PowerObserver instances only');
      }
    }
    const read = () => sources.map((s) => s.value);
    const out = new PowerObserver(read(), { async: inheritedAsync(sources[0]) });
    /** @type {(() => void)[]|null} */
    let releases = null;
    const attach = () => {
      if (releases) return;
      releases = sources.map((src) =>
        src.subscribe(() => {
          out.value = read();
        })
      );
    };
    const detach = () => {
      if (!releases) return;
      for (const off of releases) {
        try {
          off();
        } catch {
          /* already released */
        }
      }
      releases = null;
    };
    return lazyChain(out, attach, detach);
  }

  /**
   * Flush any pending notification immediately. Useful for tests or shutdown.
   */
  flush() {
    this._scheduler.flush();
  }

  /** Alias for flush() */
  drain() {
    this.flush();
  }

  /** Internal flush implementation */
  _flushPending() {
    if (!this._pending) return;
    this._pending = false;
    const prev = this._pendingPrev;
    const next = this._pendingNext;
    this._pendingPrev = undefined;
    this._pendingNext = undefined;
    const subs = this._subs.values();
    for (const s of subs) {
      try {
        s(next, prev);
      } catch (e) {
        // swallow
      }
    }
  }
}

export default PowerObserver;
