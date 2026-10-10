import { isNativeEnvelope, decodeInbound } from './powerMessageCodec.js';
import { assertKnownOptions } from '../utils/options.js';

/**
 * @typedef {Object} PowerBroadcastBusOptions
 * @property {BroadcastChannel} channel - The BroadcastChannel to use.
 * @property {number} [ackTimeoutMs=5000] - Timeout in milliseconds for acks.
 * @property {(receiverId: string) => void} [onSlowConsumer] - Called when a
 *   receiver is marked as slow. The hub passes a callback that sets
 *   `sub.slowConsumer = true`; the bus itself never touches subscriber records.
 */

/**
 * @typedef {Object} PendingAck
 * @property {number} seq
 * @property {string} receiverId
 * @property {ReturnType<typeof setTimeout>} timer
 */

/**
 * One decoder for every ack, created on first use.
 *
 * AUD-020. The ack path used to do `new TextDecoder().decode(...)` **per ack**.
 * A `TextDecoder` is not free to construct — it allocates the decode state and,
 * on the first construction in a process, the implementation's own tables — and
 * an ack arrives once per frame per receiver, so this sat directly on the
 * bus's hottest path for no reason a caller could observe.
 *
 * Lazy rather than a module-level `new TextDecoder()` because the global is
 * absent from some environments this library still supports, and a top-level
 * construction would throw at *import* time for a caller who never sends a
 * frame. `powerBuffer.getDecoder()` caches the same way, including the "there is
 * none" answer.
 *
 * @type {TextDecoder|null|undefined}
 */
let _ackDecoder;

/** @returns {TextDecoder|null} */
function getAckDecoder() {
  if (_ackDecoder !== undefined) return _ackDecoder;
  _ackDecoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
  return _ackDecoder;
}

/**
 * Creates a BroadcastChannel bus with per-frame ack, pending counter with
 * timeout, and slow-consumer detection.
 *
 * The bus assigns a sequence number to every frame it posts, tracks pending
 * acks per receiver, and marks a receiver slow when its pending count exceeds
 * the threshold or when an ack times out. Slow-consumer policy is driven by
 * the pending counter, not an invisible queue.
 *
 * @param {PowerBroadcastBusOptions} options
 */
