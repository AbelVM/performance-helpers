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
import { attach, detach } from './metrics.js';
import { PowerPriorityQueue } from './powerPriorityQueue.js';
import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';

/**
 * A subscriber's pending queue, in its two shapes.
 *
 * The hub reads `length`, `push`, `shift` and `splice(0, n)` off a subscriber's
 * queue in five places, and every one of those is ordering-agnostic — so the
 * ordering policy lives entirely behind this surface and `_enqueue`,
 * `_flushSubscriber`, `_queuedSubscribers` and `stats()` never branch on it.
 * That is the point: a policy that leaked into the flush walk would be a policy
 * the two flush paths could disagree about.
 *
 * `fifo` is the default and is a plain array. Zero allocation per message, and
 * the documented `drop-oldest` / `drop-newest` / `disconnect` policies mean
 * exactly what they say.
 *
 * `priority` is backed by {@link PowerPriorityQueue}. It exists because a
 * bounded array with binary-search insertion is O(n) per publish and `maxQueue`
 * is a caller-chosen number, not a small one — a subscriber configured with
 * `maxQueue: 100000` would pay a 100000-element move on every message.
 *
 * @private
 */
class HubQueue {
  /**
   * @param {boolean} priority
   */
  constructor(priority) {
    this._priority = priority;
    /** @type {any[]} */
    this._fifo = priority ? [] : [];
    /** @type {PowerPriorityQueue|null} */
    this._heap = priority ? new PowerPriorityQueue() : null;
  }

  get length() {
    return this._priority ? /** @type {PowerPriorityQueue} */ (this._heap).size : this._fifo.length;
  }

  /**
   * @param {any} message
   * @param {number} [priority] - Ignored in fifo mode, which has no ordering
   *   to apply. The hub rejects a `publish` that supplies one on a hub without
   *   `messagePriority`, so this is unreachable rather than silently dropped.
   */
  push(message, priority = 0) {
    if (this._priority) {
      // Wrapped so the priority travels with the message without requiring the
      // message itself to carry a `priority` field — a caller's payload shape
      // is not the hub's to invent. The wrapper is also what keeps a payload
      // that *does* carry `priority` from being reordered by accident: the heap
      // reads the wrapper's field, never the message's.
      /** @type {PowerPriorityQueue} */ (this._heap).push({ item: message, priority });
      return;
    }
    this._fifo.push(message);
  }

  /**
   * Unwrap one entry taken off the heap.
   *
   * The heap hands back the wrapper `push()` stored, and everything downstream
   * of this class — the handler, the codec, the frame memo's identity key —
   * expects the caller's message. Unwrapping here rather than at each call site
   * is what keeps the ordering policy from leaking into the flush walk.
   * @param {any} entry
   * @returns {any}
   */
  _unwrap(entry) {
    return this._priority ? entry.item : entry;
  }

  shift() {
    if (this._priority) {
      return this._unwrap(/** @type {PowerPriorityQueue} */ (this._heap).shift());
    }
    return this._fifo.shift();
  }

  /**
   * Take up to `count` items off the front, in delivery order.
   *
   * `start` is always `0` at the one call site (`_flushSubscriber`), and saying
   * so is cheaper than implementing a general splice the hub never asks for.
   * @param {number} start
   * @param {number} count
   * @returns {any[]}
   */
  splice(start, count) {
    if (!this._priority) return this._fifo.splice(start, count);
    const heap = /** @type {PowerPriorityQueue} */ (this._heap);
    // Bounded by `size`, not by a sentinel: a legitimate message can *be*
    // `undefined`, and stopping on one would silently truncate the batch.
    const n = Math.min(count, heap.size);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this._unwrap(heap.shift());
    return out;
  }

  /**
   * Discard the item furthest from delivery.
   *
   * In fifo mode that is the head, which is what `drop-oldest` has always
   * meant. In priority mode it is the lowest-priority item — and among equal
   * priorities the most recently queued, because that is the one `shift()`
   * reaches last. The policy name stays true of the *intent* (make room by
   * discarding what is least worth keeping) rather than of the literal
   * insertion order, and the guide says so.
   * @returns {any}
   */
  dropOldest() {
    if (this._priority) {
      return this._unwrap(/** @type {PowerPriorityQueue} */ (this._heap).popLowest());
    }
    return this._fifo.shift();
  }

