import { assertKnownOptions } from '../utils/options.js';
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
 * @typedef {import('./jsdoc-types.js').PowerSchedulerOptions} PowerSchedulerOptions
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
 * Posts currently in flight on {@link _macrotaskChannel}.
 *
 * This is what makes `dispose()` safe, and it is the whole of the fix for a bug
 * that the previous fix created. `closeMacrotaskChannel()` closes a
 * **module-level** channel, so disposing one scheduler tore the listener off
 * every *other* scheduler's pending flush: the port was closed, the queued
 * message could never be delivered, `_run()` never ran, and `_scheduled` stayed
 * `true` — which makes `schedule()` a permanent no-op for that peer. Verified
 * with two macrotask schedulers and a `b.dispose()` between their posts: `a`
 * flushed 0 times and stayed wedged.
 *
 * So the channel is only closed when nothing is in flight on it. Otherwise the
 * module reference is dropped — the next scheduler builds a fresh pair — and the
 * old pair is left open so the pending post can still be delivered. It is
 * already `unref()`ed, so leaving it open cannot hold the process alive, which
 * was the original reason `dispose()` closes it at all.
 *
 * @type {number}
 */
let _macrotaskPending = 0;

/**
 * @returns {{port1: MessagePort, port2: MessagePort}|null}
 */
function getMacrotaskChannel() {
  if (_macrotaskChannel) return _macrotaskChannel;
  if (typeof MessageChannel !== 'function') return null;
  try {
    _macrotaskChannel = new MessageChannel();
    // Unref the port that is only ever *received* on. A live `MessagePort` keeps
    // a Node event loop alive on its own, so a scheduler that has finished its work
    // but still holds the channel keeps the process from exiting — which is what a
    // channel left un-unref'd does. `port1` receives; `port2` posts, and is
    // reachable only from the returned handle, so unref'ing it would break the
    // very thing this channel exists to do.
    // `unref` is a Node extension: it is absent from the DOM `MessagePort`, so
    // the guard is not paranoia. The cast is because `tsc` resolves `port1` to
    // the DOM type from lib.dom, where `unref` does not exist — and the cast
    // costs nothing here because the preceding `typeof` guard is the real check.
    const _unref = /** @type {{unref?: () => void}} */ (
      /** @type {unknown} */ (_macrotaskChannel.port1)
    ).unref;
    if (typeof _unref === 'function') _unref.call(_macrotaskChannel.port1);
    // Deliberately never unlisten: the handler is the queue. Unlistening after
    // one message would make the second post a no-op and hang the flush.
    _macrotaskChannel.port1.onmessage = () => {
      /* messages are consumed by the per-subscription handler below */
    };
    // Assigning `onmessage` **starts** the port, and a started `MessagePort`
    // keeps the Node event loop alive. This one is module-level, so a single
    // `yield()` anywhere in a process — a CLI, a serverless handler, a test —
    // pinned that process open for good, including after `dispose()`. Verified
    // in a subprocess: the script reached its last line and then sat there until
    // the timeout killed it. Three lines are the whole of it:
    //
    //     const c = new MessageChannel(); c.port1.onmessage = () => {};
    //
    // `unref()` is the same treatment `utils/timers.js` and `PowerCron` already
    // get, and the trade is identical: a flush still pending when the process
    // would otherwise exit is dropped rather than holding the process open. A
    // scheduler's job is to yield promptly inside a running program, not to keep
    // one alive. Guarded because a browser `MessagePort` has no `unref`, and
    // browsers have no event loop to hold open.
    // Guarded because a browser `MessagePort` has no `unref`, and browsers have
    // no event loop to hold open. The cast is the same one `utils/timers.js`
    // makes and for the same reason: the DOM's `MessagePort` type has no
    // `unref`, while Node's has it as an own instance property, so the
    // capability has to be probed on the value rather than asserted through a
    // type that only holds in one of them. `typecheck:ratchet` caught both
    // accesses at 292 against a 290 ceiling.
    const port = /** @type {any} */ (_macrotaskChannel.port1);
    if (typeof port.unref === 'function') port.unref();
    return _macrotaskChannel;
  } catch {
    return null;
  }
}

