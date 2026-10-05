import { assertKnownOptions } from '../utils/options.js';
import { neutralise } from '../utils/neutralise.js';

/**
 * A fair mutex shared by every worker in the process, over the platform's Web Locks
 * implementation.
 *
 * `PowerSemaphore` limits concurrency **inside one thread** and every instance is
 * independent, so two workers each get their own permits. `PowerCrossLock` is the
 * other half: one lock, one queue, FIFO, visible to every worker and every thread in
 * the process — and to any other process, because the lock lives in the platform's
 * lock manager rather than in this library.
 *
 * @example
 * const lock = new PowerCrossLock();
 * await lock.run('cache:warm', async () => {
 *   // No other worker or thread can be inside this block for this name.
 *   await warmTheCache();
 * });
 *
 * ## There is no try-acquire, and that is a measurement
 *
 * The obvious missing method is a non-blocking "take it if free", and the obvious
 * implementation is the platform's `ifAvailable` option. **On Node 24.18 `ifAvailable` is
 * a no-op**: it never refuses. Measured with a section queued behind a held lock, the
 * section **ran** — and it also ran when the holder was in a different thread, so this is
 * not a same-client quirk:
 *
 *   lock held, `ifAvailable: true`, same thread  ->  section ran
 *   lock held, `ifAvailable: true`, other thread  ->  section ran
 *
 * So `tryRun()` could only have been built on `query()`-then-`request()`, which is **not
 * atomic** — the lock can change hands between the two calls — and a best-effort answer
 * presented as a guarantee is precisely the silent substitution this library rejects
 * elsewhere. The method is **absent rather than approximated**, and
 * {@link PowerCrossLock#waiterCount} is the honest way to ask whether a name is busy.
 *
 * @class PowerCrossLock
 * @public
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerCrossLockOptions} PowerCrossLockOptions
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerCrossLockRunOptions} PowerCrossLockRunOptions
 */

/**
 * @typedef {import('./jsdoc-types.js').PowerCrossLockStats} PowerCrossLockStats
 */

/**
 * @typedef {{held: Array<{name: string, mode: string, clientId: string}>,
 *           pending: Array<{name: string, mode: string, clientId: string}>}} LockQuery
 */

/**
 * The platform's `LockManager`, or `null` where there is none.
 *
 * **The row this implements named the wrong method, and the correction matters.** It
 * specified `locks.acquire(name, {steal, signal})`; `acquire` is an *earlier Web
 * Locks draft* spelling. What ships — in Node 24.18 and in Chromium and Firefox — is
 * `LockManager.request(name, options, callback)`. Measured on Node 24.18:
 * `worker_threads.locks` exposes exactly `request` and `query` on its prototype, and
 * `acquire` is `undefined`. A wrapper written to the row's spelling would have called
 * `undefined` and thrown `TypeError` on every acquisition.
 *
 * Read through `process.getBuiltinModule` rather than a static import, for the reason
 * `utils/transferable.js` does it: a bundler resolves `node:worker_threads` for a
 * browser build and fails, and this library has to load in a browser to be able to
 * *report* that it does not support locks.
 *
 * @type {?{request: Function, query: Function}}
 */
let manager = null;
let probed = false;

/**
 * @returns {?{request: Function, query: Function}}
 */
function getManager() {
  if (!probed) {
    probed = true;
    try {
      const mod = globalThis.process?.getBuiltinModule?.('node:worker_threads');
      // Node 24.18 exposes the same `LockManager` as `navigator.locks`, and the
      // `navigator` one is what a browser would have — so it is the fallback that
      // makes this work in a browser with a bundler that strips `node:` imports.
      const candidate = mod?.locks ?? globalThis.navigator?.locks ?? null;
      manager =
        candidate &&
        typeof candidate.request === 'function' &&
        typeof candidate.query === 'function'
          ? candidate
          : null;
    } catch {
      manager = null;
    }
  }
  return manager;
}

/**
 * Whether this platform has a cross-worker lock manager at all.
 *
 * `LockManager` is in Node (24.x) and in Chromium and Firefox. It is **not** gated on
 * `crossOriginIsolated` — the row's claim on that point holds, and it is worth stating
 * because it is why this helper needs no SAB fallback, unlike SAB-003 and SAB-004.
 *
 * @returns {boolean}
 */
export function hasCrossWorkerLocks() {
  return getManager() !== null;
}

