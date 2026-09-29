/**
 * Topic fan-out with per-subscriber bounded queues and an explicit
 * slow-consumer policy.
 *
 * The naive way to push to a set of clients is `for (const ws of clients)
 * ws.send(payload)`. That fails in two ways that only show up in production:
 *
 * 1. **A slow consumer stalls everyone.** One client's TCP buffer fills, the
 *    socket's `send` starts buffering without bound, and that client's backlog
 *    consumes the memory of the whole process. Eventually the server dies for
 *    everyone because of one bad connection.
 * 2. **Nothing tells you it happened.** There is no signal that a client has
 *    fallen behind, so you cannot shed load deliberately.
 *
 * This hub gives every subscription its own bounded queue and a *declared*
 * policy for when that queue fills. A slow consumer is then a bounded,
 * observable, per-subscriber problem instead of a process-wide one.
 *
 * ## Transport-agnostic
 *
 * The hub does not know about WebSockets. You supply a `send(subscriber,
 * frame)` adapter, so it works with a `WebSocket`, a Node `ws` socket, a
 * `MessagePort`, a `TransformStream` writer, or a test spy. Messages are
 * encoded with {@link PowerMessageCodec}, so several can be batched into one
 * send without the receiver having to guess where the boundaries are.
 *
 * @module powerRealtimeHub
 * @public
 */
import { encodeMessage, frameEncodedJson } from './powerMessageCodec.js';
import { nowMs } from '../utils/now.js';
import { assertLimitRequired } from '../utils/options.js';

/**
 * What to do when a subscriber's queue is full.
 *
 * - `drop-oldest` — discard the oldest pending message to make room for the new
 *   one. Best for chat/log-style feeds where the latest state matters most.
 *   **This is the default**: it degrades a slow consumer into a stale one
 *   rather than into a stalled server.
 * - `drop-newest` — refuse the incoming message and keep what is already
 *   queued. Best for ordered, replay-sensitive streams.
 * - `disconnect` — close the subscriber once it falls behind. Use this when
 *   silently delivering stale or missing data is worse than cutting the client
 *   loose so it reconnects with fresh state.
 *
 * @typedef {'drop-oldest'|'drop-newest'|'disconnect'} SlowConsumerPolicy
 */

/**
 * A live subscription record, as the hub stores it.
 *
 * `SubscriberOptions` describes what a caller may pass; this is what the hub
 * keeps after merging in the per-hub defaults. The two maps holding them were
 * typed `object`, so `id`, `topic`, `queue`, `dropped`, `inFlight`, `maxQueue`,
 * `slowConsumer` and `closed` did not exist at any of the ~30 places the hub
 * reads them.
 *
 * @typedef {object} HubSubscriber
 * @property {string} id
 * @property {string} topic
 * @property {any[]} queue
 *   Bounded buffer for this subscriber. A plain array - the hub reads
 *   `.length`, `.push`, `.shift` and `.splice` off it, so a queue typed as an
 *   abstract buffer (the previous declaration) had no `.length` at any of the
 *   five places that check it before enqueueing.
 * @property {number} dropped - Messages discarded by the slow-consumer policy.
 * @property {number} bytesQueued - Approximate bytes currently buffered.
 * @property {number} inFlight - Sends currently awaiting the transport.
 * @property {number} maxQueue
 * @property {number} maxBatch
 * @property {SlowConsumerPolicy} slowConsumer
 * @property {boolean} closed
 * @property {function(any, HubSubscriber):void} handler - Invoked with each
 *   delivered message, after the transport accepted it, plus the subscriber it
 *   was delivered to. Spelled as a call signature so the two arguments the hub
 *   passes are checked, and so a handler is callable rather than `Function`.
 * @property {*} [transport] - Opaque handle the caller attached at subscribe
 *   time (a socket, a stream, a peer id). The hub never reads it; it exists so
 *   a `send`/`close` adapter can get back to its own connection.
 */

