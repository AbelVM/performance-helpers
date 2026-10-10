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
 * @property {WritableStreamDefaultWriter|null} writer
 * @property {AbortController|null} abort
 * @property {boolean} closed
 * @property {number} seq - Monotonic per-subscriber event id, emitted as the
 *   SSE `id:` field. See {@link frameToSseLine}.
 * @property {string|null} lastEventId - The `Last-Event-ID` the client sent when
 *   it (re)connected, or `null` on a first connect. This is the resume point;
 *   replaying from it is the caller's job, because the adapter holds no buffer.
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
 * Base64-encode a `Uint8Array` for one SSE `data:` line, prefixed with an `id:`.
 *
 * **The `id:` field is the whole of AUD-025, and its absence was the bug.** SSE
 * reconnection is driven by the *client*: a browser `EventSource` that loses its
 * connection reconnects on its own and sends a `Last-Event-ID` header carrying
 * the last `id:` the server emitted. This adapter wrote only `data:` lines, so
 * there was never an `id:` to remember, so the header was never sent, so every
 * reconnect silently dropped everything emitted during the gap — data loss for a
 * telemetry or log-streaming use case, with nothing on either side reporting it.
 *
 * `id:` and `data:` go out in **one write**, not two. They are one SSE event
 * block and the spec dispatches them together; two writes would be two stream
 * writes per frame, which is back-pressure the caller pays for nothing.
 *
 * @param {Uint8Array} frame
 * @param {number} seq - Monotonic per-subscriber event id.
 * @returns {string}
 */
function frameToSseLine(frame, seq) {
  let binary = '';
  const len = frame.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(frame[i]);
  }
  return 'id: ' + seq + '\ndata: ' + btoa(binary) + '\n\n';
}

/**
 * The `Last-Event-ID` a reconnecting client sent, or `null` on a first connect.
 *
 * Read from the Node `ServerResponse`'s request headers. The header name is
 * case-insensitive per HTTP, and Node lower-cases incoming header names, so the
 * lower-case spelling is the one that is actually present — but both are checked
 * because a caller supplying their own transport shape is not bound by Node's
 * normalisation.
 *
 * @param {any} sub
 * @returns {string|null}
 */