export function createBroadcastBus(options) {
  assertKnownOptions(options, ['channel', 'ackTimeoutMs', 'onSlowConsumer'], 'createBroadcastBus');

  const { channel, ackTimeoutMs = 5000, onSlowConsumer } = options;

  if (!channel || typeof channel.postMessage !== 'function') {
    throw new TypeError(
      'createBroadcastBus: `channel` must be a BroadcastChannel with `postMessage`.'
    );
  }

  /** @type {Map<number, PendingAck>} */
  const pending = new Map();

  /** @type {Set<string>} */
  const slowConsumers = new Set();

  /** @type {Map<string, number>} */
  const receiverPendingCount = new Map();

  let _nextSeq = 1;
  let _closed = false;

  function handleMessage(event) {
    if (_closed) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // Handle acks - native envelope
    if (isNativeEnvelope(data)) {
      try {
        const decoded = decodeInbound(data);
        const ackData = decoded && decoded.value;
        if (ackData && ackData.type === 'ack' && ackData.payload) {
          // AUD-020: the shared decoder, not a fresh one per ack.
          const decoder = getAckDecoder();
          if (!decoder) return;
          const ack = JSON.parse(decoder.decode(ackData.payload));
          if (ack && typeof ack.seq === 'number') {
            const entry = pending.get(ack.seq);
            if (entry && entry.receiverId === ack.receiverId) {
              clearTimeout(entry.timer);
              pending.delete(ack.seq);

              const count = (receiverPendingCount.get(entry.receiverId) || 0) - 1;
              if (count <= 0) {
                receiverPendingCount.delete(entry.receiverId);
              } else {
                receiverPendingCount.set(entry.receiverId, count);
              }

              slowConsumers.delete(entry.receiverId);
            }
          }
        }
      } catch {
        // A malformed ack must not abort the message loop; the pending entry's
        // own timer will fire and mark the receiver slow, so dropping it is the
        // safe outcome.
      }
    }
  }

  channel.addEventListener('message', handleMessage);

  return {
    send(sub, frame) {
      if (_closed) return false;

      if (!sub || typeof sub.id !== 'string') {
        throw new TypeError('createBroadcastBus: `sub.id` must be a string.');
      }

      const receiverId = sub.id;

      const seq = _nextSeq++;

      const message = {
        _bc: true,
        seq,
        receiverId,
        frame,
      };

      channel.postMessage(message);

      const timer = setTimeout(() => {
        pending.delete(seq);

        const count = (receiverPendingCount.get(receiverId) || 0) - 1;
        if (count <= 0) {
          receiverPendingCount.delete(receiverId);
        } else {
          receiverPendingCount.set(receiverId, count);
        }

        if (!slowConsumers.has(receiverId)) {
          slowConsumers.add(receiverId);
          if (typeof onSlowConsumer === 'function') {
            onSlowConsumer(receiverId);
          }
        }
      }, ackTimeoutMs);

      pending.set(seq, { seq, receiverId, timer });

      const count = (receiverPendingCount.get(receiverId) || 0) + 1;
      receiverPendingCount.set(receiverId, count);

      return true;
    },

    close(sub) {
      if (_closed) return;

      if (!sub || typeof sub.id !== 'string') return;

      const receiverId = sub.id;

      // AUD-014. Every pending send for this receiver is cleared by the loop
      // below, so the count is zero by the time we get here — and a zero entry is
      // not a state, it is a leftover. This used to `set(receiverId, 0)` when the
      // count was positive, which left the key in the map until the *next*
      // decrement happened to run. For a subscriber that closed while holding
      // pending sends that was never, so the entry outlived the subscriber and
      // the map grew one key per closed subscriber.
      //
      // The count is no longer read at all: both arms of the old branch reached
      // the same conclusion, and reading a value only to discard it is how a
      // second thing to keep correct gets introduced.
      for (const [seq, entry] of pending) {
        if (entry.receiverId === receiverId) {
          clearTimeout(entry.timer);
          pending.delete(seq);
        }
      }
      receiverPendingCount.delete(receiverId);
      slowConsumers.delete(receiverId);
    },

    getSlowConsumerIds() {
      return new Set(slowConsumers);
    },

    /**
     * A snapshot of the per-receiver pending-ack counts.
     *
     * Exists because of AUD-014. `close()` used to write a `0` into
     * `receiverPendingCount` for a receiver whose pending sends it had just
     * cleared, on the reasoning that the count was zero either way — which is
     * true of the *value* and false of the *entry*. A zero entry is not a state,
     * it is a leftover: nothing decrements it, because the timers that would
     * have were cleared, so it survives until the bus is disposed and the map
     * grows one key per closed subscriber.
     *
     * That is a pure retention bug with no behavioural symptom, which makes it
     * invisible to every test written against the public surface — the existing
     * `close` test asserted only `getSlowConsumerIds()` and passed either way.
     * This accessor is the smallest thing that makes the retention observable,
     * and it is the same shape as `getSlowConsumerIds()` for the same reason:
     * "what is the bus still tracking" is a question an operator debugging a leak
     * actually asks.
     *
     * @returns {Map<string, number>} A copy — mutating it does not affect the bus.
     */
    getPendingCounts() {
      return new Map(receiverPendingCount);
    },

    dispose() {
      if (_closed) return;
      _closed = true;
      channel.removeEventListener('message', handleMessage);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      receiverPendingCount.clear();
      slowConsumers.clear();
    },

    [Symbol.dispose]() {
      this.dispose();
    },

    async [Symbol.asyncDispose]() {
      this.dispose();
      return;
    },
  };
}