  clear() {
    if (this._priority) {
      /** @type {PowerPriorityQueue} */ (this._heap).clear();
      return;
    }
    this._fifo.length = 0;
  }
}

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
 * @property {HubQueue} queue
 *   Bounded buffer for this subscriber. A {@link HubQueue} - the hub reads
 *   `.length`, `.push`, `.shift` and `.splice` off it, so a queue typed as an
 *   abstract buffer (the previous declaration) had no `.length` at any of the
 *   five places that check it before enqueueing. It is a plain array in fifo
 *   mode and a `PowerPriorityQueue` behind that surface in priority mode, which
 *   is why the ordering policy never reaches the flush walk.
 * @property {number} dropped - Messages discarded by the slow-consumer policy.
 * @property {number} bytesSent - Bytes of framed payload handed to this
 *   subscriber's transport so far. Exact, and free: the frame was built for this
 *   flush anyway, so this is one addition against an already-computed
 *   `frame.length`. It is **not** a count of what is sitting in `queue` — see
 *   {@link HubSubscriberStat.bytesSent}.
 * @property {number} inFlight - Sends currently awaiting the transport.
 * @property {Promise<void>|null} [_inflightChain] - The promise for the send
 *   currently in flight, **including any follow-up flush it chained**, so
 *   `flush()` can wait for a subscriber's queue to actually empty rather than
 *   for one frame.
 * @property {number} maxQueue
 * @property {number} maxBatch
 * @property {SlowConsumerPolicy} slowConsumer
 * @property {boolean} closed
 * @property {number} priority - Drain order. Higher numbers are delivered
 * first; `0` is the default and is indistinguishable from a subscriber that
 * asked for `0`, so the common case stays a stable insertion-order walk.
 * @property {((arg0: number, arg1: HubSubscriber) => void)|null} [bytesAcknowledged] -
 *   **WT-004.** The callback the caller supplied at subscribe time, or
 *   `null` when none was supplied — which is the normal case, because the
 *   hub's own `bytesSent` is the floor and needs no callback. Invoked
 *   after the transport has taken the frame, in the same statement that
 *   increments `bytesSent`, so the two move together.
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
 * @property {number} [priority=0] - Drain order. Higher numbers are delivered
 * first within a topic on the next flush; `0` is the default and is
 * indistinguishable from a subscriber that asked for `0`, so the common
 * case stays a stable insertion-order walk. A non-finite value is rejected
 * at subscribe time, because it would coerce to `NaN` and sort to an
 * arbitrary position silently.
 * @property {((arg0: number, arg1: HubSubscriber) => void)|null} [bytesAcknowledged] -
 *   **WT-004.** Optional callback reporting bytes the transport has
 *   *acknowledged* for this subscriber, as opposed to bytes the hub handed
 *   over. Transport-reported per stream, so on HTTP/2 it matches the hub's
 *   own `bytesSent`; on transports that do not report it the callback is
 *   simply not supplied and the hub keeps `bytesSent` as the floor. Invoked
 *   after the transport has taken the frame, in the same statement that
 *   increments `bytesSent`, so the two move together. The hub does not
 *   validate the number the callback reports — it is the caller's transport,
 *   and the hub's job is to call it, not to audit it.
 * @property {*} [transport] - Carried through to the stored
 * {@link HubSubscriber} untouched, for the caller's own `send`/`close`
 * adapters to use.
 */

/**
 * One entry of the per-subscriber array in {@link PowerRealtimeHub#stats}.
 * @typedef {object} HubSubscriberStat
 * @property {string} id
 * @property {string} topic
 * @property {number} queued - Messages waiting for this subscriber right now.
 * @property {number} dropped
 * @property {number} bytesSent - Bytes handed to this subscriber's transport so
 *   far. **This is the per-subscriber share of `stats().bytesOut`, and the two
 *   reconcile exactly:** the hub adds `frame.length` to both in the same
 *   statement, so `bytesOut === Σ list[].bytesSent` for any set of subscribers
 *   still attached. RT-026 replaced a field called `bytesQueued` here that was
 *   initialised to `0` and never written, which made it the second
 *   permanently-zero advertisement in a class whose entire job is to let a
 *   caller see how far behind a subscriber is. The reconcilable pair is what
 *   makes this one real; a counter nothing can check is decoration.
 * @property {number} inFlight
 * @property {number} maxQueue
 * @property {SlowConsumerPolicy} slowConsumer
 * @property {number} priority - Drain order, so a caller reading `stats().list`
 *   can see *why* a subscriber was served before another rather than guessing
 *   from `queued`/`inFlight`. Reflected from the stored subscriber, not
 *   re-derived: it is a value the caller supplied, so reporting it back is the
 *   honest thing and recomputing it would be inventing a value.
 */

/**
 * @typedef {object} HubStats
 * @property {number} subscribers - Current live subscription count.
 * @property {number} topics - Number of topics with at least one subscriber.
 * @property {number} published - Total messages accepted by `publish`.
 * @property {number} delivered - Total messages handed to a `send` adapter.
 * @property {number} dropped - Total messages discarded by a policy.
 * @property {number} rateLimited - Total messages dropped by the rate limiter.
 * @property {number} disconnected - Subscribers closed for falling behind.
 * @property {number} bytesOut - Approximate bytes handed to the adapter.
 */