function readLastEventId(sub) {
  const req = sub?.transport?.req;
  const headers = req?.headers;
  if (!headers) return null;
  const raw = headers['last-event-id'] ?? headers['Last-Event-ID'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Build a `send(subscriber, frame)` adapter for SSE.
 *
 * The adapter owns the per-subscriber writer lifecycle: it writes each frame
 * as one SSE `data:` line, awaits back-pressure, and closes the stream when
 * the hub detaches the subscriber.
 *
 * @param {SseAdapterOptions} [options]
 */
export function createSseAdapter(options = {}) {
  assertKnownOptions(options, ['createResponse', 'onError'], 'createSseAdapter');
  const { createResponse, onError } = options;

  /** @type {Map<string, SseSubscriber>} */
  const subs = new Map();

  /**
   * @param {object} sub
   * @param {Uint8Array} frame
   * @returns {Promise<void>}
   */
  async function send(sub, frame) {
    const sseSub = subs.get(/** @type {any} */ (sub).id);
    if (!sseSub || /** @type {any} */ (sseSub).closed) return;

    // AUD-025. Advance the per-subscriber sequence *before* writing, so the id
    // the client remembers is the id of the event it actually received. Starting
    // at 1 rather than 0 because `Last-Event-ID` is a string on the wire and a
    // first connect sends none — `0` would be indistinguishable from "no id yet"
    // to a caller comparing them.
    sseSub.seq += 1;
    const line = frameToSseLine(frame, sseSub.seq);
    try {
      if (/** @type {any} */ (sseSub).writer) {
        await /** @type {any} */ (sseSub).writer.write(line);
      } else if (typeof (/** @type {any} */ (sub).transport?.write) === 'function') {
        /** @type {any} */ (sub).transport.write(line);
      }
    } catch (/** @type {any} */ err) {
      if (onError) onError(err, sub);
      throw err;
    }
  }

  /**
   * @param {object} sub
   */
  function close(sub) {
    const sseSub = subs.get(/** @type {any} */ (sub).id);
    if (!sseSub || /** @type {any} */ (sseSub).closed) return;
    /** @type {any} */ (sseSub).closed = true;
    try {
      if (/** @type {any} */ (sseSub).writer) {
        /** @type {any} */ (sseSub).writer.close().catch(() => {});
      } else if (typeof (/** @type {any} */ (sub).transport?.end) === 'function') {
        /** @type {any} */ (sub).transport.end();
      }
    } catch {
      // ignore; subscriber stream is already closed
    }
    subs.delete(/** @type {any} */ (sub).id);
  }

  /**
   * Register a subscriber with the adapter.
   *
   * AUD-025. Reads the `Last-Event-ID` the client sent, so a caller wiring this
   * into a hub can replay from it. **The adapter deliberately does not replay.**
   * It holds no buffer of past frames — it is a `send(sub, frame)` bridge, and a
   * replay buffer is the message source's concern, not the transport's. What the
   * adapter owes the caller is the resume *point*, exposed as `lastEventId` on
   * the subscriber record and through {@link lastEventId}; without it the caller
   * cannot know where the client got to, and the gap is unfixable from above.
   *
   * @param {object} sub
   * @returns {void}
   */
  function register(sub) {
    if (subs.has(/** @type {any} */ (sub).id)) return;
    let writer = null;
    /** @type {AbortController | null} */ let abort = null;
    if (createResponse) {
      try {
        const response = createResponse(sub);
        const r = /** @type {any} */ (response);
        if (r && r.body) {
          const body = /** @type {any} */ (r.body);
          if (typeof body.getWriter === 'function') {
            writer = body.getWriter();
            abort = new AbortController();
          }
        }
      } catch (/** @type {any} */ error) {
        if (onError) onError(error, sub);
        return;
      }
    } else if (/** @type {any} */ (sub).transport) {
      writer = /** @type {any} */ (null);
      abort = new AbortController();
    }
    subs.set(/** @type {any} */ (sub).id, {
      id: /** @type {any} */ (sub).id,
      writer,
      abort: /** @type {any} */ (abort),
      closed: false,
      seq: 0,
      lastEventId: readLastEventId(sub),
    });
  }

  /**
   * The `Last-Event-ID` a subscriber sent when it connected, or `null`.
   *
   * `null` means a first connect — there is nothing to resume from. A string
   * means the client reconnected after a gap and is telling the server where it
   * got to; the caller replays from there.
   *
   * @param {object} sub
   * @returns {string|null}
   */
  function lastEventId(sub) {
    const sseSub = subs.get(/** @type {any} */ (sub).id);
    return sseSub ? sseSub.lastEventId : null;
  }

  /**
   * The id of the last event written to a subscriber, or `0` if none.
   *
   * The counterpart to {@link lastEventId}: where the *server* has got to, as
   * against where the *client* got to. The difference between the two is exactly
   * the size of the gap a reconnect has to replay.
   *
   * @param {object} sub
   * @returns {number}
   */
  function lastSentId(sub) {
    const sseSub = subs.get(/** @type {any} */ (sub).id);
    return sseSub ? sseSub.seq : 0;
  }

  function dispose() {
    if (subs.size === 0) return;
    for (const sub of subs.values()) {
      try {
        if (sub.writer) sub.writer.close().catch(() => {});
      } catch {
        // Ignore cleanup errors when closing SSE writer; they are non-fatal.
      }
      subs.delete(/** @type {any} */ (sub).id);
    }
    subs.clear();
  }

  return {
    send,
    close,
    register,
    lastEventId,
    lastSentId,
    dispose,
    [Symbol.dispose]: dispose,
    [Symbol.asyncDispose]: async () => {
      dispose();
      return;
    },
  };
}