export class PowerCrossLock {
  /**
   * @param {PowerCrossLockOptions} [options] Configuration.
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['name'], 'PowerCrossLock');
    this._name = options.name === undefined ? '' : options.name;
    if (typeof this._name !== 'string') {
      throw new TypeError('PowerCrossLock: `name` must be a string.');
    }
    /** @type {number} Completed acquisitions on this instance. A counter, not a duration. */
    this._acquisitions = 0;
    /** @type {number} Acquisitions that passed `steal`. */
    this._steals = 0;
    /** @type {number} Acquisitions rejected by an `AbortSignal`. */
    this._aborted = 0;
  }

  /** Whether this platform can honour a cross-worker lock. */
  get supported() {
    return getManager() !== null;
  }

  /**
   * Run `fn` while holding `name`, releasing it however `fn` ends.
   *
   * **Callback-scoped rather than a `release()` function, and that is the API decision.**
   * The plan row asked for `acquire(name, {steal, signal})` returning a handle. A manual
   * release is the wrong shape for a lock shared across worker boundaries: a caller that
   * forgets it wedges *every other worker* for the life of the process, with no error and
   * no local state to inspect. Scoping the lock to the callback makes the release
   * unconditional — a throw, a rejection, and a `return` all release it, because the
   * platform is holding the lock across the callback's promise rather than across a line
   * of the caller's code.
   *
   * ## `steal` is not a polite hand-over
   *
   * **Measured on Node 24.18.** With one holder inside `request()` and a second
   * `request(name, {steal: true})`:
   *
   * - the second callback runs;
   * - the **first holder's `request()` promise rejects** with
   *   `DOMException [AbortError]` (`code: 20`);
   * - the first holder's callback **does not stop** — its work runs to completion while
   *   the lock is free to everyone else.
   *
   * So `steal` means *release now and tell the old owner it lost*. Two things a caller
   * has to design around: the stolen holder **cannot tell a steal from its own signal**
   * (the `AbortError` carries no lock name and no own properties — checked), and the code
   * the previous owner was inside keeps running against whatever invariant the lock was
   * protecting. Hence opt-in per call rather than an instance default, and hence the
   * guide's advice to make the critical section idempotent before using it.
   *
   * @param {string} name - Lock name. Shared by every caller that must exclude the others.
   * @param {() => any} fn - The critical section.
   * @param {PowerCrossLockRunOptions} [options] Per-call options.
   * @returns {Promise<any>} Whatever `fn` returned.
   */
  async run(name, fn, options = {}) {
    assertKnownOptions(options, ['signal', 'steal'], 'PowerCrossLock');
    this._assertName(name);
    if (typeof fn !== 'function') {
      throw new TypeError('PowerCrossLock: `run(name, fn)` requires a function.');
    }
    const signal = options.signal;
    if (signal !== undefined && (typeof signal !== 'object' || signal === null)) {
      throw new TypeError('PowerCrossLock: `signal` must be an AbortSignal.');
    }
    const lockOptions = {};
    if (options.signal !== undefined) {
      lockOptions.signal = options.signal;
    }
    if (options.steal !== undefined) {
      if (typeof options.steal !== 'boolean') {
        throw new TypeError('PowerCrossLock: `steal` must be a boolean.');
      }
      if (options.steal) {
        this._steals += 1;
        lockOptions.steal = true;
      }
    }

    const locks = getManager();
    if (!locks) {
      // Refusing is the only honest answer. Running `fn()` unlocked would make a
      // cross-worker mutual-exclusion primitive silently a no-op, which is the failure
      // this helper exists to prevent — and `supported` is `false`, so a caller can
      // check, but a caller who does not is exactly the one who needs it to be loud.
      throw new Error(
        'PowerCrossLock: this platform has no cross-worker lock manager ' +
          '(node:worker_threads `locks`, or `navigator.locks`). ' +
          'Check `.supported` before relying on it.'
      );
    }

    try {
      // **The callback is wrapped in an `async` arrow, and that is a leak fix, not
      // style.** Measured on Node 24.18: when the callback passed to `LockManager.request`
      // throws **synchronously**, the lock is **never released** — the promise rejects with
      // the thrown error, and every later request for that name waits forever. Isolated to
      // the exact boundary:
      //
      //   callback throws synchronously   ->  lock PERMANENTLY HELD
      //   callback rejects asynchronously  ->  lock released
      //   callback returns a value        ->  lock released
      //
      // and it is independent of arity — `request(name, fn)` and `request(name, {}, fn)`
      // leak identically. `async () => fn()` converts the throw into a rejection, which is
      // the path that does release, and a caller writing `() => { throw new Error('x') }`
      // is the most ordinary line of JavaScript there is.
      //
      // The consequence of not fixing it is the worst shape available: the caller's own
      // error surfaces correctly, so the failure looks handled, while that lock *name* is
      // wedged for the life of the process with nothing to indicate why.
      const result = await locks.request(name, lockOptions, async () => fn());
      this._acquisitions += 1;
      return result;
    } catch (err) {
      if (isAbortError(err)) this._aborted += 1;
      throw err;
    }
  }

  /**
   * Who holds `name`, and who is queued for it — **from this thread's point of view**.
   *
   * ## `query()` is per-thread, and that is not a documentation quirk
   *
   * The plan row implied this method saw cross-worker state, and **it does not.** Measured
   * on Node 24.18 with a lock held in a `Worker`: the main thread's `query()` reported
   * `held: []`, and the worker's own `query()` reported the lock. So `query()` answers
   * "what is *my* thread doing here", not "who has this lock in the process".
   *
   * That is a real limitation and it is the reason this method is documented rather than
   * promoted: it is still useful — it is the only way to see whether *you* are blocked and
   * on what name — but a caller who wants to know whether **another** worker is holding a
   * lock has to look at their own code, because the platform does not expose that. The
   * cross-worker guarantee rests on `request()` alone, which is atomic and shared.
   *
   * @param {string} [name] - One lock, or every lock when omitted.
   * @returns {Promise<{held: Array<object>, pending: Array<object>}>}
   */
  async query(name) {
    const locks = getManager();
    if (!locks) return { held: [], pending: [] };
    const result = await locks.query();
    if (name === undefined) return result;
    this._assertName(name);
    const held = [];
    for (const e of result.held) if (e.name === name) held.push(e);
    const pending = [];
    for (const e of result.pending) if (e.name === name) pending.push(e);
    return { held, pending };
  }

  /**
   * How many callers are queued for `name` right now.
   *
   * Separate from {@link query} because a queue depth is the number a caller actually
   * wants, and it is the one that says *why* a lock is slow.
   *
   * @param {string} name - Lock name.
   * @returns {Promise<number>}
   */
  async waiterCount(name) {
    this._assertName(name);
    const { pending } = await this.query(name);
    return pending.length;
  }

  /**
   * Counters, not durations.
   *
   * **There is no `waits` counter, and its absence is deliberate.** The obvious way to
   * count contention is to ask the lock manager whether the name is already held — but
   * that is an async round trip, so it cannot be atomic with the acquisition that
   * follows, and reading it costs a round trip on every `run()` purely to fill in a
   * diagnostic. An earlier draft did exactly that, called it without awaiting, and
   * therefore counted a wait on **every** call. Contention is measured from the platform
   * instead, where it is authoritative: {@link waiterCount} and {@link query}.
   *
   * @returns {PowerCrossLockStats}
   */
  stats() {
    return {
      supported: this.supported,
      acquisitions: this._acquisitions,
      steals: this._steals,
      aborted: this._aborted,
    };
  }

  /**
   * @param {any} name
   * @private
   * @returns {void}
   */
  _assertName(name) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError(
        'PowerCrossLock: a lock `name` must be a non-empty string. Every caller that must ' +
          'exclude the others has to spell the name identically, so an empty or ' +
          'non-string name cannot be a lock.'
      );
    }
  }

  /**
   * Release this instance. There is nothing to release — no timer, no listener, no queue
   * of this library's own — so this is a **state reset**, not a teardown, and the lock
   * manager's own locks are deliberately left alone: another instance may be mid-section.
   *
   * Idempotent, and safe while idle, so the instance works with `using`.
   *
   * @returns {void}
   */
  dispose() {
    this._acquisitions = 0;
    this._steals = 0;
    this._aborted = 0;
    neutralise(this, 'dispose');
  }

  /**
   * Alias for {@link dispose}, so `using lock = new PowerCrossLock()` releases it at
   * scope exit.
   *
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}

/**
 * Whether an error is the platform reporting a lock request was aborted.
 *
 * **Checked by shape rather than by `instanceof`.** `AbortError` arrives as a
 * `DOMException`, and a cross-realm `DOMException` — a worker passing one back through
 * `postMessage`, or a `node:vm` context — fails `instanceof` against this realm's
 * constructor. `name` is the only field that survives the trip, so that is what is read.
 *
 * @param {any} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return Boolean(err) && typeof err === 'object' && err.name === 'AbortError';
}