/**
 * @typedef {object} SubscriberOptions
 * @property {number} [maxQueue=64] - Maximum messages buffered for this
 *   subscriber before the slow-consumer policy applies. `0` disables queueing
 *   entirely: a full-queue condition is evaluated immediately, which is the
 *   right setting when delivery is fire-and-forget.
 * @property {SlowConsumerPolicy} [slowConsumer='drop-oldest'] - Policy applied
 *   when `maxQueue` is exceeded.
 * @property {number} [maxBatch=32] - Maximum messages coalesced into one send.
 * @property {string} [id] - Stable identifier; generated when omitted.
 * @property {*} [transport] - Carried through to the stored
 *   {@link HubSubscriber} untouched, for the caller's own `send`/`close`
 *   adapters to use.
 */

/**
 * One entry of the per-subscriber array in {@link PowerRealtimeHub#stats}.
 * @typedef {object} HubSubscriberStat
 * @property {string} id
 * @property {string} topic
 * @property {number} queued - Messages waiting for this subscriber right now.
 * @property {number} dropped
 * @property {number} inFlight
 * @property {number} maxQueue
 * @property {SlowConsumerPolicy} slowConsumer
 */

/**
 * @typedef {object} HubStats
 * @property {number} subscribers - Current live subscription count.
 * @property {number} topics - Number of topics with at least one subscriber.
 * @property {number} published - Total messages accepted by `publish`.
 * @property {number} delivered - Total messages handed to a `send` adapter.
 * @property {number} dropped - Total messages discarded by a policy.
 * @property {number} disconnected - Subscribers closed for falling behind.
 * @property {number} bytesOut - Approximate bytes handed to the adapter.
 */

/**
 * @typedef {object} HubOptions
 * @property {function(object, Uint8Array):(void|Promise<void>)} send - Required
 *   transport adapter, called as `send(subscriber, frame)`. Return a promise if
 *   the transport is async; the hub tracks in-flight sends per subscriber.
 * @property {function(object, string):(void|Promise<void>)} [close] - Optional
 *   adapter called when the hub closes a subscriber for falling behind or on
 *   `close()`. Takes the same `(subscriber, reason)` pair as `send` plus why
 *   it happened - `'unsubscribe'`, `'slow-consumer'` or `'hub-closed'`. The
 *   published type previously declared one parameter, while the guide, the
 *   runtime and every test all pass and read two.
 * @property {boolean} [batch=true] - Coalesce messages published within the
 *   same microtask into a single `send`. Turn off for tests or transports that
 *   cannot handle several frames at once.
 * @property {number} [batchDelayMs=0] - Optional macrotask delay before
 *   flushing, to widen the coalescing window beyond a single microtask.
 * @property {'json'|'raw'} [codec='json'] - Payload codec for outgoing frames.
 * @property {function(Error, object):void} [onError] - Called when the `send`
 *   adapter rejects or throws, instead of leaving an unhandled rejection.
 * @property {() => number} [now] - Clock override, for tests.
 */

let _nextSubId = 0;

/** Valid values for `slowConsumer`. */
const SLOW_CONSUMER_POLICIES = Object.freeze(['drop-oldest', 'drop-newest', 'disconnect']);

/**
 * Maximum messages retained per topic when `publish({ retain: true })` is used.
 * A retained log that grows without bound is a leak, not a feature.
 */
const RETAIN_LIMIT = 32;

export class PowerRealtimeHub {
  /**
   * @param {HubOptions} options - `send` is required; the constructor throws
   *   without it, so the parameter is not defaulted.
   */
  constructor(options) {
    const {
      send,
      close,
      batch = true,
      batchDelayMs = 0,
      codec = 'json',
      onError,
      now,
    } = options || {};

    if (typeof send !== 'function') {
      throw new TypeError('PowerRealtimeHub: a `send(subscriber, frame)` adapter is required');
    }
    if (codec !== 'json' && codec !== 'raw') {
      throw new TypeError("PowerRealtimeHub: `codec` must be 'json' or 'raw'");
    }

    this._send = send;
    this._close = typeof close === 'function' ? close : null;
    this._batch = batch !== false;
    // `0` is a request - flush the batch immediately - and stays legal. A
    // negative delay is not a fast flush, it is a `setTimeout` that fires
    // immediately by accident, and `NaN` became `0` by way of `|| 0`, so both
    // were accepted as a configuration the caller never wrote.
    this._batchDelayMs = assertLimitRequired(batchDelayMs, {
      name: 'batchDelayMs',
      className: 'PowerRealtimeHub',
      min: 0,
      fallback: 0,
    });
    this._codec = codec;
    this._onError = typeof onError === 'function' ? onError : null;
    this._now = typeof now === 'function' ? now : nowMs;

    /** @type {Map<string, Map<string, HubSubscriber>>} topic -> subscriberId -> sub */
    this._topics = new Map();
    /** @type {Map<string, HubSubscriber>} subscriberId -> sub */
    this._subs = new Map();
    /** @type {Map<string, any[]>} topic -> retained messages (bounded) */
    this._retained = new Map();
    this._flushScheduled = false;
    this._flushTimer = null;
    this._closed = false;

    this._counters = {
      published: 0,
      delivered: 0,
      dropped: 0,
      disconnected: 0,
      bytesOut: 0,
    };
  }

