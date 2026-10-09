// WorkerAgnostic.js
// Abstraction for environment-agnostic worker (Node worker_threads, Web Worker)
//
// `WorkerAgnostic` provides a single, transparent API for spawning and
// communicating with a worker regardless of whether the runtime is Node.js
// (`worker_threads`) or a browser / worker context (Web Worker). It normalizes:
//
//   - worker creation from a function factory, a constructor, or a path/URL
//     string, picking the correct native Worker for the current environment;
//   - the event model (Node's EventEmitter `on`/`off` vs the Web
//     `addEventListener`/`removeEventListener`) behind one unified API;
//   - `postMessage(message, transfer)` transfer-list handling;
//   - `terminate()` (always resolves to a Promise).
//
// PowerPool (and any other consumer) can therefore treat workers identically
// across runtimes without environment-specific branching.

/**
 * @typedef {import('./jsdoc-types.js').WorkerLike} WorkerLike
 * @typedef {import('./jsdoc-types.js').WorkerAgnosticOptions} WorkerAgnosticOptions
 */

// Lazily obtain a CommonJS `require` WITHOUT a *static* `import 'module'`
// (which browser bundlers such as Vite/webpack/esbuild cannot resolve). In
// CJS-transpiled contexts (vitest) a global `require` exists and is used
// directly. In pure ESM Node we synthesize one via `createRequire`, loaded
// through an opaque dynamic import cached at module scope. The browser never
// executes this because `detectEnv()` never returns 'node' there, so the Node
// builtin is never requested and bundlers never see it.
/** @type {NodeRequire|null} */
/**
 * A CommonJS-style `require`, synthesised in pure-ESM Node.
 *
 * @typedef {function(string): *} NodeRequire
 */

/**
 * @type {NodeRequire|null} The dynamic-imported `node:module` require, or null
 *   until that resolves. Declared because the initialiser is `null` and the only
 *   assignment happens inside a promise chain, so neither position can infer it.
 */
let _nodeRequire = null;
/** @type {Promise<NodeRequire>|null} */
let _nodeRequirePromise = null;

function _loadNodeRequire() {
  if (_nodeRequire) return _nodeRequire;
  if (typeof require !== 'undefined') {
    _nodeRequire = require;
    return _nodeRequire;
  }
  if (!_nodeRequirePromise) {
    // Opaque dynamic import so bundlers do not try to resolve the Node
    // builtin at build time. Only ever runs in a Node environment.
    _nodeRequirePromise = new Function('return import("node:module")')().then(
      (/** @type {any} */ m) => {
        let base;
        try {
          // Dynamic access so bundlers (CJS/UMD) don't statically parse
          // `import.meta` and emit EMPTY_IMPORT_META warnings. In pure ESM Node
          // this yields the module URL; in CJS/UMD `import.meta` is replaced with
          // `{}` and we fall back to the current working directory.
          base = new Function('return import.meta?.url')() || process.cwd() + '/';
        } catch (e) {
          base = process.cwd() + '/';
        }
        _nodeRequire = m.createRequire(base);
        return _nodeRequire;
      }
    );
  }
  return _nodeRequirePromise;
}

/**
 * Preload Node's `worker_threads` `require` for pure-ESM Node environments.
 *
 * Call this once (and `await` it) before constructing a *string-source* worker
 * in pure ESM Node, or simply set `globalThis.Worker`. It is NOT needed in
 * CJS-transpiled contexts (vitest), when passing a factory function, or when
 * `globalThis.Worker` is already present. Browser builds never need it.
 *
 * @returns {Promise<void>}
 */
export function preloadNode() {
  return Promise.resolve(_loadNodeRequire()).then(() => undefined);
}

/**
 * Resolve the Node `worker_threads` `Worker` constructor for the current
 * context. Throws a clear, actionable error in pure ESM Node when the
 * synchronous `require` is not yet available (call `preloadNode()` first).
 * @private
 */