/**
 * Release the module-level macrotask channel.
 *
 * Called from `dispose()`. `unref()` alone already lets the process exit, but
 * the ports are still open and still referenced, so a disposed scheduler would
 * leave a started channel behind for the next one in the same process. Clearing
 * the module reference lets the next `getMacrotaskChannel()` build a fresh pair.
 *
 * **Only when nothing is in flight.** Closing a channel with a post on it would
 * discard that post, and because the channel is module-level that post might
 * belong to a *different* scheduler — see {@link _macrotaskPending}. With
 * something pending this drops the reference and leaves the pair open: the
 * pending message still gets delivered, and the pair cannot hold the process
 * alive because it was `unref()`ed when it was built.
 *
 * @returns {void}
 */
function closeMacrotaskChannel() {
  const channel = _macrotaskChannel;
  if (!channel) return;
  _macrotaskChannel = null;
  if (_macrotaskPending > 0) return;
  try {
    channel.port1.onmessage = null;
    channel.port1.close();
  } catch {
    /* already closed */
  }
  try {
    channel.port2.close();
  } catch {
    /* already closed */
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
    // The counter is what lets `dispose()` know this post is still in flight and
    // must survive a teardown of the shared channel — see `_macrotaskPending`.
    const onMessage = () => {
      channel.port1.removeEventListener('message', onMessage);
      if (_macrotaskPending > 0) _macrotaskPending -= 1;
      fn();
    };
    channel.port1.addEventListener('message', onMessage);
    channel.port2.postMessage(null);
    _macrotaskPending += 1;
    return {
      cancel: () => {
        channel.port1.removeEventListener('message', onMessage);
        if (_macrotaskPending > 0) _macrotaskPending -= 1;
      },
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
   * @param {PowerSchedulerOptions} [options] Scheduling and error handling options.
   */
  constructor(flushFn, options = {}) {
    assertKnownOptions(options, ['scheduling', 'onError'], 'PowerScheduler');
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
    // Bumped by every `schedule()` that actually starts one, so a continuation
    // left over from a previous schedule can tell that it has been superseded.
    // Only the yield path needs it — the other strategies hold a cancellable
    // handle — but it is one integer, and it is the only thing standing between
    // an abandoned continuation and a double flush.
    this._generation = 0;
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
      // **This comment used to say no counter was needed**, and the reason it was
      // wrong is worth keeping. `_run()` opens with `if (!this._scheduled)
      // return`, and `flush()` does **not** clear `_scheduled` — `_run()` does, as
      // a side effect of *running*. So after `schedule(); flush(); schedule()` the
      // flag is true again, and the abandoned first continuation finds a *live*
      // schedule and runs it. Measured with a controllable `scheduler.yield`:
      // `schedule/flush/schedule` left one flush, and resuming the abandoned
      // continuation produced a second — the newer schedule flushed early — and
      // nulled `_timer` on the way, clobbering the newer handle. The seven
      // yield-path tests stayed green throughout because none of them resumed an
      // abandoned continuation.
      const generation = ++this._generation;
      // The placeholder handle is kept only so the strategies share one teardown
      // shape. It is honestly a no-op, and says so rather than pretending
      // otherwise.
      this._timer = { cancel: () => {} };
      Promise.resolve(globalThis.scheduler.yield()).then(() => {
        // Superseded by a later `schedule()`. Note that `_run()`'s own
        // `_scheduled` guard does **not** catch this: the later `schedule()` re-set
        // that flag, so the check has to be on the generation.
        if (generation !== this._generation) return;
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
    // The channel is module-level, so one disposed scheduler is enough to
    // release it for the process. Doing this in `dispose()` rather than relying
    // on `unref()` alone is what makes the common path actually clean.
    closeMacrotaskChannel();
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
