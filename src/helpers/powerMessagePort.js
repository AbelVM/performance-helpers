/**
 * PowerMessagePort — a `MessagePort` transport adapter for `PowerRealtimeHub`.
 *
 * A `MessagePort` is the one transport where the **native** structured-clone
 * codec applies losslessly: `Map`, `Set`, `Date`, `BigInt` and cycles survive
 * the boundary without `JSON.stringify`-ing them into `{}` or an ISO string.
 * This class exists so the hub's `send(sub, frame)` / `close(sub)` contract
 * can be satisfied by a port, and so inbound messages are decoded through
 * `decodeInbound` — the same half the pool uses for native-carrier workers.
 *
 * ## Why this is a separate class and not a two-line arrow function
 *
 * The hub's `send` adapter is called as `send(sub, frame)` where `frame` is
 * the hub's own encoded `Uint8Array`. A bare `(sub, frame) => port.postMessage(frame)`
 * works for outbound, but inbound needs three things the arrow does not give
 * you:
 *
 * 1. `decodeInbound` on every `onmessage` payload, so a native envelope is
 *    unpacked before it reaches the subscriber's handler.
 * 2. Listener cleanup on `dispose()` — a port that outlives its adapter leaks
 *    the handler closure, and a second `dispose()` must not throw.
 * 3. A `close()` that is safe to call more than once and safe on a port that
 *    closed first.
 *
 * @module powerMessagePort
 * @public
 */
import { decodeInbound } from './powerMessageCodec.js';
import { attach, detach } from './metrics.js';
import { assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {object} PowerMessagePortOptions
 * @property {function(any, (string|undefined)):void} [onMessage] - Called with
 *   the decoded `value` and optional `correlationId` for each inbound message.
 * @property {function():void} [onClose] - Called when the port closes.
 * @property {function(Error):void} [onError] - Called when an inbound message
 *   cannot be decoded.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] -
 *   Opt in to metrics. See `guides/metrics.md`.
 */

export class PowerMessagePort {
  /**
   * @param {MessagePort} port - An open or opening `MessagePort`. The adapter
   *   attaches listeners immediately; a port that is not yet `open` queues
   *   messages until it is, which is the platform's normal behaviour.
   * @param {PowerMessagePortOptions} [options]
   */
  constructor(port, options = /** @type {PowerMessagePortOptions} */ ({})) {
    assertKnownOptions(
      options,
      ['onMessage', 'onClose', 'onError', 'observability'],
      'PowerMessagePort'
    );
    if (!port || typeof port.postMessage !== 'function') {
      throw new TypeError(
        'PowerMessagePort: expected a MessagePort. It needs a `postMessage` method.'
      );
    }

    /** @type {MessagePort} */
    this._port = port;
    /** @type {?((arg0: any, arg1: string | undefined) => void)} */
    this._onMessage = options.onMessage || null;
    /** @type {?(() => void)} */
    this._onClose = options.onClose || null;
    /** @type {?((arg0: Error) => void)} */
    this._onError = options.onError || null;
    /** @type {boolean} */
    this._disposed = false;
    /** @type {number} */
    this._sentCount = 0;
    /** @type {number} */
    this._receivedCount = 0;
    /** @type {number} */
    this._errorCount = 0;
    /** @type {'open'|'closed'} */
    this._state = 'open';

    // FEAT-007: opt-in metrics. Off by default.
    this._metrics = attach(this, 'messagePort', options);

    this._attach();
  }

  /**
   * The hub's `send(sub, frame)` adapter.
   *
   * Posts the hub's encoded `Uint8Array` frame to the port. The frame is the
   * hub's own buffer, handed over by reference — the platform serialises
   * synchronously, so a transport that wrote into it would corrupt every other
   * subscriber on the same topic. Copy it if you need to retain it.
   *
   * @param {object} _sub - The subscriber record (unused; present so the hub's
   *   `send(sub, frame)` signature is satisfied).
   * @param {Uint8Array} frame - The hub's encoded frame.
   * @returns {boolean} `false` when the port is already disposed. Throws only
   *   for a platform error.
   */
  send(_sub, frame) {
    if (this._disposed) return false;
    try {
      this._port.postMessage(frame);
    } catch (e) {
      this._emitError(/** @type {Error} */ (e));
      return false;
    }
    this._sentCount++;
    return true;
  }

  /**
   * The hub's `close(sub)` adapter.
   *
   * Safe to call more than once, and safe on a port that closed first.
   *
   * @returns {void}
   */
  close() {
    if (this._disposed) return;
    this._disposed = true;
    this._state = 'closed';
    this._detach();
    try {
      this._port.close?.();
    } catch (e) {
      this._emitError(/** @type {Error} */ (e));
    }
  }

  /**
   * Detach every listener and drop the port reference.
   *
   * Required rather than tidy: a `MessagePort` outliving its adapter keeps the
   * handler closure alive, and a peer table that never disposes leaks one
   * adapter per port for the life of the process.
   *
   * `dispose()` is idempotent.
   *
   * @returns {void}
   */
  dispose() {
    detach(this._metrics);
    this._metrics = null;
    if (this._disposed) return;
    this._disposed = true;
    this._detach();
    try {
      this._port.close?.();
    } catch (e) {
      this._emitError(/** @type {Error} */ (e));
    }
    this._onMessage = null;
    this._onClose = null;
    this._onError = null;
    this._port = /** @type {any} */ (null);
  }

  /**
   * Alias for {@link PowerMessagePort#dispose}, so `using` works.
   */
  [Symbol.dispose]() {
    this.dispose();
  }

  /**
   * A minimal snapshot for the metrics collector.
   *
   * @returns {object}
   */
  stats() {
    return {
      sentCount: this._sentCount,
      receivedCount: this._receivedCount,
      errorCount: this._errorCount,
      state: this._state,
      disposed: this._disposed,
    };
  }

  /**
   * Alias for {@link stats}.
   *
   * See `guides/stats-naming.md` for why both spellings exist and why this
   * method is written out per class.
   */
  getStats() {
    return this.stats();
  }

  /**
   * @private
   */
  _attach() {
    /** @type {any} */
    const port = this._port;
    this._onMessageHandler = (/** @type {MessageEvent} */ e) => {
      if (this._disposed) return;
      try {
        const { value, correlationId } = decodeInbound(e.data);
        if (this._onMessage) this._onMessage(value, correlationId);
        this._receivedCount++;
      } catch (err) {
        this._emitError(/** @type {Error} */ (err));
      }
    };
    this._onCloseHandler = () => {
      if (this._disposed) return;
      this._disposed = true;
      this._state = 'closed';
      this._detach();
      if (this._onClose) this._onClose();
    };
    this._onMessageErrorHandler = (/** @type {ErrorEvent} */ e) => {
      if (this._disposed) return;
      this._emitError(e.error ?? new Error('MessagePort message error'));
    };

    port.onmessage = this._onMessageHandler;
    port.onmessageerror = this._onMessageErrorHandler;
    /** @type {any} */
    port.onclose = this._onCloseHandler;
  }

  /**
   * @private
   */
  _detach() {
    const port = this._port;
    if (!port) return;
    port.onmessage = null;
    port.onmessageerror = null;
    /** @type {any} */ (port).onclose = null;
  }

  /**
   * @private
   * @param {unknown} err
   */
  _emitError(err) {
    this._errorCount++;
    if (this._onError) this._onError(/** @type {Error} */ (err));
  }
}
