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
 */
export function createBroadcastBus(options: PowerBroadcastBusOptions): {
    send(sub: any, frame: any): boolean;
    close(sub: any): void;
    getSlowConsumerIds(): Set<string>;
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
};
export type PowerBroadcastBusOptions = {
    /**
     * - The BroadcastChannel to use.
     */
    channel: BroadcastChannel;
    /**
     * - Timeout in milliseconds for acks.
     */
    ackTimeoutMs?: number | undefined;
    /**
     * - Called when a
     * receiver is marked as slow. The hub passes a callback that sets
     * `sub.slowConsumer = true`; the bus itself never touches subscriber records.
     */
    onSlowConsumer?: ((receiverId: string) => void) | undefined;
};
export type PendingAck = {
    seq: number;
    receiverId: string;
    timer: ReturnType<typeof setTimeout>;
};