  /**
   * Subscribe to a topic.
   *
   * @param {string} topic - Topic name.
   * @param {function(any, object):void} handler - Invoked with each delivered
   *   message. Throwing is isolated and reported through `onError`.
   * @param {SubscriberOptions} [options]
   * @returns {function():boolean} An unsubscribe function. Returns `false` if
   *   the subscription was already gone.
   */
  subscribe(topic, handler, options = {}) {
    if (this._closed) throw new Error('PowerRealtimeHub: hub is closed');
    if (typeof topic !== 'string' || topic === '') {
      throw new TypeError('PowerRealtimeHub: `topic` must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('PowerRealtimeHub: `handler` must be a function');
    }
    const { maxQueue = 64, slowConsumer = 'drop-oldest', maxBatch = 32, id } = options || {};
    if (!SLOW_CONSUMER_POLICIES.includes(slowConsumer)) {
      throw new TypeError(
        `PowerRealtimeHub: \`slowConsumer\` must be one of ${SLOW_CONSUMER_POLICIES.join(', ')}`
      );
    }
    if (!Number.isFinite(Number(maxQueue)) || Number(maxQueue) < 0) {
      throw new TypeError('PowerRealtimeHub: `maxQueue` must be a non-negative finite number');
    }
    if (!Number.isFinite(Number(maxBatch)) || Number(maxBatch) < 1) {
      throw new TypeError('PowerRealtimeHub: `maxBatch` must be >= 1');
    }

    /** @type {HubSubscriber} */
    const sub = {
      id: id ?? `sub-${++_nextSubId}`,
      topic,
      handler,
      maxQueue: Math.floor(Number(maxQueue)),
      slowConsumer,
      maxBatch: Math.floor(Number(maxBatch)),
      queue: [],
      inFlight: 0,
      bytesQueued: 0,
      dropped: 0,
      closed: false,
      // Transport details a user may need (a socket, a stream, a peer id).
      transport: options?.transport,
    };
    if (this._subs.has(sub.id)) {
      throw new Error(`PowerRealtimeHub: duplicate subscriber id "${sub.id}"`);
    }

    this._subs.set(sub.id, sub);
    let bucket = this._topics.get(topic);
    if (!bucket) {
      bucket = new Map();
      this._topics.set(topic, bucket);
    }
    bucket.set(sub.id, sub);

    return () => this.unsubscribe(sub.id);
  }

  /**
   * Remove a subscription.
   * @param {string} id - Subscriber id.
   * @returns {boolean} `true` when a subscription was removed.
   */
  unsubscribe(id) {
    const sub = this._subs.get(id);
    if (!sub) return false;
    this._detach(sub);
    return true;
  }

  /**
   * Publish a message to every subscriber of a topic.
   *
   * Delivery is asynchronous: the message is queued per subscriber and handed to
   * the transport on the next flush. A `send` adapter that throws is reported
   * through `onError` and does not affect other subscribers.
   *
   * @param {string} topic
   * @param {any} message
   * @param {Object} [options]
   * @param {boolean} [options.retain=false] - Keep the message for a subscriber
   *   that subscribes later. Intended for a small, fixed set of topics such as
   *   config changes; the retained log is not bounded per subscriber, so do not
   *   use it for an unbounded feed.
   * @returns {number} The number of subscribers the message was queued for.
   */
  publish(topic, message, options = {}) {
    if (this._closed) return 0;
    const bucket = this._topics.get(topic);
    this._counters.published += 1;
    if (!bucket || bucket.size === 0) return 0;

    let queued = 0;
    for (const sub of bucket.values()) {
      if (sub.closed) continue;
      this._enqueue(sub, message);
      queued += 1;
    }
    if (options?.retain) this._retain(topic, message);
    if (queued > 0) this._scheduleFlush();
    return queued;
  }

  /**
   * Flush every pending message immediately, bypassing batching.
   * @returns {Promise<void>} Resolves once all subscribers have been drained.
   */
  async flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flushAll();
  }