/**
 * @typedef {object} HubOptions
 * @property {function(object, Uint8Array):(void|Promise<void>)} send - Required
 *   transport adapter, called as `send(subscriber, frame)`. Return a promise if
 *   the transport is async; the hub tracks in-flight sends per subscriber.
 *
 *   **The `frame` is shared and must be treated as read-only.** RT-006 encodes one
 *   frame per `(topic, batch)` and hands the same buffer to every subscriber on
 *   the topic, so a transport that writes into `frame` corrupts every other
 *   subscriber's message. Copy it if the transport needs to own it.
 *   `stats().encoded` makes a violation visible: it counts real encodes, so it
 *   stays at one per flush however many subscribers the topic has.
 * @property {boolean|(import('./metrics.js').MetricsCollector)} [observability] - Opt in to
 *   metrics: `true` registers this helper in the shared collector, or pass a
 *   collector of your own. Off by default, so the common case allocates nothing.
 *   See `guides/metrics.md`.
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
 * @property {import('./jsdoc-types.js').RateLimiterLike} [rateLimit] - Optional
 *   per-topic rate limiter. When set, `publish()` calls `tryConsume(1, { context:
 *   { topic } })` before enqueuing; a `false` return drops the message for that
 *   topic and increments `stats().rateLimited`. Composes with any helper that
 *   satisfies {@link RateLimiterLike} — `PowerThrottle`, `PowerGCRA`,
 *   `PowerRateLimit` with `keyFn`, etc.
 * @property {boolean} [messagePriority=false] - Order each subscriber's queue
 *   by the `priority` passed to `publish()` rather than by arrival. Off by
 *   default, so the common case stays a plain array with FIFO delivery and pays
 *   nothing. When on, every subscriber's queue is a `PowerPriorityQueue`, and
 *   `publish(topic, message, { priority })` is accepted — passing `priority` on
 *   a hub without this option throws, because a silently ignored ordering is
 *   the misspelled-option failure this library refuses to have.
 *
 *   This is **message** priority and is independent of the per-subscriber
 *   `priority` drain order: the first decides which message a subscriber
 *   receives next, the second decides which subscriber is served first.
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
   * Validate a `priority` value supplied to {@link subscribe}.
   *
   * Extracted from `subscribe` because that method was already at the
   * cyclomatic-complexity ceiling and this check is its own branch — and
   * because the rule it enforces is worth stating once rather than inline.
   *
   * `priority` is a drain order, and the failure mode it guards against is
   * specifically the silent one: a non-finite value coerces to `NaN`, which
   * compares unequal to everything, so `Array.sort` lands the subscriber in an
   * arbitrary position without throwing. The caller would get a wrong-order
   * delivery with no error, months after the subscribe that accepted it.
   *
   * @param {*} priority
   * @returns {number} A finite number. `0` when the caller omitted it.
   * @throws {TypeError} When `Number(priority)` is not finite.
   * @static
   */
  static _validatePriority(priority) {
    const n = Number(priority);
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `PowerRealtimeHub: \`priority\` must be a finite number (got ${String(priority)})`
      );
    }
    return n;
  }

  /**
   * Validate a `bytesAcknowledged` callback supplied to {@link subscribe}.
   *
   * WT-004. `bytesAcknowledged` is transport-reported per stream and is a
   * strictly better figure than the hub's own `bytesSent` when the connection
   * is over HTTP/2 — it counts bytes the peer has actually acknowledged, not
   * bytes handed to the adapter. But it is **not** a replacement: it is only
   * available on transports that report it, and on others it is absent. So the
   * hub keeps `bytesSent` as the floor and exposes this as an **optional**
   * callback the caller wires up at subscribe time.
   *
   * The shape is a function rather than a number, because the value moves:
   * a number captured at subscribe time would be stale by the next flush.
   * The callback is invoked **after** the transport has taken the frame, in the
   * same place `bytesSent` is incremented, so the two move together.
   *
   * @param {*} fn
   * @returns {((arg0: number, arg1: HubSubscriber) => void)|null} The callback, or `null`
   *   when the caller supplied `null` or `undefined` — both are the "not
   *   supplied" sentinel, and the field is typed `function | null` so a caller
   *   passing `null` explicitly gets the no-op rather than an error.
   * @throws {TypeError} When `fn` is not a function and not `null`.
   * @static
   */
  static _validateAcknowledged(fn) {
    // `null` is the explicit "not supplied" sentinel. It is accepted alongside
    // `undefined` because the field is typed `function | null` and a caller
    // passing `null` should get the no-op, not a TypeError. Anything else
    // that is not a function is a caller error: it would be invoked after
    // every flush and would throw, turning a routine delivery into an
    // unhandled rejection.
    if (fn === null || fn === undefined) return null;
    if (typeof fn !== 'function') {
      throw new TypeError(
        'PowerRealtimeHub: `bytesAcknowledged` must be a function or null (got ' + String(fn) + ')'
      );
    }
    return fn;
  }

  /**
   * @param {HubOptions} options - `send` is required; the constructor throws
   * without it, so the parameter is not defaulted.
   */
  constructor(options) {
    assertKnownOptions(
      options,
      [
        'send',
        'observability',
        'close',
        'batch',
        'batchDelayMs',
        'codec',
        'onError',
        'rateLimit',
        'messagePriority',
      ],
      'PowerRealtimeHub'
    );
    const {
      send,
      close,
      batch = true,
      batchDelayMs = 0,
      codec = 'json',
      onError,
      rateLimit,
      messagePriority = false,
    } = options || {};

    if (typeof send !== 'function') {
      throw new TypeError('PowerRealtimeHub: a `send(subscriber, frame)` adapter is required');
    }
    if (codec !== 'json' && codec !== 'raw') {
      throw new TypeError("PowerRealtimeHub: `codec` must be 'json' or 'raw'");
    }
    // `codec: 'raw'` is legal here — it works, and `maxBatch: 1` is the one
    // configuration the hub can honour — but it is incompatible with *batching*,
    // and the constructor is not where that can be checked: `maxBatch` is a
    // per-subscriber option and the hub's default is 32, so the only place both
    // facts are known is `subscribe()`. The check lives there, where it can name
    // the subscriber that got it wrong.

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
    // RT-001: message-level ordering, off by default. Stored as a boolean rather
    // than read from `options` at enqueue time because the queue shape is chosen
    // once per subscriber in `subscribe()`, and a hub that changed its mind
    // midway would leave two subscribers with incompatible queue types.
    this._messagePriority = messagePriority === true;
    this._onError = typeof onError === 'function' ? onError : null;
    // RT-026: `options.now` is gone. It was documented as "Clock override, for
    // tests", accepted by `assertKnownOptions`, destructured, stored on
    // `this._now` — and never called by anything, because no code path in this
    // class measures elapsed time: the slow-consumer policy is driven by
    // `queue.length` against `maxQueue`, and every counter is an event count
    // rather than a duration. So an injected clock had nothing to drive, which
    // made it worse than an undocumented leftover: `assertKnownOptions` accepts
    // it, the guide's option list is generated from the typedef, and a caller
    // who passed `now` got a silent no-op instead of a complaint. Deleted
    // rather than wired up, because the honest fix is the smaller one — no
    // measurement here needs a clock, and inventing one to justify an existing
    // parameter is how an option stays dead for another release.

    /** @type {Map<string, Map<string, HubSubscriber>>} topic -> subscriberId -> sub */
    this._topics = new Map();
    /** @type {Map<string, HubSubscriber>} subscriberId -> sub */
    this._subs = new Map();
    /** @type {Map<string, any[]>} topic -> retained messages (bounded) */
    this._retained = new Map();
    /** @type {import('./powerRateLimit.js').PowerRateLimit|null} */
    this._rateLimit = null;
    this._flushScheduled = false;
    this._flushTimer = null;
    this._closed = false;

    this._counters = {
      published: 0,
      delivered: 0,
      dropped: 0,
      disconnected: 0,
      bytesOut: 0,
      encoded: 0,
      rateLimited: 0,
    };
    // RT-006: one encoded frame per `(topic, batch)` instead of one per
    // subscriber. The memo is a **single entry**, which is the right shape for the
    // fan-out loop rather than a general cache: `_drain` walks the subscribers of
    // a topic consecutively, so consecutive calls carry the same batch and a
    // one-slot memo hits on every one of them. A `Map` would cost a string or a
    // nested lookup per subscriber to hold the key, which is the cost this change
    // exists to remove.
    //
    // The key is `(length, first, last)` of the batch, compared **by identity**,
    // and it is sound because of a subset invariant over how a queue is filled:
    // `_enqueue` pushes the *same message object* into every subscriber of a
    // topic, and eviction removes the current worst entry, so at every moment the
    // smaller-budget subscriber's queue is a **subset** of the larger-budget
    // one's. Both queues are totally ordered by the same comparator, so a
    // subsequence of the same length is the same sequence — which makes `length`
    // alone sufficient, and the two ends a cheap confirmation of it.
    //
    // That invariant is **mode-independent**, and saying so matters: RT-001 added
    // `messagePriority`, under which `drop-oldest` no longer removes from the
    // front but from the middle. The original justification here ("`drop-oldest`
    // removes only from the front") stopped being true at that point, and a
    // comment whose stated reason has expired is worse than one that was never
    // written — the next reader would either trust it or "fix" a memo that is
    // sound. The subset argument holds in both modes because evicting the worst
    // of a subset evicts something the superset also considers worst-or-worse.
    // Verified by brute force over the priority space and by
    // `test/powerRealtimeHub.messagePriority.test.js`, which drives two
    // subscribers with different `maxQueue` through the real flush path.
    //
    // This is an identity check, not a value comparison, so a caller publishing
    // the same value twice gets two encodes, which is correct: nothing has to
    // assume the contents were compared.
    //
    // The memo holds a frame that several subscribers are handed, so **the frame
    // is shared and must be treated as read-only by the transport.** A `send`
    // adapter that mutates the buffer corrupts every other subscriber. That is
    // documented on the `send` option and is the one contract this change adds.
    // `stats().encoded` exists so a violation is visible: if it ever exceeds the
    // number of flushes, a caller is mutating frames or the memo is missing hits.
    this._frameMemo = null;
    this._frameMemoLength = -1;
    this._frameMemoFirst = null;
    this._frameMemoLast = null;
    // RT-003: optional per-topic rate limiter. Composes with any helper that
    // satisfies `RateLimiterLike`; the hub calls `tryConsume(1, { context:
    //   { topic } })` in `publish()` and drops the message when it returns `false`.
    this._rateLimit = rateLimit ?? null;
    // FEAT-007: opt-in metrics. Off by default, so the common case pays nothing and allocates no closure.
    this._metrics = attach(this, 'hub', options);
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
    const {
      maxQueue = 64,
      slowConsumer = 'drop-oldest',
      maxBatch = 32,
      id,
      priority: rawPriority,
      bytesAcknowledged: rawAcknowledged,
    } = options || {};
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
    // WT-005: `priority` is a drain order, not a name. A non-finite value
    // coerces to `NaN`, which compares unequal to everything, so `Array.sort`
    // lands the subscriber in an arbitrary position without throwing — a
    // wrong-order delivery with no error, months after the subscribe that
    // accepted it. Extracted to `_validatePriority` because this method was
    // already at the cyclomatic-complexity ceiling and the check is its own
    // branch. Omitting `priority` yields `0`, which is the default and is
    // indistinguishable from a subscriber that asked for `0`.
    const validatedPriority =
      rawPriority === undefined ? 0 : PowerRealtimeHub._validatePriority(rawPriority);
    // WT-004: `bytesAcknowledged` is optional. Omitting it (or passing `null`)
    // is the normal case — the hub keeps its own `bytesSent` as the floor and
    // nothing else is needed. Supplying a non-function is a caller error: it
    // would be called after every flush and would throw, turning a routine
    // delivery into an unhandled rejection. Validate at subscribe time so
    // the failure is loud and attributable. `_validateAcknowledged` accepts
    // `null`/`undefined` itself, so the sentinel does not need handling here.
    const validatedAcknowledged = PowerRealtimeHub._validateAcknowledged(rawAcknowledged);
    // **The `raw` codec check lives here, and this is the only place it can.**
    // `_flushSubscriber` splices the batch off `sub.queue` *before* `_encodeBatch`
    // throws "the `raw` codec delivers one message per frame", so the messages
    // it had taken were gone: discarded, never sent, never re-queued. Two
    // `publish` calls in one microtask is the default `batch: true` path, and it
    // lost all of them — measured `published: 2, delivered: 0, dropped: 0`, with
    // no counter moving because `dropped` only increments in `_enqueue`, which
    // never saw them. `rg 'codec' test/powerRealtimeHub.test.js` returned
    // nothing, so the codec had no test on the hub at all.
    //
    // Rejecting here rather than at construction because `maxBatch` is
    // per-subscriber: `raw` is legal, `maxBatch: 1` is the configuration the hub
    // can honour, and this is the only place both facts are visible. Note that
    // `batch: false` does **not** rescue it — the splice is unconditional, so a
    // queue that accumulated two messages while unbatched still yields a
    // two-message batch.
    if (this._codec === 'raw' && Math.floor(Number(maxBatch)) > 1) {
      throw new TypeError(
        'PowerRealtimeHub: `codec: "raw"` delivers one message per frame, so a ' +
          'subscriber must use `maxBatch: 1`. Use codec "json" if you need batching.'
      );
    }

    /** @type {HubSubscriber} */
    const sub = {
      id: id ?? `sub-${++_nextSubId}`,
      topic,
      handler,
      maxQueue: Math.floor(Number(maxQueue)),
      slowConsumer,
      maxBatch: Math.floor(Number(maxBatch)),
      // WT-005: drain order. `0` is the default — a subscriber that did not
      // ask for priority is indistinguishable from one that asked for `0`,
      // which is what keeps the common case a stable insertion-order walk.
      priority: validatedPriority,
      // WT-004: transport-reported acknowledged bytes. `null` when the caller
      // did not supply a callback, which is the normal case — the hub's own
      // `bytesSent` is the floor and needs no callback. Stored on the
      // subscriber rather than read from `options` at flush time because the
      // callback is per-subscriber and the flush walk already has the sub.
      bytesAcknowledged: validatedAcknowledged,
      // RT-001: the queue shape is chosen here, once, from the hub-level flag.
      // A per-subscriber override was considered and rejected: two subscribers
      // on one topic with different queue types would make the frame memo's
      // identity key unsound, because `drop-oldest` removes from a different end
      // in each and two batches could then agree on `(length, first, last)`
      // without being the same batch.
      queue: new HubQueue(this._messagePriority),
      inFlight: 0,
      /** @type {?Promise<void>} */
      _inflightChain: null,
      bytesSent: 0,
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

    // **Replay the retained log.** `publish(topic, msg, { retain: true })` writes
    // to `this._retained`, and until now nothing read it: the map was consulted
    // in exactly two places, its own write path and `_detach`. So a subscriber
    // arriving after a retained publish got `[]`, while the JSDoc said "keep the
    // message for a subscriber that subscribes later" and `guides/powerRealtimeHub.md`
    // said it "keeps the message for later subscribers". Neither happened.
    //
    // Through `_enqueue`, not a second private delivery path, so a full queue,
    // a `raw` codec and every slow-consumer policy apply to a replay exactly as
    // they do to a live message. Deliberately **not** through `publish()`: a
    // replay is not a publication, and routing it there would inflate the
    // `published` counter by the length of every retained log on every new
    // subscriber — a number that is supposed to answer "how much did callers
    // send". A caller who retained 32 messages would see `published` jump by 32
    // per subscribe, which is precisely the kind of counter that makes the rest
    // of `stats()` untrustworthy.
    const retained = this._retained.get(topic);
    if (retained && retained.length > 0) {
      for (const message of retained) this._enqueue(sub, message);
      this._scheduleFlush();
    }

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
   * @param {number} [options.priority] - Delivery order within each subscriber's
   *   queue, higher first. Requires the hub's `messagePriority` option; passing
   *   it without that throws, because an ordering that is silently ignored is
   *   the misspelled-option failure this library refuses to have. Omitted means
   *   `0`, which is indistinguishable from an explicit `0` — the same rule the
   *   per-subscriber `priority` drain order follows.
   * @returns {number} The number of subscribers the message was queued for.
   */
  publish(topic, message, options = {}) {
    if (this._closed) return 0;
    // RT-001: validated here rather than at the call site's convenience, because
    // the two failure modes are both silent without it. A misspelled option
    // (`prioroty`) would be ignored, and a `priority` on a hub without
    // `messagePriority` would order nothing at all — the caller would believe
    // they had asked for priority and get FIFO.
    assertKnownOptions(options, ['retain', 'priority'], 'PowerRealtimeHub.publish');
    const priority =
      options?.priority === undefined ? 0 : PowerRealtimeHub._validatePriority(options.priority);
    if (options?.priority !== undefined && !this._messagePriority) {
      throw new TypeError(
        'PowerRealtimeHub: `publish({ priority })` requires the hub option ' +
          "`messagePriority: true`. Without it every subscriber's queue is FIFO, so the " +
          'priority you passed would order nothing.'
      );
    }
    const bucket = this._topics.get(topic);
    this._counters.published += 1;
    // **Retain before the early return.** This used to sit below it, so
    // `publish(topic, msg, { retain: true })` retained nothing whenever the topic
    // had no live subscriber — which is *the* case retain exists for. "Keep the
    // message for a subscriber that subscribes later" describes publishing before
    // anyone is listening, and that is exactly what silently did nothing.
    // Verified: 50 retained publishes to a topic with no subscribers left
    // `_retained` empty. The ordering is safe because `_retain` is a private map
    // write with no dependency on `bucket`.
    if (options?.retain) this._retain(topic, message);
    if (!bucket || bucket.size === 0) return 0;
    // RT-003: per-topic rate limiting. Check before enqueuing so a noisy
    // publisher cannot fan out to N subscribers when the topic is over budget.
    if (this._rateLimit) {
      const outcome = this._rateLimit.tryConsume(1, { context: { topic } });
      if (!outcome) {
        this._counters.rateLimited += 1;
        return 0;
      }
    }

    let queued = 0;
    for (const sub of bucket.values()) {
      if (sub.closed) continue;
      this._enqueue(sub, message, priority);
      queued += 1;
    }
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
    // **`_flushScheduled` has to be cleared here, not only in the callbacks.**
    // It was the other two places — the timer callback and the microtask — and
    // clearing the timer removed the first, so on a hub with `batchDelayMs > 0`
    // the flag stayed `true` for the life of the object. Every later `publish`
    // then short-circuited at `_scheduleFlush`, and the hub stopped flushing
    // permanently: measured, publish / `flush()` / publish / wait 100 ms sent
    // **0 frames** with `published: 2, delivered: 1, dropped: 0`.
    //
    // The counters are what make that worth writing down. `published` keeps
    // climbing, so a dashboard shows a live publisher; `delivered` froze; and
    // `dropped` never moves, because the slow-consumer policy only runs in
    // `_enqueue` and the message never reached a full queue — it reached a dead
    // scheduler. Both counters a guide tells you to alert on report nothing.
    this._flushScheduled = false;
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
        bytesSent: s.bytesSent,
        inFlight: s.inFlight,
        maxQueue: s.maxQueue,
        slowConsumer: s.slowConsumer,
        priority: s.priority,
      })),
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
   * Close every subscription and release timers. The hub cannot be reused.
   * @returns {void}
   */
  close() {
    detach(this._metrics);
    this._metrics = null;
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
    // `_detach` now only empties a topic's retained log when it was the **last**
    // subscriber on that topic, so a `close()` has to clear the rest itself —
    // otherwise a topic whose subscribers were all detached in a different order
    // keeps its retained messages alive after the hub is closed.
    this._retained.clear();
  }

  /**

   * Named alias for the `Symbol.dispose` implementation, so callers who do not

   * want to reach for the symbol still have something to call.

   * @returns {void}

   */

  dispose() {
    // Delegates rather than detaching first. `close()` already unregisters the
    // metrics receipt at its head, so detaching here as well was a second
    // `detach(null)` — harmless, because `detach` is null-safe, but it is the
    // kind of duplication that drifts: the day `close()` stops detaching, this
    // copy would keep the hub registered and sampled forever.
    this.close();
  }

  [Symbol.dispose]() {
    this.close();
  }

  /**
   * Asynchronous disposal hook: **flush what is pending, then close.**
   *
   * This is the graceful half of the pair, and it exists because `close()` is not
   * graceful — it clears the pending batch along with everything else. A hub
   * configured with `batchDelayMs > 0` can be holding frames that have been
   * `publish`ed but not yet sent, and `using` at scope exit would drop them. So
   * `await using` gets the frames out first.
   *
   * Deliberately the same shape as `PowerPool`'s: drain, swallow drain failures,
   * then tear down. The swallowing is not carelessness — a `finally` in a
   * disposal path must leave the instance closed even if the flush fails, and
   * leaving it open would be worse than losing the flush.
   *
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    try {
      if (!this._closed) await this.flush();
    } catch (err) {
      // ignore flush failures and close anyway
    }
    this.close();
  }

  /**
   * Queue a message for one subscriber, applying the slow-consumer policy when
   * the queue is full.
   * @private
   * @param {HubSubscriber} sub
   * @param {any} message
   * @param {number} [priority] - Message ordering, higher first. Ignored unless
   *   the hub was built with `messagePriority`; `publish()` refuses to supply one
   *   on a hub that is not, so this is unreachable rather than silently dropped.
   * @returns {void}
   */
  _enqueue(sub, message, priority = 0) {
    // maxQueue 0 means no buffering: the policy is evaluated immediately.
    while (sub.queue.length >= sub.maxQueue) {
      if (sub.slowConsumer === 'drop-oldest' && sub.queue.length > 0) {
        // RT-001: `dropOldest()`, not `shift()`. In fifo mode they are the same
        // call. In priority mode `shift()` would discard the *best* queued
        // message — the one the ordering existed to protect — so the eviction
        // has to come off the other end.
        sub.queue.dropOldest();
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
    sub.queue.push(message, priority);
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
   * Subscribers with queued work, highest priority first, ties broken by
   * insertion order.
   *
   * Extracted rather than inlined in `_drain` because `flush()` walks the same
   * set through `_flushAll`, and a priority that only applied to the
   * microtask path would be invisible to the caller-driven path — the two
   * would disagree about who gets served first, which is exactly the kind of
   * divergence a row like this exists to prevent.
   *
   * The sort is stable in every engine this package supports, so subscribers
   * at equal priority keep the order they were subscribed in.
   * @private
   * @returns {HubSubscriber[]}
   */
  _queuedSubscribers() {
    const subs = Array.from(this._subs.values());
    subs.sort((a, b) => b.priority - a.priority);
    return subs.filter((sub) => !sub.closed && sub.queue.length > 0);
  }

  /**
   * Drain every subscriber with queued work, one batch per send.
   *
   * Subscribers are visited **highest priority first**, and ties fall back to
   * insertion order. A subscriber with nothing queued is skipped, so the walk
   * is O(subscribers) rather than a sort over the whole set — but the relative
   * order of two subscribers that *both* have queued work is decided by
   * priority, which is the only ordering this method is asked to guarantee.
   * @private
   * @returns {void}
   */
  _drain() {
    for (const sub of this._queuedSubscribers()) {
      // One frame in flight per subscriber. Without this a second drain started
      // a second send while the first was still awaiting the transport, so two
      // frames for the same subscriber were outstanding at once and could reach
      // it in either order — while `stats().list` reported an `inFlight` number
      // that gated nothing. `_flushSubscriber`'s own completion re-drains when
      // work arrived meanwhile, so skipping here cannot strand the queue.
      if (sub.inFlight > 0) continue;
      this._flushSubscriber(sub);
    }
  }

  /**
   * @private
   * @returns {Promise<void>}
   */
  async _flushAll() {
    // Not the same gate as `_drain`, and the difference is the whole point.
    // `flush()` promises "resolves once all subscribers have been drained", and
    // the guide says `batch: false` is for "transports that cannot take several
    // frames at once" — so a subscriber with a send already outstanding must be
    // **waited for**, not skipped. Skipping it would return from `flush()` with
    // that subscriber's queue undelivered, which is precisely the case the option
    // exists to serve.
    const pending = [];
    for (const sub of this._queuedSubscribers()) {
      pending.push(this._drainSubscriberFully(sub));
    }
    await Promise.all(pending);
  }

  /**
   * Deliver everything queued for one subscriber, waiting out any send already
   * in flight, so the frames reach the transport one at a time and in order.
   *
   * Each turn either empties the queue or advances an outstanding send, and the
   * queue is bounded by `maxQueue`, so this terminates.
   *
   * @param {HubSubscriber} sub
   * @returns {Promise<void>}
   * @private
   */
  async _drainSubscriberFully(sub) {
    while (!sub.closed && (sub.queue.length > 0 || sub.inFlight > 0)) {
      if (sub.inFlight > 0) {
        // Wait for the outstanding send *and* any follow-up it chained. The
        // chain includes the recursive flush, so one await covers both.
        await sub._inflightChain;
        continue;
      }
      await this._flushSubscriber(sub);
    }
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
      // **Count it, rather than losing it silently.** The batch was spliced off
      // `sub.queue` above, so returning here discarded every message in it — and
      // no counter moved, because `dropped` only increments in `_enqueue`, which
      // never saw these messages, and `delivered` is incremented after the
      // encode succeeds. Measured under the `raw` codec: `published: 2,
      // delivered: 0, dropped: 0` for two messages that a caller published and
      // the transport never saw.
      //
      // **Re-queuing was tried first and is wrong.** An encode failure here is
      // permanent — the same payload will fail the same way on every retry — so
      // putting the batch back makes `_drainSubscriberFully`'s
      // `while (queue.length > 0)` loop spin forever and `flush()` never
      // resolves. Measured: the re-queue version hangs the flush. A message that
      // cannot be encoded cannot be delivered, so the honest outcome is to
      // deliver it to neither the transport nor the handler and say so in the
      // counters.
      this._counters.dropped += batch.length;
      sub.dropped += batch.length;
      sub.inFlight -= 1;
      this._notify(err, sub);
      return Promise.resolve();
    }
    this._counters.delivered += batch.length;

    let result;
    try {
      result = this._send(sub, frame);
    } catch (err) {
      sub.inFlight -= 1;
      this._notify(err, sub);
      return Promise.resolve();
    }
    // RT-026: the byte counters move **after** the adapter has taken the frame,
    // not before, so "bytes sent" means the transport accepted them. Placing them
    // ahead of the `try` counted a frame whose `send()` threw — bytes attributed
    // to a transport that never received them, in both the per-subscriber field
    // and the global one. A *rejected* promise still counts, correctly: the
    // adapter did take the frame, and the rejection is about what happens next.
    //
    // **The deliberate divergence from `delivered`,** which is *not* moved and
    // still counts a `send()` that threw. That is pre-existing behaviour and this
    // row does not widen to change it, so under a throwing adapter the two
    // numbers differ: `delivered` 1 with `bytesSent` 0. Recorded as a quirk and
    // pinned by a test rather than left to be found later as an inconsistency —
    // `delivered` counts messages *offered*, `bytesSent` counts bytes *taken*.
    //
    // RT-006 encodes one frame per `(topic, batch)` and hands the *same* buffer
    // to every subscriber on the topic, so `frame.length` is the exact byte count
    // for each of them — which is what makes the per-subscriber half of this
    // pair free. The two counters are incremented in one statement on purpose:
    // `stats().bytesOut === Σ stats().list[].bytesSent` is then true by
    // construction rather than by coincidence, and that identity is what makes
    // `bytesSent` a measurement instead of a second permanently-zero field
    // (it replaced `bytesQueued`, which was initialised to 0 and never written).
    sub.bytesSent += frame.length;
    this._counters.bytesOut += frame.length;
    // WT-004: if the caller wired up a `bytesAcknowledged` callback, it is
    // invoked **here**, in the same statement, so it reports the same frame
    // the hub just handed over. The hub does not validate the number the
    // callback reports — that is the caller's transport, and the hub's job is
    // to call it, not to audit it. A callback that throws is reported through
    // `onError` rather than taking the subscriber down, because a bad
    // accounting callback must not become a delivery failure.
    if (sub.bytesAcknowledged) {
      try {
        sub.bytesAcknowledged(frame.length, sub);
      } catch (err) {
        this._notify(err, sub);
      }
    }

    const chain = Promise.resolve(result)
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
        if (sub.queue.length > 0 && !sub.closed) {
          // **Returned**, not fired and forgotten. `flush()` has to be able to
          // await this subscriber to empty, and it reaches the tail of the work
          // through this chain — a send started but not awaited would resolve
          // `flush()` one frame early, which is the bug RT-007 is about in the
          // place it is hardest to notice.
          return this._flushSubscriber(sub);
        }
        return undefined;
      });
    // The whole chain for this subscriber, including any follow-up flushes, so
    // `_flushAll` can wait for the queue to actually empty.
    sub._inflightChain = chain;
    return chain;
  }

  /**
   * @private
   * @param {any[]} batch
   * @returns {Uint8Array}
   */
  _encodeBatch(batch) {
    if (this._codec === 'raw') {
      // A raw frame carries exactly one payload, so it cannot also carry a
      // batch boundary. The batch is spliced off `sub.queue` **before** this
      // runs, so throwing here used to discard every message in it: two
      // `publish` calls in one microtask is the default `batch: true` path, and
      // it lost all of them with `published: 2, delivered: 0, dropped: 0` — no
      // counter moves, because the slow-consumer policy never saw them either.
      // The constructor now rejects this configuration outright, so reaching the
      // throw means the subscriber's own `maxBatch` slipped past it.
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
    //
    // **RT-006: the memo is checked before the stringify, not after.** Keying on
    // the batch contents would mean paying `JSON.stringify` per subscriber to
    // save the `frameEncodedJson` per subscriber — and the stringify was measured
    // as the larger of the two. The key is the batch's identity triple instead;
    // see the constructor for why that is sound.
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (
      this._frameMemo !== null &&
      this._frameMemoLength === batch.length &&
      this._frameMemoFirst === first &&
      this._frameMemoLast === last
    ) {
      return this._frameMemo;
    }
    const frame = frameEncodedJson(JSON.stringify(batch));
    this._counters.encoded += 1;
    this._frameMemo = frame;
    this._frameMemoLength = batch.length;
    this._frameMemoFirst = first;
    this._frameMemoLast = last;
    return frame;
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
    // **Only when the topic has no subscribers left.** The log is per *topic*
    // and this detach is per *subscriber*, so clearing it unconditionally meant
    // one subscriber leaving destroyed the retained history that every other
    // live subscriber on that topic still depended on. Measured: with `sub-2`
    // still subscribed, unsubscribing `sub-1` emptied the log.
    //
    // The ordering matters and is not incidental — `this._subs.delete(sub.id)`
    // and the `_topics` cleanup above have already run, so `bucket.size === 0`
    // here means "this really was the last subscriber for this topic". That is
    // also what stops `close()` leaving `_retained` populated for every topic
    // whose subscribers were never detached.
    if (log && !this._topics.has(sub.topic)) log.length = 0;
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
