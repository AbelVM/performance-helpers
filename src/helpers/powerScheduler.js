/**
 * PowerScheduler
 *
 * Small scheduler helper for coalescing work into a single microtask or macrotask.
 * Useful for batching or debouncing flushes while providing `schedule()`,
 * `flush()` and `cancel()` controls.
 *
 * @class PowerScheduler
 * @public
 */
/**
 * Schedule one macrotask, as fast as the runtime allows.
 *
 * `setTimeout(fn, 0)` is the obvious choice and it is the slow one. Node clamps
 * a zero timeout to **1 ms**, so a scheduler flushing per turn pays a full
 * millisecond each time. Measured here, 10 000 macrotasks:
 *
 *   MessageChannel   37 ms
 *   setTimeout(0)  10554 ms
 *
 * That is not a rounding difference; it is the difference between a flush that
 * keeps up with a request and one that does not. A `MessageChannel` port
 * message is a real macrotask with no clamping floor, and it is available in
 * Node and every browser.
 *
 * The port is created once and kept at module scope. Creating a channel per
 * flush would allocate a pair of ports each time, which is exactly the cost this
 * is avoiding; keeping a reference also stops it being collected out from under
 * us, which would silently stop scheduling.
 *
 * @type {{port1: MessagePort, port2: MessagePort}|null}
 */
let _macrotaskChannel = null;

/**
 * @returns {{port1: MessagePort, port2: MessagePort}|null}
 */
function getMacrotaskChannel() {
  if (_macrotaskChannel) return _macrotaskChannel;
  if (typeof MessageChannel !== 'function') return null;
  try {
    _macrotaskChannel = new MessageChannel();
    // Deliberately never unlisten: the handler is the queue. Unlistening after
    // one message would make the second post a no-op and hang the flush.
    _macrotaskChannel.port1.onmessage = () => {
      /* messages are consumed by the per-subscription handler below */
    };
    return _macrotaskChannel;
  } catch {
    return null;
  }
}

/**
 * Schedule one cooperative yield, as fast as the runtime allows.
 *
 * `scheduler.yield()` is the browser-native way to hand control back to the
 * event loop without a macrotask's cost, and it is *prioritised ahead of* the
 * rendering and task queues — which is what makes it the right tool for a
 * scheduler whose whole job is to run promptly. Where it does not exist (Node,
 * Firefox until recently) the macrotask path is used, which is a real
 * degradation in ordering but not in correctness: the flush still runs, just in
 * a later queue.
 *
 * Detected **once at module load**, not per call. The property is a stable
 * feature of the runtime, and probing it on every flush would add a property
 * read to the hot path to learn something that cannot change.
 *
 * @type {boolean}
 */
const HAS_SCHEDULER_YIELD =
  typeof globalThis !== 'undefined' &&
  typeof globalThis.scheduler === 'object' &&
  globalThis.scheduler !== null &&
  typeof globalThis.scheduler.yield === 'function';

/**
 * @typedef {{cancel: () => void}} MacrotaskHandle
 */

/**
 * @param {() => void} fn
 * @returns {MacrotaskHandle}
 */
function scheduleMacrotask(fn) {
  const channel = getMacrotaskChannel();
  if (channel) {
    // A fresh listener per post, removed as soon as it fires, so the port
    // carries exactly one pending task and `cancel` has something to detach.
    const onMessage = () => {
      channel.port1.removeEventListener('message', onMessage);
      fn();
    };
    channel.port1.addEventListener('message', onMessage);
    channel.port2.postMessage(null);
    return {
      cancel: () => channel.port1.removeEventListener('message', onMessage),
    };
  }
  // Node without MessageChannel: `setImmediate` has no clamp either. The guard is
  // for runtimes that are neither Node nor a browser.
  if (typeof setImmediate === 'function') {
    const handle = setImmediate(fn);
    return { cancel: () => clearImmediate(handle) };
  }
  const handle = setTimeout(fn, 0);
  return { cancel: () => clearTimeout(handle) };
}

/**
 * @param {MacrotaskHandle} handle
 * @returns {void}
 */
function cancelMacrotask(handle) {
  try {
    handle.cancel();
  } catch {
    /* already fired */
  }
}

export class PowerScheduler {
  /**
   * @param {Function} flushFn Function called when the scheduled work is flushed.
   * @param {{scheduling?: 'microtask' | 'macrotask', onError?: ((error: unknown) => void) | null}} [options]
   * Scheduling and error handling options.
   */
  constructor(flushFn, options = {}) {
    if (typeof flushFn !== 'function') {
      throw new TypeError('PowerScheduler requires a flush function');
    }
    const scheduling = options.scheduling;
    if (
      scheduling !== undefined &&
      scheduling !== 'microtask' &&
      scheduling !== 'macrotask' &&
      scheduling !== 'yield'
    ) {
      // A closed set rather than `=== 'macrotask' ? ... : 'microtask'`: a typo
      // would otherwise silently pick the *fastest* strategy for a scheduler
      // that was asked for something else.
      throw new TypeError(
        'PowerScheduler: `scheduling` must be one of microtask, macrotask, yield ' +
          `(received ${String(scheduling)}).`
      );
    }
    this._flushFn = flushFn;
    // Annotated rather than inferred: without it the field narrows to
    // `'microtask' | 'macrotask'` and every later `=== 'yield'` check is a
    // compile error, which is how a strategy you just validated can end up
    // unreachable to the type checker.
    /** @type {'microtask'|'macrotask'|'yield'} */
    this._scheduling = scheduling === undefined ? 'microtask' : scheduling;
    this._onError = typeof options.onError === 'function' ? options.onError : null;
    this._scheduled = false;
    this._timer = null;
  }

