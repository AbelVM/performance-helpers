/**
 * Server-sent events (SSE) transport adapter for `PowerRealtimeHub`.
 *
 * ## The problem this exists for
 *
 * SSE is HTTP/1.1-native, works through every proxy and CDN, and is simpler
 * than WebSocket for unidirectional push. The hub is transport-agnostic: it
 * only needs a `send(subscriber, frame)` function. This adapter bridges that
 * contract to an SSE `Response` stream, so a hub can fan out to browser
 * clients over `EventSource` without WebSocket infrastructure.
 *
 * ## On the wire
 *
 * Each frame is written as one SSE `data:` line, base64-encoded so binary
 * payloads do not break the event-stream format. The hub's `codec: 'raw'`
 * path is supported: a raw frame is already a single payload, so it is
 * written as one line. With `codec: 'json'` the hub already batches values
 * into one JSON array frame, so the adapter does not split frames.
 *
 * @module powerSseAdapter
 * @public
 */
import { assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {object} SseSubscriber
 * @property {string} id
 * @property {WritableStreamDefaultWriter} writer
 * @property {AbortController} abort
 * @property {boolean} closed
 */

/**
 * @typedef {object} SseAdapterOptions
 * @property {function(object):Response} [createResponse] - Required in the
 *   browser. Receives the subscriber record and must return an SSE `Response`
 *   whose body is a `WritableStream`. When omitted the adapter falls back to
 *   Node's `ServerResponse` shape if `subscriber.transport` exposes
 *   `writeHead`/`write`/`end`.
 * @property {function(Error, object):void} [onError] - Called when a write
 *   to the stream throws, instead of leaving an unhandled rejection.
 */

/**
 * Base64-encode a `Uint8Array` for one SSE `data:` line.
 *
 * @param {Uint8Array} frame
 * @returns {string}
 */
function frameToSseLine(frame) {
  let binary = '';
  const len = frame.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(frame[i]);
  }
  return 'data: ' + btoa(binary) + '\n\n';
}

/**
 * Build a `send(subscriber, frame)` adapter for SSE.
 *
 * The adapter owns the per-subscriber writer lifecycle: it writes each frame
 * as one SSE `data:` line, awaits back-pressure, and closes the stream when
 * the hub detaches the subscriber.
 *
 * @param {SseAdapterOptions} [options]
 * @returns {{ send: function(object, Uint8Array): Promise<void>, close: function(object, string): void }}
 */
export function createSseAdapter(options = {}) {
  assertKnownOptions(options, ['createResponse', 'onError'], 'createSseAdapter');
  const { createResponse, onError } = options;

  /** @type {Map<string, SseSubscriber>} */
  const subs = new Map();

  /**
   * @param {HubSubscriber} sub
   * @param {Uint8Array} frame
   * @returns {Promise<void>}
   */
  async function send(sub, frame) {
    const sseSub = subs.get(sub.id);
    if (!sseSub || sseSub.closed) return;

    const line = frameToSseLine(frame);
    try {
      if (sseSub.writer) {
        await sseSub.writer.write(line);
      } else if (typeof sub.transport?.write === 'function') {
        sub.transport.write(line);
      }
    } catch (/** @type {any} */ err) {
      if (onError) onError(err, sub);
      throw err;
    }
  }

  /**
   * @param {HubSubscriber} sub
   */
  function close(sub) {
    const sseSub = subs.get(sub.id);
    if (!sseSub || sseSub.closed) return;
    sseSub.closed = true;
    try {
      if (sseSub.writer) {
        sseSub.writer.close().catch(() => {});
      } else if (typeof sub.transport?.end === 'function') {
        sub.transport.end();
      }
    } catch {
      // ignore; subscriber stream is already closed
    }
    subs.delete(sub.id);
  }

  /**
   * Register a subscriber with the adapter.
   *
   * @param {HubSubscriber} sub
   * @returns {void}
   */
  function register(sub) {
    if (subs.has(sub.id)) return;
    let writer = null;
    let abort = null;
    if (createResponse) {
      try {
        const response = createResponse(sub);
        if (response?.body?.getWriter) {
          writer = response.body.getWriter();
          abort = new AbortController();
        }
      } catch (/** @type {any} */ error) {
        if (onError) onError(error, sub);
        return;
      }
    } else if (sub.transport) {
      writer = /** @type {WritableStreamDefaultWriter} */ (null);
      abort = new AbortController();
    }
    subs.set(sub.id, { id: sub.id, writer, abort, closed: false });
  }

  return { send, close, register };
}
