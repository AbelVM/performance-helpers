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

// Lazily obtain a CommonJS `require` WITHOUT a *static* `import 'module'`
// (which browser bundlers such as Vite/webpack/esbuild cannot resolve). In
// CJS-transpiled contexts (vitest) a global `require` exists and is used
// directly. In pure ESM Node we synthesize one via `createRequire`, loaded
// through an opaque dynamic import cached at module scope. The browser never
// executes this because `detectEnv()` never returns 'node' there, so the Node
// builtin is never requested and bundlers never see it.
let _nodeRequire = null;
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
    // eslint-disable-next-line no-new-func
    _nodeRequirePromise = new Function('return import("node:module")')().then((m) => {
      _nodeRequire = m.createRequire(
        typeof import.meta !== 'undefined' ? import.meta.url : process.cwd() + '/'
      );
      return _nodeRequire;
    });
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
      'Call `await WorkerAgnostic.preloadNode()` once before constructing a string-source ' +
      'worker, set globalThis.Worker, or pass a factory function instead of a path string.'
  );
}

function detectEnv() {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') return 'browser';
  if (typeof self !== 'undefined' && typeof self.importScripts === 'function') return 'webworker';
  if (typeof process !== 'undefined' && process.versions?.node) return 'node';
  return 'unknown';
}

// Normalized event types supported across environments.
const SUPPORTED_EVENTS = ['message', 'error', 'messageerror'];

/**
 * Resolve and create the underlying native worker for the given source.
 *
 * @param {Function|string} workerSource - Worker constructor, factory function,
 *   or path/URL string.
 * @param {Object} options - Options forwarded to the native Worker constructor.
 * @param {string} env - Resolved environment from `detectEnv()`.
 * @returns {object} The underlying worker-like object.
 * @private
 */
function resolveWorker(workerSource, options, env) {
  // When a global `Worker` constructor is available (a browser, a Web Worker
  // polyfill, or a runtime that aliases Node's worker_threads to `Worker` as
  // the bench harness does) prefer it for string sources. This keeps callers
  // that set `globalThis.Worker` (e.g. for tests or cross-runtime shims)
  // transparently honored without environment-specific branching.
  if (
    typeof globalThis !== 'undefined' &&
    typeof globalThis.Worker === 'function' &&
    typeof workerSource === 'string'
  ) {
    return new globalThis.Worker(workerSource, options);
  }

  if (env === 'node') {
    const Worker = getNodeWorkerCtor();
    if (typeof workerSource === 'function') {
      return createFromFunction(workerSource, Worker, options, env);
    }
    if (typeof workerSource === 'string') {
      return new Worker(workerSource, options);
    }
    throw new Error('Invalid workerSource: expected Worker factory or path string');
  }

  if (env === 'browser' || env === 'webworker') {
    if (typeof workerSource === 'function') {
      return createFromFunction(workerSource, Worker, options, env);
    }
    if (typeof workerSource === 'string') {
      return createWebWorkerFromString(workerSource, options);
    }
    throw new Error('Invalid workerSource: expected Worker factory or path string');
  }

  throw new Error('Unsupported environment for WorkerAgnostic');
}

/**
 * Create a worker from a function source. The function may be a constructable
 * class (invoked with `new`) or an arrow/bound factory (invoked directly).
 * If the factory returns a worker-like object it is used as-is; if it returns
 * a string it is treated as a module specifier and a native Worker is built
 * from it.
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
 * @private
 */
function coerceFactoryResult(result, WorkerCtor, options, env) {
  if (result && typeof result === 'object' && typeof result.postMessage === 'function') {
    return result;
  }
  if (typeof result === 'string') {
    return env === 'node'
      ? new WorkerCtor(result, options)
      : createWebWorkerFromString(result, options);
  }
  return result && typeof result === 'object' ? result : {};
}

/**
 * Create a Web Worker from a (possibly relative) path string, resolving it
 * against the current module URL in bundler contexts when possible.
 * @private
 */
function createWebWorkerFromString(workerSource, options) {
  let baseUrl;
  try {
    // Read `import.meta.url` at runtime via a dynamic function so bundlers do
    // not statically parse (and thus externalize) `import.meta`.
    // eslint-disable-next-line no-new-func
    baseUrl = new Function('try { return import.meta?.url } catch (e) { return undefined }')();
  } catch (e) {
    baseUrl = undefined;
  }
  if (!baseUrl && typeof document !== 'undefined') {
    const cs = document.currentScript;
    if (cs?.src) baseUrl = cs.src;
  }
  if (!baseUrl && typeof location !== 'undefined' && location.href) baseUrl = location.href;
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
   * @param {Object} [options] - Options forwarded to the native Worker
   *   constructor (e.g. `{ type: 'module' }` for Node, or worker options for
   *   the browser).
   */
  constructor(workerSource, options = {}) {
    this.env = detectEnv();
    this.options = options && typeof options === 'object' ? options : {};
    // unified listener registry: event name -> Set<handler>
    this._listeners = new Map();
    this.worker = resolveWorker(workerSource, this.options, this.env);
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
    if (typeof w.addEventListener === 'function') {
      this._nativeModel = 'listener';
      for (const type of SUPPORTED_EVENTS) {
        w.addEventListener(type, (...args) => this._dispatch(type, ...args));
      }
    } else if (typeof w.on === 'function') {
      this._nativeModel = 'emitter';
      for (const type of SUPPORTED_EVENTS) {
        w.on(type, (...args) => this._dispatch(type, ...args));
      }
    } else {
      this._nativeModel = 'property';
      w.onmessage = (...args) => this._dispatch('message', ...args);
      w.onerror = (...args) => this._dispatch('error', ...args);
      w.onmessageerror = (...args) => this._dispatch('messageerror', ...args);
    }
  }

  /**
   * Dispatch a native event to all registered unified listeners, normalizing
   * the payload shape so consumers see a consistent `{ data }` for `message`
   * regardless of whether the runtime is Node (value delivered directly) or a
   * Web Worker (value delivered via `event.data`).
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
        // Never let a listener error break the worker event loop.
      }
    }
  }

  // ── Unified event API (Web Worker style) ──────────────────────────────────
  addEventListener(type, handler) {
    if (typeof handler !== 'function') return this;
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return this;
  }

  removeEventListener(type, handler) {
    const set = this._listeners.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this._listeners.delete(type);
    }
    return this;
  }

  // ── Node-style event API ──────────────────────────────────────────────────
  on(type, handler) {
    return this.addEventListener(type, handler);
  }

  off(type, handler) {
    return this.removeEventListener(type, handler);
  }

  // ── Messaging ─────────────────────────────────────────────────────────────
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