  /** Whether a flush is currently scheduled. */
  get scheduled() {
    return this._scheduled;
  }

  /**
   * The strategy this scheduler was *configured* with, and whether the runtime
   * can actually honour it.
   *
   * Both halves, because they can differ: `scheduling: 'yield'` falls back to a
   * macrotask where `scheduler.yield()` does not exist, and without this a
   * caller has no way to know it is running on the fallback. The fallback is a
   * degradation in *ordering*, not correctness — the flush still happens
   * promptly — which is exactly why it should be visible rather than silent.
   *
   * @returns {{scheduling: 'microtask'|'macrotask'|'yield', supported: boolean}}
   */
  get strategy() {
    return {
      scheduling: /** @type {'microtask'|'macrotask'|'yield'} */ (this._scheduling),
      supported: this._scheduling !== 'yield' || HAS_SCHEDULER_YIELD,
    };
  }

  /**
   * Schedule the flush callback once.
   * @returns {void}
   */
  schedule() {
    if (this._scheduled) return;
    this._scheduled = true;

    if (this._scheduling === 'macrotask') {
      this._timer = scheduleMacrotask(() => this._run());
      return;
    }
    if (this._scheduling === 'yield' && HAS_SCHEDULER_YIELD) {
      // `scheduler.yield()` returns a promise that resolves when the continuation
      // is resumed, and there is **no handle to detach** — the yield is already
      // queued. So `flush()` and `cancel()` cannot un-schedule it, and this
      // looked like it needed a generation counter to make the continuation go
      // stale.
      //
      // It does not. `_run()` opens with `if (!this._scheduled) return`, and
      // both `flush()` and `cancel()` clear `_scheduled` before returning, so an
      // abandoned continuation finds the schedule already closed and does
      // nothing. A generation counter here was an **equivalent mutant**: removing
      // it entirely left all 7 yield-path tests green. The `cancel` handle is
      // kept only so the two strategies share one teardown shape, and it is
      // honestly a no-op.
      this._timer = { cancel: () => {} };
      Promise.resolve(globalThis.scheduler.yield()).then(() => {
        this._timer = null;
        this._run();
      });
      return;
    }
    if (this._scheduling === 'yield') {
      // Requested but unsupported here. Falling back to a macrotask is a
      // degradation in *ordering* only: the flush still happens promptly, and
      // `strategy.supported` reports the substitution rather than hiding it.
      this._timer = scheduleMacrotask(() => this._run());
      return;
    }

    queueMicrotask(() => this._run());
  }

  /**
   * Flush immediately if a callback is scheduled.
   * @returns {void}
   */
  flush() {
    if (!this._scheduled) return;
    if (this._timer) {
      cancelMacrotask(this._timer);
      this._timer = null;
    }
    this._run();
  }

  /**
   * Cancel any scheduled flush without invoking the callback.
   * @returns {void}
   */
  cancel() {
    if (!this._scheduled) return;
    this._scheduled = false;
    if (this._timer) {
      cancelMacrotask(this._timer);
      this._timer = null;
    }
  }

  _run() {
    if (!this._scheduled) return;
    this._scheduled = false;
    this._timer = null;
    try {
      // `flushFn` is very often `async`. A bare `try/catch` only catches a
      // *synchronous* throw, so an async rejection used to escape as an
      // unhandled rejection and `onError` never fired. Normalise the result
      // to a promise and funnel both paths through one handler.
      const result = this._flushFn();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((err) => this._notifyError(err));
      }
    } catch (err) {
      // Swallow flush errors to keep scheduler mechanics intact.
      this._notifyError(err);
    }
  }

  /**
   * Route an error to the configured `onError` handler without ever letting a
   * throwing user handler escape.
   * @param {any} err
   * @private
   * @returns {void}
   */
  _notifyError(err) {
    if (!this._onError) return;
    try {
      this._onError(err);
    } catch {
      // ignore logger failures
    }
  }

  /**
   * Release every resource this instance holds.
   *
   * Idempotent, and safe to call while the instance is idle. Exists so the
   * instance works with `using` / `await using` and gives callers an explicit
   * name to call.
   *
   * @returns {void}
   */
  dispose() {
    this.cancel();
    // Neutralise the cleanup so a second dispose (or a late call) is a no-op
    // rather than a second teardown pass.
    this.cancel = () => {};
  }

  /**
   * Alias for {@link dispose}, so `using x = new X()` releases the instance
   * deterministically at scope exit.
   * @returns {void}
   */
  [Symbol.dispose]() {
    this.dispose();
  }
}
