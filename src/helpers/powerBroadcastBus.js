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
 * Creates a BroadcastChannel bus with per-frame ack, pending counter with
 * timeout, and slow-consumer detection.
 *
 * The bus assigns a sequence number to every frame it posts, tracks pending
 * acks per receiver, and marks a receiver slow when its pending count exceeds
 * the threshold or when an ack times out. Slow-consumer policy is driven by
 * the pending counter, not an invisible queue.
 *
 * @param {PowerBroadcastBusOptions} options
 * @returns {{ send: (sub: {id: string}, frame: any) => boolean, close: (sub: {id: string}) => void, getSlowConsumerIds: () => Set<string>, dispose: () => void }}
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
          const ack = JSON.parse(new TextDecoder().decode(ackData.payload));
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

      const count = receiverPendingCount.get(receiverId) || 0;
      for (const [seq, entry] of pending) {
        if (entry.receiverId === receiverId) {
          clearTimeout(entry.timer);
          pending.delete(seq);
        }
      }
      if (count <= 0) {
        receiverPendingCount.delete(receiverId);
      } else {
        receiverPendingCount.set(receiverId, 0);
      }
      slowConsumers.delete(receiverId);
    },

    getSlowConsumerIds() {
      return new Set(slowConsumers);
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
  };
}