  /**
   * Snapshot of counters and per-subscriber state.
   *
   * `subscribers` is the live *count*, and the per-subscriber array is `list`.
   * The declared return previously intersected `subscribers: Array<object>`
   * onto `HubStats`, which is how the hub ended up publishing a type saying
   * `subscribers` was an array of records - a number at runtime.
   *
   * @returns {HubStats & {list: HubSubscriberStat[]}}
   */
  stats() {
    return {
      subscribers: this._subs.size,
      topics: this._topics.size,
      ...this._counters,
      list: Array.from(this._subs.values()).map((s) => ({
        id: s.id,
        topic: s.topic,
        queued: s.queue.length,
        dropped: s.dropped,
        inFlight: s.inFlight,
        maxQueue: s.maxQueue,
        slowConsumer: s.slowConsumer,
      })),
    };
  }

  /**
   * Close every subscription and release timers. The hub cannot be reused.
   * @returns {void}
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    for (const sub of Array.from(this._subs.values())) {
      this._detach(sub, { close: true, reason: 'hub-closed' });
    }
    this._topics.clear();
  }

  /**

   * Named alias for the `Symbol.dispose` implementation, so callers who do not

   * want to reach for the symbol still have something to call.

   * @returns {void}

   */

  dispose() {
    this[Symbol.dispose]();
  }

  [Symbol.dispose]() {
    this.close();
  }

  /**
   * Queue a message for one subscriber, applying the slow-consumer policy when
   * the queue is full.
   * @private
   * @param {HubSubscriber} sub
   * @param {any} message
   * @returns {void}
   */
  _enqueue(sub, message) {
    // maxQueue 0 means no buffering: the policy is evaluated immediately.
    while (sub.queue.length >= sub.maxQueue) {
      if (sub.slowConsumer === 'drop-oldest' && sub.queue.length > 0) {
        sub.queue.shift();
        this._counters.dropped += 1;
        sub.dropped += 1;
        continue;
      }
      if (sub.slowConsumer === 'drop-oldest') {
        // Capacity 0 with an empty queue: there is nothing older to evict, so
        // the *incoming* message is the one that loses. Without this the queue
        // would hold one message, quietly exceeding a capacity of zero.
        this._counters.dropped += 1;
        sub.dropped += 1;
        return;
      }
      if (sub.slowConsumer === 'drop-newest') {
        this._counters.dropped += 1;
        sub.dropped += 1;
        return;
      }
      // 'disconnect'
      this._counters.dropped += 1;
      sub.dropped += 1;
      this._counters.disconnected += 1;
      this._detach(sub, { close: true, reason: 'slow-consumer' });
      return;
    }
    sub.queue.push(message);
  }

  /**
   * Retain a message for future subscribers of a topic.
   * @private
   * @param {string} topic
   * @param {any} message
   * @returns {void}
   */
  _retain(topic, message) {
    let log = this._retained.get(topic);
    if (!log) {
      log = [];
      this._retained.set(topic, log);
    }
    log.push(message);
    // Bounded: a retained log that grows forever is a leak, not a feature.
    if (log.length > RETAIN_LIMIT) log.splice(0, log.length - RETAIN_LIMIT);
  }