function getNodeWorkerCtor() {
  const req = _nodeRequire || (typeof require !== 'undefined' ? require : null);
  if (req) return req('worker_threads').Worker;
  throw new Error(
    'WorkerAgnostic: Node worker_threads is not available synchronously in pure ESM. ' +
      'Call `await preloadNode()` (imported from `performance-helpers` or ' +
      '`performance-helpers/WorkerAgnostic`) once before constructing a string-source ' +
      'worker, or set globalThis.Worker. A factory function does not need this preload.'
  );
}

function detectEnv() {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') return 'browser';
  if (
    typeof self !== 'undefined' &&
    typeof (/** @type {any} */ (self).importScripts) === 'function'
  )
    return 'webworker';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

// Normalized event types supported across environments.
const SUPPORTED_EVENTS = ['message', 'error', 'messageerror'];

/**
 * The constructor options minus this class's own `onError`.
 *
 * @param {Object} options
 * @returns {Object} A shallow copy without `onError`.
 * @private
 */
function stripOnError(options) {
  // Spelled as a `delete` on a copy rather than a rest-destructure, because the
  // omitted binding would itself trip `no-unused-vars` — and an eslint-disable for a
  // two-line helper is a worse trade than copying an object that is already copied
  // on the path that uses it.
  const rest = { ...options };
  delete rest.onError;
  return rest;
}

/**
 * Resolve and create the underlying native worker for the given source.
 *
 * @param {Function|string} workerSource - Worker constructor, factory function,
 *   or path/URL string.
 * @param {Object<string, *>} options - Options forwarded to the native Worker
 *   constructor. Typed as an open bag because that is what it is: the keys are
 *   Node's `WorkerOptions` on one side and the browser's on the other, and
 *   `shared` is this library's own addition on top of both.
 * @param {string} env - Resolved environment from `detectEnv()`.
 * @returns {import('./jsdoc-types.js').WorkerLike} The underlying worker-like object.
 * @private
 */
function resolveWorker(workerSource, options, env) {
  // F1b: the SharedWorker path, taken before anything else so the `shared` flag
  // is honoured regardless of what else the environment offers. A browser has
  // both `Worker` and `SharedWorker` globals, so without this the string source
  // would take the plain-Worker branch below and the flag would be silently
  // ignored — the misspelled-option failure this library refuses to have.
  //
  // `shared` is stripped before the bag reaches any native constructor: it is
  // this library's option, not the platform's, and forwarding it would be the
  // same hygiene problem `onError` already is.
  if (options && options.shared === true) {
    // Copied and deleted rather than rest-destructured, for the same reason
    // `stripOnError` is: the omitted binding would itself trip `no-unused-vars`,
    // and an eslint-disable for a one-line drop is a worse trade than copying an
    // object that is already copied on this path.
    const rest = { ...options };
    delete rest.shared;
    return resolveSharedWorker(workerSource, rest);
  }
  // A globally-available Worker constructor (a browser, a Web Worker polyfill,
  // a runtime that aliases Node's worker_threads to `Worker` as the bench
  // harness does, or a sandboxed/bundled context) can be used directly for
  // string sources. We accept both `globalThis.Worker` and a bare `Worker`
  // global so environments that expose the constructor without attaching it to
  // `globalThis` still work transparently.
  const GlobalWorker =
    (typeof globalThis !== 'undefined' && globalThis.Worker) ||
    (typeof Worker !== 'undefined' ? Worker : undefined);
  if (
    typeof GlobalWorker === 'function' &&
    typeof workerSource === 'string' &&
    (env === 'node' || env === 'unknown')
  ) {
    // The fast path, and it is only correct outside a browser.
    //
    // **This used to be reached in a browser too, which made
    // `createWebWorkerFromString` unreachable there.** A browser always has a
    // global `Worker`, so every string source took this branch and reached
    // `new Worker(str)` — which the browser resolves against the *document*
    // base URL, not the bundle that named it. `createWebWorkerFromString` has
    // existed to resolve against `document.currentScript.src` first and
    // `location.href` second, and in a real browser it was dead code: correct,
    // tested-by-inspection, and never executed. A worker built from a path
    // relative to the bundle 404s once the app is served from a subpath, and a
    // 404 from a worker constructor is indistinguishable from a typo.
    //
    // `node` and `unknown` keep the fast path because that is what it is for —
    // a runtime that aliases `worker_threads` to `Worker` (the bench harness
    // does) has no browser base URL to resolve against, and routing it through
    // the browser helper would look for a `document` that is not there.
    return new GlobalWorker(workerSource, options);
  }

  if (env === 'node' || env === 'browser' || env === 'webworker') {
    if (typeof workerSource === 'function') {
      // Resolve the Node.js `Worker` constructor *lazily*: the factory path
      // below only needs it if the factory returns a string, so calling
      // `getNodeWorkerCtor()` up front made `new PowerPool(() => new MyWorker())`
      // throw in pure-ESM Node even though no `Worker` was ever required.
      // This matches the documented contract that `preloadNode()` is *not*
      // needed when passing a factory function.
      return createFromFunction(workerSource, () => getNodeWorkerCtor(), options, env);
    }
    if (typeof workerSource === 'string') {
      return env === 'node'
        ? new (getNodeWorkerCtor())(workerSource, options)
        : createWebWorkerFromString(workerSource, options);
    }
    throw new Error('Invalid workerSource: expected Worker factory or path string');
  }

  // Unknown environment: a caller-provided function workerSource is
  // environment-agnostic (the caller supplies the worker implementation), so we
  // can still construct it directly. String sources require a native Worker and
  // cannot be resolved without knowing the runtime.
  if (typeof workerSource === 'function') {
    return createFromFunction(workerSource, undefined, options, 'unknown');
  }
  throw new Error(
    'Unsupported environment for WorkerAgnostic: cannot resolve a string workerSource without a global Worker or a known runtime'
  );
}

/**
 * Adapt a `SharedWorker`'s port to the {@link WorkerLike} surface.
 *
 * A `SharedWorker` is not a `Worker`. It has no `postMessage` of its own and no
 * `terminate()`: the caller gets a `MessagePort` off `.port` and every message
 * goes through that. So the two things this adapter exists to do are **route
 * `postMessage` to the port** and **give `terminate()` a meaning**.
 *
 * `terminate()` closes the port. That is deliberately *not* the same as
 * terminating a `Worker`: a `SharedWorker` is shared by every client that
 * connected to the same URL, and closing one client's port must not kill the
 * script the others are still using. The port close detaches this client and
 * leaves the shared worker running, which is the whole point of the primitive.
 * A caller who wants the shared worker gone has to close every port, and that
 * is a decision above this class.
 *
 * `error` is forwarded from **both** the `SharedWorker` and its port, because
 * the two fire it for different reasons: the `SharedWorker` fires it when the
 * script fails to load or throws during evaluation, and the port fires it for
 * deserialization failures on an inbound message. Forwarding only one would
 * silently drop the other, and a dropped script-load error reads as a worker
 * that never starts.
 *
 * @param {SharedWorker} sharedWorker - A constructed `SharedWorker`.
 * @returns {import('./jsdoc-types.js').WorkerLike} A worker-like object.
 * @private
 */
function createSharedWorkerAdapter(sharedWorker) {
  const port = sharedWorker.port;
  if (!port) {
    throw new TypeError(
      'WorkerAgnostic: the SharedWorker has no `port`. A SharedWorker exposes its ' +
        'messages through `worker.port`, and an object without one is not a SharedWorker.'
    );
  }
  // Started here rather than left to the caller. A `MessagePort` does not
  // deliver messages until `start()` is called, and the browser calls it
  // implicitly only when `onmessage` is assigned — which this adapter never
  // does, because it registers through `addEventListener`. Without the explicit
  // `start()` the port would silently receive nothing.
  if (typeof port.start === 'function') port.start();

  /**
   * The targets an event type must be registered on.
   *
   * `error` goes to **both**, because the two fire it for different reasons: the
   * `SharedWorker` fires it when the script fails to load or throws during
   * evaluation, and the port fires it for a deserialization failure on an
   * inbound message. Forwarding only one silently drops the other, and a
   * dropped script-load error reads as a worker that never starts.
   * @param {string} type
   * @returns {any[]}
   */
  const targetsFor = (type) => (type === 'error' ? [port, sharedWorker] : [port]);

  return {
    /**
     * @param {string} type
     * @param {...*} handler
     * @returns {void}
     */
    addEventListener(type, ...handler) {
      for (const target of targetsFor(type)) target.addEventListener(type, ...handler);
    },
    /**
     * @param {string} type
     * @param {...*} handler
     * @returns {void}
     */
    removeEventListener(type, ...handler) {
      for (const target of targetsFor(type)) target.removeEventListener(type, ...handler);
    },
    /**
     * @param {*} data
     * @param {*} [transfer]
     * @returns {void}
     */
    postMessage(data, transfer) {
      port.postMessage(data, transfer);
    },
    /**
     * Detach this client. Closes the port and leaves the shared worker running
     * for its other clients — see the note above.
     * @returns {void}
     */
    terminate() {
      try {
        port.close();
      } catch {
        // Already closed. `MessagePort.close()` throws if the port is detached
        // or its owner is gone, and a second `terminate()` reaching that is
        // normal on a teardown path.
      }
    },
  };
}

/**
 * Resolve a `SharedWorker` for the given source and adapt its port.
 *
 * @param {Function|string} workerSource - The worker script URL. A non-string is
 *   rejected inside, because a `SharedWorker` is constructed from a URL.
 * @param {Object<string, *>} options - Options forwarded to the `SharedWorker`
 *   constructor.
 * @returns {import('./jsdoc-types.js').WorkerLike} The adapted port.
 * @private
 */
function resolveSharedWorker(workerSource, options) {
  const GlobalSharedWorker =
    (typeof globalThis !== 'undefined' && globalThis.SharedWorker) ||
    (typeof SharedWorker !== 'undefined' ? SharedWorker : undefined);
  if (typeof GlobalSharedWorker !== 'function') {
    throw new TypeError(
      'WorkerAgnostic: `shared: true` requires a global `SharedWorker`, which this ' +
        'runtime does not provide. SharedWorker is a browser API; in Node use a ' +
        'regular worker source.'
    );
  }
  if (typeof workerSource !== 'string') {
    throw new TypeError(
      'WorkerAgnostic: `shared: true` requires a string worker source (a URL). A ' +
        'SharedWorker is constructed from a script URL, so a factory function has ' +
        'nothing to be shared between.'
    );
  }
  return createSharedWorkerAdapter(new GlobalSharedWorker(workerSource, options));
}

/**
 * Create a worker from a function source. The function may be a constructable
 * class (invoked with `new`) or an arrow/bound factory (invoked directly).
 * If the factory returns a worker-like object it is used as-is; if it returns
 * a string it is treated as a module specifier and a native Worker is built
 * from it.
 * @param {Function} workerSource
 * @param {Function|undefined} WorkerCtor
 * @param {Object} options
 * @param {string} env
 * @returns {import('./jsdoc-types.js').WorkerLike} A worker-like object.
 * @private
 */
function createFromFunction(workerSource, WorkerCtor, options, env) {
  if (typeof workerSource.prototype === 'undefined') {
    return coerceFactoryResult(workerSource(), WorkerCtor, options, env);
  }
  try {
    return new workerSource();
  } catch (err) {
    if (
      err instanceof TypeError &&
      /not a constructor|cannot be invoked without\s*'new'|Class constructor|not constructable/i.test(
        String(err?.message)
      )
    ) {
      return coerceFactoryResult(workerSource(), WorkerCtor, options, env);
    }
    throw err;
  }
}

/**
 * Normalize a factory result into a worker-like object.
 * @param {*} result
 * @param {Function|undefined} WorkerCtor
 * @param {Object} options
 * @param {string} env
 * @returns {import('./jsdoc-types.js').WorkerLike} A worker-like object.
 * @private
 */
function coerceFactoryResult(result, WorkerCtor, options, env) {
  // An `async` factory resolves to a Promise, and `typeof` reports a Promise as
  // 'object' — so it has to be rejected as a *thenable* test, and it cannot
  // live inside a `typeof result === 'string'` branch where it could never be
  // reached. It was there, which meant the guard never fired: an async factory
  // produced a Promise as its "worker", and every later `postMessage` then
  // failed against an object with no such method, several frames from the
  // mistake.
  if (result && typeof result.then === 'function') {
    throw new TypeError(
      'WorkerAgnostic: an async worker factory was passed. Construct the worker synchronously, or await the factory yourself and pass the instance.'
    );
  }
  if (result && typeof result === 'object' && typeof result.postMessage === 'function') {
    return result;
  }
  if (typeof result === 'string') {
    return env === 'node'
      ? new (typeof WorkerCtor === 'function' ? WorkerCtor() : WorkerCtor)(result, options)
      : createWebWorkerFromString(result, options);
  }
  return result && typeof result === 'object'
    ? /** @type {import('./jsdoc-types.js').WorkerLike} */ (result)
    : // Nothing usable came back. Deliberately an empty object rather than a
      // throw, because the caller only reaches this when the environment could
      // not resolve a worker, and an opaque failure is what it is guarding
      // against - but it is not a WorkerLike, so it is cast explicitly.
      /** @type {*} */ ({});
}

/**
 * Create a Web Worker from a (possibly relative) path string, resolving it
 * against `options.baseUrl`, then `document.currentScript.src`, then
 * `location.href` — see the note in the body for why the module's own URL is
 * not among them and cannot be.
 *
 * @param {string} workerSource
 * @param {import('./jsdoc-types.js').WorkerAgnosticOptions} [options]
 * @returns {import('./jsdoc-types.js').WorkerLike} A worker-like object.
 * @private
 */
function createWebWorkerFromString(workerSource, options) {
  // **The base URL cannot be discovered here, and the reason is worth recording
  // because the old code looked like it was discovering it.**
  //
  // `new Function(...)` evaluates in *global* scope, so `import.meta` is not in
  // scope inside it: the generated function fails to parse, the inner `catch`
  // swallows it, and the branch returns `undefined`. Verified:
  // `new Function('try { return import.meta?.url } catch (e) { return undefined }')()`
  // yields `undefined` and throws `Cannot use 'import.meta' outside a module`. So
  // the module URL is not merely awkward to reach from here, it is **unreachable**,
  // and no rewrite of that expression can recover it. Writing a bare
  // `import.meta.url` would fix the browser case and break the CJS and UMD
  // builds, which the same file has to support.
  //
  // What is left is the two bases that *are* reachable, and both are the wrong
  // one in a `<script type="module">`:
  //
  // - `document.currentScript` is `null` there, per the HTML spec, so a module
  //   script falls through;
  // - `location.href` is the **page**, not the module — so a worker path written
  //   relative to the module resolves against the page and 404s, and the error is
  //   reported asynchronously on the worker, where it reads as a typo rather than
  //   as a resolution failure.
  //
  // Hence `options.baseUrl`: the caller knows where its module is, and the only
  // honest resolution is to let it say so. For a classic script, or a
  // fully-absolute worker source, the automatic fallbacks below are correct and
  // this option is unnecessary.
  const explicitBase = options && typeof options === 'object' ? options.baseUrl : undefined;

  let baseUrl = typeof explicitBase === 'string' ? explicitBase : undefined;

  if (!baseUrl && typeof document !== 'undefined') {
    // `currentScript` is typed `HTMLOrSVGScriptElement | null` and `src` exists
    // only on the HTML side of that union, so reading it is an error even though a
    // `document` is the one place this can be a script at all.
    const cs = /** @type {HTMLScriptElement|null} */ (document.currentScript);
    if (cs?.src) baseUrl = cs.src;
  }
  if (!baseUrl && typeof location !== 'undefined' && location.href) {
    // The **page** URL, which is the right base for a classic script and the
    // wrong one for a module script. Documented rather than fixed, because the
    // module URL is not reachable from here.
    baseUrl = location.href;
  }
  try {
    if (baseUrl) return new Worker(new URL(workerSource, baseUrl), options);
  } catch (e) {
    // fallthrough to plain string
  }
  return new Worker(workerSource, options);
}

/**
 * Normalize a transfer argument (array or `{ transfer }` options object) into
 * an array of Transferables (or undefined).
 * @private
 */
/**
 * @param {(ArrayBuffer[]|ArrayBufferView[]|Object)|undefined} transfer Either the
 *   list itself or a `postMessage`-style bag carrying one, which is the same
 *   union `WorkerLike.postMessage` accepts. `Transferable` was too narrow: the
 *   DOM's own definition does not admit a bare `Object`, and callers pass one.
 * @returns {Array<Transferable>|undefined}
 */
function normalizeTransfer(transfer) {
  if (Array.isArray(transfer)) return transfer;
  if (transfer && typeof transfer === 'object' && Array.isArray(transfer.transfer)) {
    return transfer.transfer;
  }
  return undefined;
}

class WorkerAgnostic {
  /**
   * Create a `WorkerAgnostic` wrapping the underlying native worker for the
   * given source.
   *
   * @param {Function|string} workerSource - A Worker constructor, a worker
   *   factory function, or a path/URL string. When a function is provided it is
   *   invoked (or constructed with `new`) to obtain the underlying worker-like
   *   object. When a string is provided it is used to construct the appropriate
   *   native Worker for the current environment.
   * @param {WorkerAgnosticOptions} [options] - Options forwarded to the native
   *   Worker constructor (e.g. `{ type: 'module' }` for Node, or worker options
   *   for the browser).
   */
  constructor(workerSource, options = {}) {
    this.env = detectEnv();
    this.options = options && typeof options === 'object' ? options : {};
    /**
     * WRK-003. Where a listener throw goes.
     *
     * Read before `_wireEvents`, because a listener that throws during the initial
     * capability announcement must already have somewhere to report to.
     */
    this._onError = typeof this.options.onError === 'function' ? this.options.onError : null;
    // unified listener registry: event name -> Set<handler>
    /** @type {Array<[string, (...args: any[]) => void]>} Native listeners this instance attached,
     * as `[type, handler]`, so `dispose()` can detach exactly what it wired. */
    this._wired = [];
    /** @type {Array<[string, any]>} For the property native model, the
     * `[propertyName, previousValue]` pairs to restore on disposal. */
    this._wiredProperties = [];
    /** @type {boolean} */
    this._disposed = false;
    this._listeners = new Map();
    /** @type {import('./jsdoc-types.js').WorkerLike} */
    // `onError` is this class's own option, not the platform's, so it is stripped
    // before the bag reaches `new Worker(...)`. Node's `Worker` and the DOM's
    // `WorkerOptions` both ignore unknown members, so this is hygiene rather than a
    // fix — but a library option forwarded into a platform constructor is the kind
    // of thing that becomes a bug the day some implementation validates its bag.
    this.worker = resolveWorker(
      workerSource,
      this._onError ? stripOnError(this.options) : this.options,
      this.env
    );
    this._wireEvents();
  }

  /**
   * Transparently create the underlying native worker without wrapping it in a
   * `WorkerAgnostic` instance. Useful for callers (such as PowerPool) that wrap
   * the raw worker themselves but still want environment-agnostic creation.
   *
   * @param {Function|string} workerSource
   * @param {Object} [options]
   * @returns {object} The underlying worker-like object.
   */
  static create(workerSource, options) {
    return resolveWorker(workerSource, options || {}, detectEnv());
  }

  /**
   * Attach the underlying worker's native events to our unified dispatcher.
   * @private
   */
  _wireEvents() {
    const w = this.worker;
    if (!w) return;
    // **The handlers are stored, not thrown away.** They used to be anonymous
    // arrow functions passed straight to `addEventListener`, which wires them
    // permanently: nothing held a reference, so nothing could remove them. That is
    // what made this class the one resource-owning helper in the library with no
    // release path — `dispose()` could not have been written against it, because
    // there was no handle to remove. Recorded per type so `dispose()` can detach
    // exactly what it attached, on all three native models.
    /** @type {Array<[string, (...args: any[]) => void]>} */
    const wired = [];
    if (typeof w.addEventListener === 'function') {
      this._nativeModel = 'listener';
      for (const type of SUPPORTED_EVENTS) {
        /** @type {(...args: any[]) => void} */
        const handler = (...args) => this._dispatch(type, ...args);
        w.addEventListener(type, handler);
        wired.push([type, handler]);
      }
    } else if (typeof w.on === 'function') {
      this._nativeModel = 'emitter';
      for (const type of SUPPORTED_EVENTS) {
        /** @type {(...args: any[]) => void} */
        const handler = (...args) => this._dispatch(type, ...args);
        w.on(type, handler);
        wired.push([type, handler]);
      }
    } else {
      this._nativeModel = 'property';
      // The property model assigns rather than registers, so detaching means
      // putting the properties back the way they were found.
      /** @type {Array<[string, any]>} */
      const saved = [];
      for (const type of SUPPORTED_EVENTS) {
        const prop =
          type === 'message' ? 'onmessage' : type === 'error' ? 'onerror' : 'onmessageerror';
        /** @type {(...args: any[]) => void} */
        const handler = (...args) => this._dispatch(type, ...args);
        saved.push([prop, w[prop]]);
        w[prop] = handler;
        wired.push([type, handler]);
      }
      this._wiredProperties = saved;
    }
    this._wired = wired;
  }

  /**
   * Release every resource this instance holds.
   *
   * This wrapper owns the underlying worker and the native listeners it attached
   * to it, and both were previously unreleasable: the listeners were anonymous
   * arrow functions passed straight to `addEventListener`, so no handle existed to
   * remove them.
   *
   * **It does not terminate the worker.** `WorkerAgnostic` wraps a worker handed
   * to it by a caller, and terminating it would be a decision this class has no
   * mandate to make — `PowerPool` owns the lifecycle of its workers and drives
   * termination itself. So this detaches everything it attached and drops its own
   * listener registry; it leaves the worker alone. A caller that does own the
   * worker should terminate it, which is what the owning helper is for.
   *
   * Idempotent, and safe on an instance whose `_wireEvents` bailed early.
   *
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const w = this.worker;
    if (w) {
      for (const [type, handler] of this._wired ?? []) {
        try {
          if (this._nativeModel === 'listener' && typeof w.removeEventListener === 'function') {
            w.removeEventListener(type, handler);
          } else if (this._nativeModel === 'emitter' && typeof w.off === 'function') {
            w.off(type, handler);
          }
        } catch (e) {
          // Detaching must not throw: `dispose()` runs inside `using` teardown and
          // inside `finally`, where an exception replaces the outcome the caller
          // actually cares about with a message about a listener.
        }
      }
      if (this._nativeModel === 'property') {
        // The property native model is *defined* by these three names existing, so
        // the cast is a statement about the branch rather than an escape hatch.
        const target = /** @type {Record<string, any>} */ (/** @type {any} */ (w));
        for (const [prop, previous] of this._wiredProperties ?? []) {
          if (target[prop] !== undefined || previous !== undefined) target[prop] = previous;
        }
      }
    }
    // Drop our own registry too, so the wrappers become collectable rather than
    // keeping their closures alive from the Map.
    this._listeners.clear();
    this._wired = [];
    this._wiredProperties = [];
  }

  /** @returns {void} */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * Dispatch a native event to all registered unified listeners, normalizing
   * the payload shape so consumers see a consistent `{ data }` for `message`
   * regardless of whether the runtime is Node (value delivered directly) or a
   * Web Worker (value delivered via `event.data`).
   * @private
   */
  /**
   * Fan one native worker event out to the registered listeners.
   * @param {string} type
   * @param {...*} args
   * @private
   */
  _dispatch(type, ...args) {
    const set = this._listeners.get(type);
    if (!set || !set.size) return;
    let payload;
    if (type === 'message') {
      const raw = args[0];
      // Node worker_threads delivers the value directly; Web Workers deliver a
      // MessageEvent whose payload lives on `.data`.
      const data =
        this._nativeModel === 'emitter'
          ? raw
          : raw && typeof raw === 'object' && 'data' in raw
            ? raw.data
            : raw;
      payload = [{ data, originalEvent: raw }];
    } else {
      payload = args;
    }
    for (const handler of set) {
      try {
        handler(...payload);
      } catch (e) {
        // Never let a listener error break the worker event loop — that part is not
        // in question and must not change.
        //
        // **Swallowing silently is the defect (WRK-003).** This catch had no body but
        // a comment, so a listener that throws on every message produced a class
        // that appeared healthy: the events stopped arriving at that handler, nothing
        // was logged, nothing was counted, and the only symptom was that a feature
        // quietly stopped working. Four sibling helpers had already grown an
        // `onError` route for exactly this, and this one was missed because it looked
        // the same as a dozen deliberate `catch {}` blocks elsewhere in the tree.
        this._notifyError(e, { type, listener: handler });
      }
    }
  }

  /**
   * Route a listener error to the configured `onError` handler.
   *
   * Mirrors `PowerScheduler._notifyError` deliberately rather than inventing a
   * second shape: same signature, same guard, and the same refusal to let a throwing
   * user handler escape. An error handler that throws would turn a swallowed
   * listener error into an uncaught one, which is the failure this whole mechanism
   * exists to prevent — so the guard is the point, not a detail.
   *
   * @param {any} err
   * @param {{type: string, listener: Function}} [context] - Which event and which
   *   handler threw. Included because "a listener threw" is not actionable on its
   *   own when a caller has registered several.
   * @private
   * @returns {void}
   */
  _notifyError(err, context) {
    if (!this._onError) return;
    try {
      this._onError(err, context);
    } catch {
      // A throwing `onError` must not become an uncaught error.
      //
      // WRK-003 added this site, and GATE-001 caught the first version of it as a
      // bare dismissal — correctly. The reason it is safe: the only thing left to do
      // with an error that the error handler itself threw is to drop it, and letting
      // it escape would convert a swallowed listener error into a crash *inside the
      // dispatch loop*, which is the exact outcome the surrounding catch exists to
      // prevent. `PowerScheduler._notifyError` carries the same guard for the same
      // reason.
    }
  }

  // ── Unified event API (Web Worker style) ──────────────────────────────────
  /**
   * @param {string} type
   * @param {function(...*):void} handler
   * @returns {this}
   */
  addEventListener(type, handler) {
    if (typeof handler !== 'function') return this;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return this;
  }

  /**
   * @param {string} type
   * @param {function(...*):void} handler
   * @returns {this}
   */
  removeEventListener(type, handler) {
    const set = this._listeners.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this._listeners.delete(type);
    }
    return this;
  }

  // ── Node-style event API ──────────────────────────────────────────────────
  /**
   * Node-style alias for {@link addEventListener}.
   * @param {string} type
   * @param {function(...*):void} handler
   * @returns {this}
   */
  on(type, handler) {
    return this.addEventListener(type, handler);
  }

  /**
   * Node-style alias for {@link removeEventListener}.
   * @param {string} type
   * @param {function(...*):void} handler
   * @returns {this}
   */
  off(type, handler) {
    return this.removeEventListener(type, handler);
  }

  // ── Messaging ─────────────────────────────────────────────────────────────
  /**
   * @param {*} message
   * @param {ArrayBuffer[]|ArrayBufferView[]|Object} [transfer]
   * @returns {*}
   */
  postMessage(message, transfer) {
    const w = this.worker;
    if (!w || typeof w.postMessage !== 'function') {
      throw new Error('Underlying worker does not implement postMessage');
    }
    const list = normalizeTransfer(transfer);
    if (list && list.length) {
      return w.postMessage(message, list);
    }
    return w.postMessage(message);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /**
   * @returns {Promise<void>|void}
   */
  terminate() {
    const w = this.worker;
    if (!w || typeof w.terminate !== 'function') return Promise.resolve();
    try {
      const result = w.terminate();
      if (result && typeof result.then === 'function') return result;
      return Promise.resolve(result);
    } catch (e) {
      return Promise.reject(e);
    }
  }
}

export default WorkerAgnostic;

export { detectEnv };
