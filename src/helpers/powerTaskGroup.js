/**
 * Structured concurrency: a scope that runs async tasks and cancels all of
 * them on exit.
 *
 * `PowerTaskGroup` (also called a `Scope`) owns an `AbortController` and a set
 * of in-flight tasks. Every task receives the scope's `AbortSignal`; when the
 * scope is disposed (or a task rejects and `cancelOnError` is set) all
 * siblings are aborted and the scope waits for them to settle.
 *
 * @module powerTaskGroup
 * @public
 */
import { assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {Object} PowerTaskGroupOptions
 * @property {boolean} [cancelOnError=true] - Abort siblings when a task rejects.
 */

export class PowerTaskGroup {
  /**
   * @param {PowerTaskGroupOptions} [options]
   */
  constructor(options = {}) {
    assertKnownOptions(options, ['cancelOnError'], 'PowerTaskGroup');
    const { cancelOnError = true } = options || {};
    this._cancelOnError = cancelOnError !== false;
    this._controller = new AbortController();
    this._tasks = new Set();
    this._disposed = false;
    this._firstError = null;
  }

  /** The scope's abort signal, shared by every task. */
  get signal() {
    return this._controller.signal;
  }

  /** Whether the scope has been disposed. */
  get disposed() {
    return this._disposed;
  }

  /** Number of tasks currently in flight. */
  get size() {
    return this._tasks.size;
  }

  /**
   * Run an async task inside the scope. The task receives the scope's
   * `AbortSignal` and may return a value. The returned promise resolves with
   * the task's result or rejects with its error (or an `AbortError` if the
   * scope was cancelled).
   *
   * @param {(signal: AbortSignal) => any} fn
   * @returns {Promise<any>}
   */
  run(fn) {
    if (this._disposed) {
      return Promise.reject(new Error('PowerTaskGroup: cannot run after dispose'));
    }
    if (typeof fn !== 'function') {
      throw new TypeError('PowerTaskGroup.run: fn must be a function');
    }
    const signal = this._controller.signal;
    const task = (async () => {
      try {
        return await fn(signal);
      } catch (e) {
        if (this._cancelOnError && !this._disposed) {
          this._firstError = this._firstError || e;
          this._controller.abort(e);
        }
        throw e;
      }
    })();
    this._tasks.add(task);
    task.finally(() => this._tasks.delete(task)).catch(() => {});
    return task;
  }

  /**
   * Spawn a task without awaiting it. Returns the promise for callers that
   * want to observe it; errors are still routed through `cancelOnError`.
   * @param {(signal: AbortSignal) => any} fn
   * @returns {Promise<any>}
   */
  spawn(fn) {
    return this.run(fn);
  }

  /**
   * Wait for all in-flight tasks to settle.
   * @returns {Promise<any[]>}
   */
  async all() {
    return Promise.allSettled([...this._tasks]).then((results) =>
      results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))
    );
  }

  /**
   * Abort every in-flight task and wait for them to settle.
   * @returns {Promise<void>}
   */
  async cancel() {
    if (this._disposed) return;
    this._disposed = true;
    this._controller.abort();
    await Promise.allSettled([...this._tasks]);
    this._tasks.clear();
  }

  /**
   * Dispose the scope: abort all tasks and wait for them to settle.
   * @returns {Promise<void>}
   */
  async dispose() {
    await this.cancel();
  }

  /**
   * Synchronous disposal: aborts all tasks but does not await them.
   * @returns {void}
   */
  [Symbol.dispose]() {
    if (this._disposed) return;
    this._disposed = true;
    this._controller.abort();
  }

  /**
   * Asynchronous disposal: aborts and awaits all tasks.
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}

export default PowerTaskGroup;