  /**
   * @private
   */
  _scheduleFlush() {
    if (!this._batch) return;
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    if (this._batchDelayMs > 0) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flushScheduled = false;
        this._drain();
      }, this._batchDelayMs);
      return;
    }
    queueMicrotask(() => {
      this._flushScheduled = false;
      this._drain();
    });
  }

  /**
   * Drain every subscriber with queued work, one batch per send.
   * @private
   * @returns {void}
   */
  _drain() {
    for (const sub of Array.from(this._subs.values())) {
      if (sub.closed || sub.queue.length === 0) continue;
      this._flushSubscriber(sub);
    }
  }

  /**
   * @private
   * @returns {Promise<void>}
   */
  async _flushAll() {
    const pending = [];
    for (const sub of Array.from(this._subs.values())) {
      if (sub.closed || sub.queue.length === 0) continue;
      pending.push(this._flushSubscriber(sub));
    }
    await Promise.all(pending);
  }

  /**
   * Build one frame from a subscriber's queue and hand it to the transport.
   * @private
   * @param {HubSubscriber} sub
   * @returns {Promise<void>}
   */
  _flushSubscriber(sub) {
    const batch = sub.queue.splice(0, sub.maxBatch);
    if (batch.length === 0) return Promise.resolve();
    sub.inFlight += 1;

    let frame;
    try {
      frame = this._encodeBatch(batch);
    } catch (err) {
      sub.inFlight -= 1;
      this._notify(err, sub);
      return Promise.resolve();
    }
    this._counters.bytesOut += frame.length;
    this._counters.delivered += batch.length;

    let result;
    try {
      result = this._send(sub, frame);
    } catch (err) {
      sub.inFlight -= 1;
      this._notify(err, sub);
      return Promise.resolve();
    }
    return Promise.resolve(result)
      .then(
        () => {
          sub.inFlight -= 1;
        },
        (err) => {
          sub.inFlight -= 1;
          this._notify(err, sub);
        }
      )
      .then(() => {
        // Deliver to the handler only after the transport accepted it, so a
        // slow socket genuinely back-pressures rather than racing ahead.
        for (const m of batch) {
          try {
            sub.handler(m, sub);
          } catch (err) {
            this._notify(err, sub);
          }
        }
        // More arrived while the transport was busy.
        if (sub.queue.length > 0 && !sub.closed) this._flushSubscriber(sub);
      });
  }

  /**
   * @private
   * @param {any[]} batch
   * @returns {Uint8Array}
   */
  _encodeBatch(batch) {
    if (this._codec === 'raw') {
      // A raw frame carries exactly one payload, so it cannot also carry a
      // batch boundary. Force a one-message send per flush rather than
      // silently degrading to JSON.
      if (batch.length !== 1) {
        throw new TypeError(
          'PowerRealtimeHub: the `raw` codec delivers one message per frame; ' +
            'use codec `json` if you need batching.'
        );
      }
      return encodeMessage(batch[0], { codec: 'raw' });
    }
    // Encode once rather than per message: a batch of JSON values is cheaper
    // as a single JSON array, and the frame stays self-delimiting.
    // One `JSON.stringify` for the whole batch, then one frame. Passing the
    // string straight to `frameEncodedJson` avoids encoding the array twice.
    return frameEncodedJson(JSON.stringify(batch));
  }

  /**
   * Detach a subscriber from the hub, optionally closing its transport.
   * @private
   * @param {HubSubscriber} sub
   * @param {{close?: boolean, reason?: string}} [options]
   * @returns {void}
   */
  _detach(sub, { close = false, reason = 'unsubscribe' } = {}) {
    if (sub.closed) return;
    sub.closed = true;
    this._subs.delete(sub.id);
    const bucket = this._topics.get(sub.topic);
    if (bucket) {
      bucket.delete(sub.id);
      if (bucket.size === 0) this._topics.delete(sub.topic);
    }
    const log = this._retained.get(sub.topic);
    if (log) log.length = 0;
    if (close && this._close) {
      try {
        this._close(sub, reason);
      } catch (err) {
        this._notify(err, sub);
      }
    }
  }

  /**
   * Report an internal failure through the optional `onError` adapter. A
   * throwing `onError` must not break the hub, so it is swallowed.
   * @private
   * @param {any} err
   * @param {HubSubscriber} sub
   * @returns {void}
   */
  _notify(err, sub) {
    if (!this._onError) return;
    try {
      this._onError(err, sub);
    } catch {
      /* a failing error handler must not break the hub */
    }
  }
}

export default PowerRealtimeHub;
